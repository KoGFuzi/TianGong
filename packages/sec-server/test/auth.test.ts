import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	generateEntryPath,
	loadOrCreateEntryPath,
	SEC_SESSION_TTL_MS,
	SEC_TICKET_TTL_MS,
	SecAuth,
	sanitizeEntry,
} from "../src/auth.ts";

const ENTRY = "entrypath1234";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fsp.mkdtemp(join(tmpdir(), "tg-sec-auth-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await fsp.rm(directory, { recursive: true, force: true });
	}
});

describe("SecAuth", () => {
	test("derives the login path and cookie scope from the entry", async () => {
		const auth = await SecAuth.create({ entry: ENTRY });
		expect(auth.entry).toBe(ENTRY);
		expect(auth.entryPrefix).toBe(`/${ENTRY}`);
		expect(auth.loginPath).toBe(`/${ENTRY}/login`);
		expect(auth.sessionCookie("token")).toContain(`Path=/${ENTRY}/`);
		expect(auth.matchesEntryPath(`/${ENTRY}/`)).toBe(true);
		expect(auth.matchesEntryPath(`/${ENTRY}/ws`)).toBe(true);
		expect(auth.matchesEntryPath(`/${ENTRY}x`)).toBe(false);
		expect(auth.stripEntry(`/${ENTRY}/api/graph`)).toBe("/api/graph");
	});

	test("redeems a ticket exactly once", async () => {
		const auth = await SecAuth.create({ entry: ENTRY });
		const { ticket, expiresAt } = auth.issueTicket();
		expect(expiresAt).toBeGreaterThan(Date.now());
		expect(expiresAt).toBeLessThanOrEqual(Date.now() + SEC_TICKET_TTL_MS);

		const token = auth.redeem(ticket);
		expect(token).toBeDefined();
		expect(auth.authorize(`tg_sec_session=${token}`)).toBe(true);
		expect(auth.authorize(`other=value; tg_sec_session=${token}`)).toBe(true);
		expect(auth.authorize(undefined)).toBe(false);
		expect(auth.authorize(`tg_sec_session=`)).toBe(false);

		expect(auth.redeem(ticket)).toBeUndefined();
	});

	test("rejects unknown and expired tickets", async () => {
		let now = 1000;
		const auth = await SecAuth.create({ entry: ENTRY, ticketTtlMs: 100, now: () => now });

		expect(auth.redeem("unknown")).toBeUndefined();

		const { ticket } = auth.issueTicket();
		now = 1099;
		expect(auth.redeem(ticket)).toBeDefined();

		const expired = auth.issueTicket();
		now = 1200;
		expect(auth.redeem(expired.ticket)).toBeUndefined();
	});

	test("expires a session after its TTL", async () => {
		let now = 1000;
		const auth = await SecAuth.create({ entry: ENTRY, sessionTtlMs: 100, now: () => now });
		const token = auth.redeem(auth.issueTicket().ticket);
		expect(token).toBeDefined();

		now = 1099;
		expect(auth.authorize(`tg_sec_session=${token}`)).toBe(true);
		now = 1101;
		expect(auth.authorize(`tg_sec_session=${token}`)).toBe(false);
	});

	test("revokes every ticket and session", async () => {
		const auth = await SecAuth.create({ entry: ENTRY });
		const ticket = auth.issueTicket();
		const token = auth.redeem(auth.issueTicket().ticket);
		auth.revokeAll();

		expect(auth.redeem(ticket.ticket)).toBeUndefined();
		expect(auth.authorize(`tg_sec_session=${token}`)).toBe(false);
	});

	test("clears the cookie with the same scope", async () => {
		const auth = await SecAuth.create({ entry: ENTRY });
		expect(auth.clearCookie()).toContain(`Path=/${ENTRY}/`);
		expect(auth.clearCookie()).toContain("Max-Age=0");
	});
});

describe("entry paths", () => {
	test("generates an unambiguous twelve-character entry", () => {
		for (let index = 0; index < 20; index += 1) {
			const entry = generateEntryPath();
			expect(entry).toHaveLength(12);
			expect(entry).toMatch(/^[a-km-np-z2-9A-HJ-NP-Z]+$/);
		}
	});

	test("sanitizes operator input, keeping the first line only", () => {
		expect(sanitizeEntry("  ab-cd_12\nignored")).toBe("abcd12");
		expect(sanitizeEntry("abc")).toBeUndefined();
		expect(sanitizeEntry("   ")).toBeUndefined();
	});

	test("persists the entry at mode 0600 and reuses it", async () => {
		const directory = await temporaryDirectory();
		const first = await loadOrCreateEntryPath(directory);
		expect(first).toHaveLength(12);

		const path = join(directory, "sec-server-entry");
		const stored = (await fsp.readFile(path, "utf8")).trim();
		expect(stored).toBe(first);
		expect((await fsp.stat(path)).mode & 0o777).toBe(0o600);

		expect(await loadOrCreateEntryPath(directory)).toBe(first);
	});

	test("replaces an unusable stored entry", async () => {
		const directory = await temporaryDirectory();
		await fsp.writeFile(join(directory, "sec-server-entry"), "bad", { mode: 0o600 });
		const entry = await loadOrCreateEntryPath(directory);
		expect(entry).not.toBe("bad");
		expect(await loadOrCreateEntryPath(directory)).toBe(entry);
	});

	test("defaults the session lifetime to twelve hours", () => {
		expect(SEC_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
		expect(SEC_TICKET_TTL_MS).toBe(5 * 60 * 1000);
	});
});
