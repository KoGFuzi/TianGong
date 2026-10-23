import { join } from "node:path";
import { safeProjectSegment, tgSecDataDir } from "../config.ts";

/**
 * The evidence subtree for one campaign project, deliberately **separate from the session database**.
 * Bodies and their metadata index live here, never inside `session.sqlite`, so a campaign's transcript
 * and its forensic evidence have independent lifetimes, backups, and garbage collection.
 */
export function evidenceDir(project: string, dataDir: string = tgSecDataDir()): string {
	return join(dataDir, "projects", safeProjectSegment(project), "evidence");
}

/** The metadata index — its own SQLite file, independent of the session store. */
export function evidenceIndexPath(dir: string): string {
	return join(dir, "evidence.sqlite");
}

/** Root of the content-addressed blob tree. */
export function blobsRoot(dir: string): string {
	return join(dir, "blobs");
}

/** The durable location for one content hash: `blobs/<hash[0:2]>/<hash>.bin`. */
export function blobPath(dir: string, hash: string): string {
	return join(blobsRoot(dir), hash.slice(0, 2), `${hash}.bin`);
}

/** Where a body is written and hashed before it is renamed into place. */
export function stagingDir(dir: string): string {
	return join(dir, ".staging");
}
