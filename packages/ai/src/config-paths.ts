import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Directory name under each XDG root.
 *
 * Follows the `opencode` convention: one product directory per XDG root, holding only what that root
 * is for. TianGong therefore spans the standard Base Directory roots, not only config.
 */
export const TIANGONG_DIR = "TianGong";

/** Environment variables that override the TianGong directory inside each XDG root. */
export const TIANGONG_DATA_DIR = "TIANGONG_DATA_DIR";
export const TIANGONG_CONFIG_DIR = "TIANGONG_CONFIG_DIR";
export const TIANGONG_STATE_DIR = "TIANGONG_STATE_DIR";
export const TIANGONG_CACHE_DIR = "TIANGONG_CACHE_DIR";

type Root = "data" | "config" | "state" | "cache";

const XDG_VARIABLES: Record<Root, string> = {
	data: "XDG_DATA_HOME",
	config: "XDG_CONFIG_HOME",
	state: "XDG_STATE_HOME",
	cache: "XDG_CACHE_HOME",
};

const XDG_FALLBACKS: Record<Root, string> = {
	data: ".local/share",
	config: ".config",
	state: ".local/state",
	cache: ".cache",
};

const OVERRIDE_VARIABLES: Record<Root, string> = {
	data: TIANGONG_DATA_DIR,
	config: TIANGONG_CONFIG_DIR,
	state: TIANGONG_STATE_DIR,
	cache: TIANGONG_CACHE_DIR,
};

/**
 * Resolves one XDG root, then the product directory inside it.
 *
 * `$XDG_*_HOME` wins when set. `$TIANGONG_*_DIR` wins over it and is interpreted as a full absolute
 * directory for that root, which is what an embedded or test process needs to relocate everything at
 * once. A relative override is rejected by the caller that uses it: writing storage next to the
 * current working directory by accident is worse than failing fast.
 */
function base(root: Root): string {
	const override = process.env[OVERRIDE_VARIABLES[root]];
	if (override !== undefined && override.length > 0 && isAbsolute(override)) return join(override, TIANGONG_DIR);
	const xdg = process.env[XDG_VARIABLES[root]];
	if (xdg && xdg.length > 0 && !xdg.endsWith("/")) return join(xdg, TIANGONG_DIR);
	if (xdg?.endsWith("/")) return join(xdg.slice(0, -1), TIANGONG_DIR);
	return join(homedir(), XDG_FALLBACKS[root], TIANGONG_DIR);
}

/** Absolute path of the TianGong directory inside one XDG root. */
export function tiangongDir(root: Root): string {
	return base(root);
}

/** Absolute path inside the TianGong directory of one XDG root. */
export function tiangongPathOf(root: Root, ...segments: string[]): string {
	return join(base(root), ...segments);
}

/** `~/.config/TianGong`, or `$XDG_CONFIG_HOME/TianGong`. Holds user-authored settings. */
export function tiangongConfigDir(): string {
	return base("config");
}
export function tiangongConfigPath(...segments: string[]): string {
	return tiangongPathOf("config", ...segments);
}

/**
 * `~/.local/share/TianGong`, or `$XDG_DATA_HOME/TianGong`.
 *
 * Holds machine-generated state: credentials, the session database, snapshots, logs. This is where
 * `auth.json` belongs, matching how `opencode` resolves its own `auth.json` against the data root.
 */
export function tiangongDataDir(): string {
	return base("data");
}
export function tiangongDataPath(...segments: string[]): string {
	return tiangongPathOf("data", ...segments);
}

/** `~/.local/state/TianGong`; locks and other state that must not survive a log rotation. */
export function tiangongStateDir(): string {
	return base("state");
}
export function tiangongStatePath(...segments: string[]): string {
	return tiangongPathOf("state", ...segments);
}

/** `~/.cache/TianGong`; disposable, and safe to delete while nothing is running. */
export function tiangongCacheDir(): string {
	return base("cache");
}
export function tiangongCachePath(...segments: string[]): string {
	return tiangongPathOf("cache", ...segments);
}

/** File name of the default session database inside the data directory. */
export const TIANGONG_SESSION_DB = "session.sqlite";

/**
 * Default session database: `~/.local/share/TianGong/session.sqlite`.
 *
 * `$TIANGONG_SESSION_DB` overrides the file name, `$TIANGONG_DATA_DIR` moves the whole data root.
 */
export function tiangongSessionDbPath(): string {
	const name = process.env.TIANGONG_SESSION_DB;
	return tiangongDataPath(name && name.length > 0 ? name : TIANGONG_SESSION_DB);
}
