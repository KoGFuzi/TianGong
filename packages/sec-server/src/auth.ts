import { createHash, randomBytes, randomInt } from "node:crypto";
import fsp from "node:fs/promises";
import { join } from "node:path";

const ENTRY_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ENTRY_LENGTH = 12;
const ENTRY_FILE = "sec-server-entry";
const SESSION_COOKIE = "tg_sec_session";
const MAX_TICKETS = 64;
const MAX_SESSIONS = 256;

export const SEC_TICKET_TTL_MS = 5 * 60 * 1000;
export const SEC_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** A ticket handed to the operator once; redeeming it mints the session cookie. */
export type SecIssuedTicket = {
	readonly ticket: string;
	readonly expiresAt: number;
};

export type SecAuthOptions = {
	/** Fix the entry path (tests); otherwise it is loaded from `dataDir` or generated per process. */
	readonly entry?: string;
	/** Where the entry path is persisted with mode 0600. */
	readonly dataDir?: string;
	readonly ticketTtlMs?: number;
	readonly sessionTtlMs?: number;
	readonly now?: () => number;
};

/** Generate an entry path from the unambiguous alphabet. */
export function generateEntryPath(): string {
	let out = "";
	for (let index = 0; index < ENTRY_LENGTH; index += 1) out += ENTRY_ALPHABET[randomInt(ENTRY_ALPHABET.length)];
	return out;
}

/** Load the persisted entry, creating it atomically with mode 0600 when absent. */
export async function loadOrCreateEntryPath(dataDir: string): Promise<string> {
	const path = join(dataDir, ENTRY_FILE);
	try {
		const stored = sanitizeEntry(await fsp.readFile(path, "utf8"));
		if (stored !== undefined) return stored;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const entry = generateEntryPath();
	await fsp.mkdir(dataDir, { recursive: true });
	const temp = `${path}.tmp`;
	await fsp.writeFile(temp, `${entry}\n`, { mode: 0o600 });
	await fsp.chmod(temp, 0o600);
	await fsp.rename(temp, path);
	await fsp.chmod(path, 0o600);
	return entry;
}

export function sanitizeEntry(value: string): string | undefined {
	const clean = value
		.trim()
		.split(/\r?\n/u)[0]!
		.replace(/[^A-Za-z0-9]/gu, "")
		.slice(0, 32);
	return clean.length >= 4 ? clean : undefined;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * The WebUI gate: an unguessable entry path, a one-time login ticket with a short TTL, and an
 * HttpOnly session cookie scoped to that path. Tickets and sessions are stored as SHA-256 digests,
 * so the map never holds a usable bearer value and lookups never compare the secret itself.
 */
export class SecAuth {
	readonly entry: string;
	readonly entryPrefix: string;
	readonly loginPath: string;
	readonly cookieName = SESSION_COOKIE;
	private readonly ticketTtlMs: number;
	private readonly sessionTtlMs: number;
	private readonly now: () => number;
	private readonly tickets = new Map<string, number>();
	private readonly sessions = new Map<string, number>();

	private constructor(options: SecAuthOptions, entry: string) {
		this.entry = entry;
		this.entryPrefix = `/${entry}`;
		this.loginPath = `${this.entryPrefix}/login`;
		this.ticketTtlMs = options.ticketTtlMs ?? SEC_TICKET_TTL_MS;
		this.sessionTtlMs = options.sessionTtlMs ?? SEC_SESSION_TTL_MS;
		this.now = options.now ?? (() => Date.now());
	}

	static async create(options: SecAuthOptions = {}): Promise<SecAuth> {
		const entry =
			options.entry !== undefined
				? (sanitizeEntry(options.entry) ?? generateEntryPath())
				: options.dataDir === undefined
					? generateEntryPath()
					: await loadOrCreateEntryPath(options.dataDir);
		return new SecAuth(options, entry);
	}

	issueTicket(): SecIssuedTicket {
		this.sweep();
		const ticket = randomBytes(24).toString("base64url");
		const expiresAt = this.now() + this.ticketTtlMs;
		this.tickets.set(digest(ticket), expiresAt);
		trim(this.tickets, MAX_TICKETS);
		return { ticket, expiresAt };
	}

	/** Redeem a ticket exactly once; returns the session token to place in the cookie. */
	redeem(ticket: string): string | undefined {
		this.sweep();
		const key = digest(ticket);
		const expiresAt = this.tickets.get(key);
		if (expiresAt === undefined || expiresAt <= this.now()) return undefined;
		this.tickets.delete(key);
		const token = randomBytes(24).toString("base64url");
		this.sessions.set(digest(token), this.now() + this.sessionTtlMs);
		trim(this.sessions, MAX_SESSIONS);
		return token;
	}

	authorize(cookieHeader: string | undefined): boolean {
		const token = cookieValue(cookieHeader, this.cookieName);
		if (token === undefined) return false;
		const expiresAt = this.sessions.get(digest(token));
		if (expiresAt === undefined) return false;
		if (expiresAt <= this.now()) {
			this.sessions.delete(digest(token));
			return false;
		}
		return true;
	}

	sessionCookie(token: string): string {
		const maxAge = Math.floor(this.sessionTtlMs / 1000);
		return `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${this.entryPrefix}/; Max-Age=${maxAge}`;
	}

	clearCookie(): string {
		return `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=${this.entryPrefix}/; Max-Age=0`;
	}

	matchesEntryPath(pathname: string): boolean {
		return pathname === this.entryPrefix || pathname.startsWith(`${this.entryPrefix}/`);
	}

	/** Strip the entry prefix; the login path stays recognizable because it is checked first. */
	stripEntry(pathname: string): string {
		if (pathname === this.entryPrefix) return "/";
		if (!pathname.startsWith(`${this.entryPrefix}/`)) return pathname;
		const rest = pathname.slice(this.entryPrefix.length);
		return rest === "" ? "/" : rest;
	}

	revokeAll(): void {
		this.tickets.clear();
		this.sessions.clear();
	}

	private sweep(): void {
		const now = this.now();
		for (const [key, expiresAt] of this.tickets) if (expiresAt <= now) this.tickets.delete(key);
		for (const [key, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(key);
	}
}

function trim(map: Map<string, number>, limit: number): void {
	while (map.size > limit) {
		const oldest = map.keys().next();
		if (oldest.done === true) return;
		map.delete(oldest.value);
	}
}

function cookieValue(header: string | undefined, name: string): string | undefined {
	if (header === undefined) return undefined;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		const value = part.slice(separator + 1).trim();
		return value === "" ? undefined : value;
	}
	return undefined;
}
