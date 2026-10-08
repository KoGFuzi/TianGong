import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { OAuthCredential } from "../src/auth/types.ts";
import { FileCredentialStore } from "../src/auth-node.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];

/**
 * Run one child and return its stdout. `promisify` is required explicitly: `node:child_process`'s
 * `execFile` returns a ChildProcess, and the callback form never surfaces the captured output
 * through the awaited value.
 */
async function runChild(script: string): Promise<string> {
	const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", script], {
		cwd: packageRoot,
		encoding: "utf8",
	});
	return stdout;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function credentialFile(): { root: string; path: string; store: FileCredentialStore } {
	const root = mkdtempSync(join(tmpdir(), "tg-credential-store-"));
	roots.push(root);
	const path = join(root, "nested", "auth.json");
	return { path, root, store: new FileCredentialStore({ path }) };
}

function oauth(access: string, expires = Number.MAX_SAFE_INTEGER): OAuthCredential {
	return { type: "oauth", refresh: `refresh-${access}`, access, expires };
}

describe("FileCredentialStore", () => {
	it("resolves undefined for a provider that has no file yet", async () => {
		const { path, store } = credentialFile();
		expect(await store.read("anthropic")).toBeUndefined();
		expect(await store.list()).toEqual([]);
		expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
	});

	it("round-trips an api-key credential including provider env", async () => {
		const { store } = credentialFile();
		await store.modify("cloudflare", async () => ({
			type: "api_key",
			key: "cf-secret",
			env: { CLOUDFLARE_ACCOUNT_ID: "acct-1" },
		}));

		expect(await store.read("cloudflare")).toEqual({
			type: "api_key",
			key: "cf-secret",
			env: { CLOUDFLARE_ACCOUNT_ID: "acct-1" },
		});
		expect(await store.list()).toEqual([{ providerId: "cloudflare", type: "api_key" }]);
	});

	it("stores an oauth credential in the documented auth.json shape", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			anthropic: {
				type: "oauth",
				refresh: "refresh-access-1",
				access: "access-1",
				expires: Number.MAX_SAFE_INTEGER,
			},
		});
	});

	it("keeps every provider when one is modified", async () => {
		const { store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));
		await store.modify("openai", async () => oauth("access-2"));
		await store.modify("anthropic", async () => oauth("access-3"));

		expect((await store.read("anthropic"))?.type).toBe("oauth");
		expect((await store.read("openai"))?.type).toBe("oauth");
		expect((await store.list()).map((entry) => entry.providerId).sort()).toEqual(["anthropic", "openai"]);
	});

	it("leaves the entry untouched when fn returns undefined", async () => {
		const { store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));

		const seen = await store.modify("anthropic", async (current) => {
			expect(current?.type).toBe("oauth");
			return undefined;
		});

		expect(seen).toEqual(oauth("access-1"));
		expect(await store.read("anthropic")).toEqual(oauth("access-1"));
	});

	it("gives fn the credential currently on disk, not a cached view", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("stale"));

		// Simulate another process rotating the credential after this store instance was created.
		writeFileSync(path, JSON.stringify({ anthropic: oauth("rotated") }));

		const observed = await store.modify("anthropic", async (current) => {
			expect((current as OAuthCredential).access).toBe("rotated");
			return oauth("rotated-again");
		});

		expect((observed as OAuthCredential).access).toBe("rotated-again");
	});

	it("serializes concurrent modifies of the same provider", async () => {
		const { store } = credentialFile();
		const order: string[] = [];
		await Promise.all([
			store.modify("anthropic", async () => {
				order.push("first:start");
				await new Promise((resolve) => setTimeout(resolve, 20));
				order.push("first:end");
				return oauth("a");
			}),
			store.modify("anthropic", async (current) => {
				order.push(`second:start:${(current as OAuthCredential | undefined)?.access ?? "none"}`);
				return oauth("b");
			}),
		]);

		expect(order).toEqual(["first:start", "first:end", "second:start:a"]);
		expect((await store.read("anthropic")) as OAuthCredential).toEqual(oauth("b"));
	});

	it("ignores entries it does not recognize but preserves them on write", async () => {
		const { path, root, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));

		// An entry from a newer build must survive a write by this one.
		const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		record["future-provider"] = { type: "keychain", opaque: { nested: true } };
		writeFileSync(path, JSON.stringify(record));

		await store.modify("anthropic", async () => oauth("access-2"));

		expect(await store.read("future-provider")).toBeUndefined();
		expect(JSON.parse(readFileSync(path, "utf8"))["future-provider"]).toEqual({
			type: "keychain",
			opaque: { nested: true },
		});
		expect(root).toContain("tg-credential-store-");
	});

	it("drops a malformed entry from list() without dropping its data", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));

		const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		record.broken = { type: "oauth" };
		writeFileSync(path, JSON.stringify(record));

		expect(await store.list()).toEqual([{ providerId: "anthropic", type: "oauth" }]);
		expect(await store.read("broken")).toBeUndefined();

		await store.modify("anthropic", async () => oauth("access-2"));
		expect(JSON.parse(readFileSync(path, "utf8")).broken).toEqual({ type: "oauth" });
	});

	it("rejects when the credential file is not a JSON object", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));
		writeFileSync(path, "[]");

		await expect(store.read("anthropic")).rejects.toThrow(/not a JSON object/);
	});

	it("rejects when the credential file is not JSON at all", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));
		writeFileSync(path, "{ truncated");

		await expect(store.list()).rejects.toThrow();
	});

	it("removes one provider without disturbing the others", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));
		await store.modify("openai", async () => oauth("access-2"));

		await store.delete("anthropic");

		expect(await store.read("anthropic")).toBeUndefined();
		expect(await store.read("openai")).toEqual(oauth("access-2"));
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual(["openai"]);
	});

	it("removes the file once the last credential is deleted", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));
		await store.delete("anthropic");

		expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
	});

	it("ignores delete for a provider that was never stored", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));
		await store.delete("openai");

		expect(await store.read("anthropic")).toEqual(oauth("access-1"));
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual(["anthropic"]);
	});

	it("creates the file mode 0600 inside a 0700 directory", async () => {
		const { path, root, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));

		const directory = join(root, "nested");
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("re-tightens permissions on an existing loose file", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));
		chmodSync(path, 0o644);

		await store.modify("anthropic", async () => oauth("access-2"));

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("does not persist anything when fn rejects", async () => {
		const { path, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));

		await expect(
			store.modify("anthropic", async () => {
				throw new Error("refresh failed");
			}),
		).rejects.toThrow("refresh failed");

		expect(JSON.parse(readFileSync(path, "utf8")).anthropic).toEqual(oauth("access-1"));
	});

	it("leaves no temporary file behind after a successful write", async () => {
		const { root, store } = credentialFile();
		await store.modify("anthropic", async () => oauth("access-1"));

		expect(readdirSync(join(root, "nested")).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
	});

	it("excludes a provider whose entry is present but unreadable as a credential", async () => {
		const { store } = credentialFile();
		await store.modify("anthropic", async () => ({ type: "api_key" }));

		expect(await store.read("anthropic")).toEqual({ type: "api_key" });
		expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
	});

	it("excludes concurrent modifies across processes from reading the same stale credential", async () => {
		// Runs the store in real child processes: the file lock is what makes this hold, and an
		// in-process test cannot observe it. Each child performs the same read-refresh-write cycle
		// that `resolveProviderAuth` performs on an expiring OAuth token; without cross-process
		// exclusion every child would read "none" and rotate the same refresh token.
		const root = mkdtempSync(join(tmpdir(), "tg-credential-xproc-"));
		roots.push(root);
		const path = join(root, "auth.json");
		const script = join(root, "worker.ts");
		// A relative import keeps the child on this package's TypeScript sources; Node resolves it
		// from the script's own location, so the temp directory needs no node_modules of its own.
		writeFileSync(
			script,
			`import { FileCredentialStore } from ${JSON.stringify(fileURLToPath(new URL("../src/auth-node.ts", import.meta.url)))};
const store = new FileCredentialStore({ path: ${JSON.stringify(path)} });
const seen: string[] = [];
for (let i = 0; i < 4; i++) {
	await store.modify("anthropic", async (current) => {
		const access = (current as { access?: string } | undefined)?.access ?? "none";
		seen.push(access);
		await new Promise((resolve) => setTimeout(resolve, 15));
		return { type: "oauth", refresh: "r", access: \`a-\${seen.length}-\${process.pid}\`, expires: Date.now() + 3_600_000 };
	});
}
process.stdout.write(JSON.stringify(seen));`,
			"utf8",
		);

		const sequences = (await Promise.all([0, 1, 2, 3].map(() => runChild(script)))).map(
			(stdout) => JSON.parse(stdout) as string[],
		);

		// Serialized execution means each child observes the previous child's write, so no two
		// children can see "none" or the same token.
		for (const sequence of sequences) {
			expect(sequence).toHaveLength(4);
			expect(new Set(sequence).size).toBe(4);
		}
		const observed = sequences.flat();
		expect(observed.filter((access) => access === "none")).toHaveLength(1);
	});
});
