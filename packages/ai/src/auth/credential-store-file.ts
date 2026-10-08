import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { tiangongAuthFilePath } from "../config-paths.ts";
import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "./types.ts";

/**
 * On-disk credential file, keyed by `Provider.id`. This is the shape `auth.json` already has, so the
 * dev CLI's file and this store read and write the same document.
 */
type CredentialRecord = Record<string, unknown>;

/**
 * A credential this package understands. Entries that do not match are still carried through
 * read-modify-write verbatim, so a file written by a newer or forked build is never silently
 * destroyed by an older one.
 */
function asCredential(value: unknown): Credential | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.type === "api_key") {
		const key = typeof record.key === "string" ? { key: record.key } : {};
		return isEnv(record.env) ? { type: "api_key", ...key, env: record.env } : { type: "api_key", ...key };
	}
	if (record.type === "oauth") {
		if (typeof record.refresh !== "string" || typeof record.access !== "string") return undefined;
		if (typeof record.expires !== "number" || !Number.isFinite(record.expires)) return undefined;
		return { ...record, type: "oauth" } as Credential;
	}
	return undefined;
}

function isEnv(value: unknown): value is ProviderEnv {
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function isNotFound(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === "ENOENT";
}

/**
 * Lock staleness budget. `Models` bounds an OAuth refresh at fifteen seconds, so a lock held across
 * `modify` legitimately outlives proper-lockfile's ten-second default; treat the lock as stale only
 * after three refresh windows. The heartbeat runs at half this interval.
 */
const LOCK_STALE_MS = 60_000;

/**
 * Wait budget for the file lock. One long refresh can hold the lock for about fifteen seconds, so
 * allow a fixed half-minute before reporting a storage failure.
 */
const LOCK_RETRIES = { retries: 60, minTimeout: 500, maxTimeout: 500, factor: 1 } as const;

export interface FileCredentialStoreOptions {
	/** Credential file. Defaults to `~/.local/share/TianGong/auth.json`. */
	path?: string;
}

/**
 * `CredentialStore` backed by one JSON file.
 *
 * Two properties separate this from `InMemoryCredentialStore`:
 *
 * - **Cross-process exclusion.** `modify` holds a file lock across the whole read-decide-write
 *   sequence, which is what makes the double-checked OAuth refresh in `resolveProviderAuth`
 *   actually exclude: the second caller re-reads the rotated credential from disk after acquiring
 *   the lock and sees that it no longer needs refreshing.
 * - **Crash-safe commits.** Every write goes to a temporary file in the same directory and is then
 *   renamed, so an interrupted process leaves the previous file intact rather than a truncated one.
 *
 * The file is created mode `0600` inside a `0700` directory, because it holds provider API keys and
 * OAuth tokens in the clear.
 */
export class FileCredentialStore implements CredentialStore {
	readonly #path: string;
	readonly #chains = new Map<string, Promise<unknown>>();

	constructor(options: FileCredentialStoreOptions = {}) {
		this.#path = options.path ?? tiangongAuthFilePath();
	}

	/** Absolute path of the credential file this store reads and writes. */
	get path(): string {
		return this.#path;
	}

	/**
	 * Serialize per provider id so two store instances in one process cannot interleave. The file
	 * lock covers everything else; without this, same-process callers would queue on the file lock
	 * while each holding an in-flight `fn`.
	 */
	#enqueue<T>(providerId: string, task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const signal = operationSignal(options?.signal);
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			return task();
		})();
		const tail = queued.catch(() => {});
		this.#chains.set(providerId, tail);
		void tail.then(() => {
			if (this.#chains.get(providerId) === tail) this.#chains.delete(providerId);
		});
		return raceWithAbortSignal(queued, signal);
	}

	async #readRecord(): Promise<CredentialRecord> {
		let text: string;
		try {
			text = await readFile(this.#path, "utf8");
		} catch (error) {
			if (isNotFound(error)) return {};
			throw error;
		}
		if (text.trim().length === 0) return {};
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`Credential file ${this.#path} is not a JSON object`);
		}
		return parsed as CredentialRecord;
	}

	async #writeRecord(record: CredentialRecord): Promise<void> {
		await mkdir(dirname(this.#path), { mode: 0o700, recursive: true });
		const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporaryPath, this.#path);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => {});
			throw error;
		}
	}

	/** Run `body` while holding the file lock, releasing it on every exit path. */
	async #withLock<T>(body: () => Promise<T>): Promise<T> {
		// proper-lockfile locks `<file>.lock`, so the parent directory has to exist before it can
		// create that entry. Without this, first login on a fresh machine fails with ENOENT.
		await mkdir(dirname(this.#path), { mode: 0o700, recursive: true });
		let compromised: Error | undefined;
		const release = await lockfile.lock(this.#path, {
			// The credential file may not exist yet; the path is already absolute, so canonicalizing
			// symlinks buys nothing and would make first login fail.
			realpath: false,
			stale: LOCK_STALE_MS,
			retries: LOCK_RETRIES,
			onCompromised: (error) => {
				compromised = error;
			},
		});
		let result: T;
		try {
			result = await body();
		} catch (error) {
			await release();
			throw error;
		}
		// A compromised lock means another process took over. Surface it as a storage failure
		// rather than returning a result produced against an invariant that no longer holds.
		if (compromised) {
			await release();
			throw compromised;
		}
		await release();
		return result;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const signal = operationSignal(options?.signal);
		return raceWithAbortSignal(
			(async () => {
				signal.throwIfAborted();
				return asCredential((await this.#readRecord())[providerId]);
			})(),
			signal,
		);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const signal = operationSignal(options?.signal);
		return raceWithAbortSignal(
			(async () => {
				signal.throwIfAborted();
				// Reads the file only: no provider auth is resolved, so no configured api-key
				// command can run while enumerating.
				const record = await this.#readRecord();
				const info: CredentialInfo[] = [];
				for (const [providerId, value] of Object.entries(record)) {
					const credential = asCredential(value);
					if (credential) info.push({ providerId, type: credential.type });
				}
				return info;
			})(),
			signal,
		);
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#enqueue(providerId, () => this.#modify(providerId, fn, options), options);
	}

	async #modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const signal = operationSignal(options?.signal);
		return this.#withLock(async () => {
			// Read under the lock: the caller's decision may depend on a credential another process
			// rotated while this request was in flight.
			const record = await this.#readRecord();
			const current = asCredential(record[providerId]);
			const next = await fn(current);
			if (next === undefined) return current;
			signal.throwIfAborted();
			record[providerId] = next;
			// Write before honoring an abort past this point. A rotated refresh token must land on
			// disk even if the request is cancelled, because the previous one may already be invalid.
			await this.#writeRecord(record);
			return next;
		});
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#enqueue(providerId, () => this.#delete(providerId, options), options);
	}

	async #delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		const signal = operationSignal(options?.signal);
		await this.#withLock(async () => {
			const record = await this.#readRecord();
			if (!(providerId in record)) return;
			delete record[providerId];
			signal.throwIfAborted();
			// Remove the file once the last credential is gone rather than leaving an empty object.
			if (Object.keys(record).length === 0) await rm(this.#path, { force: true });
			else await this.#writeRecord(record);
		});
	}
}
