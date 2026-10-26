import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROJECT_SAFE = /[^A-Za-z0-9._-]/g;

/**
 * The XDG data root for sec-agent state. Machine-generated session state lives under the data
 * directory, never the config directory: write and read resolve to the same path here, so the
 * config-vs-data split that lost transcripts in the old bridge cannot recur.
 */
export function tgSecDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.TG_SEC_DATA_DIR;
	if (override !== undefined && override !== "") return override;
	const xdgData = env.XDG_DATA_HOME;
	const base = xdgData !== undefined && xdgData !== "" ? xdgData : join(homedir(), ".local", "share");
	return join(base, "TianGong", "sec-agent");
}

/**
 * One campaign project mapped onto one safe single path segment. A name that is not already a plain
 * segment is reduced by replacing every unsafe character with `-`; `.` and `..` are rejected rather
 * than folded, because they would escape the `projects/` directory they are joined into.
 */
export function safeProjectSegment(project: string): string {
	if (project.trim() === "") throw new TypeError("a campaign project name must not be empty");
	const safe = project.replace(PROJECT_SAFE, "-");
	if (safe === "." || safe === "..")
		throw new TypeError(`project name ${JSON.stringify(project)} is not a path segment`);
	return safe;
}

/**
 * The database file for one campaign project: one file per project.
 *
 * A single SQLite file cannot host two projects through the reserved root conversation: record IDs
 * are claimed globally per table, and every project's root is the reserved ID 1, so the second
 * project's root creation fails with `ID 1 already belongs to conversation`. The project column
 * still tags every row, and every read is filtered by it, as `openNodeSqliteStorage` documents.
 */
export function projectDatabasePath(project: string, dataDir: string = tgSecDataDir()): string {
	return join(dataDir, "projects", safeProjectSegment(project), "session.sqlite");
}

/**
 * The database a `--faux` shell writes to. A local echo run is a test of the screen and the guard,
 * not campaign work: keeping it in its own file means its turns can never become context for a real
 * model in the campaign conversation.
 */
export function fauxDatabasePath(project: string, dataDir: string = tgSecDataDir()): string {
	return join(dataDir, "faux", "projects", safeProjectSegment(project), "session.sqlite");
}

/** Create the parent directory of a database path; opening SQLite does not mkdir for us. */
export async function ensureDatabaseDirectory(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
}
