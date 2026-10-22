import {
	hasForcedRecursiveFlags,
	nonFlagTargets,
	scanTextSurface,
	type TgSecCommandGroup,
	type TgSecTextSurface,
} from "./command-text.ts";
import {
	TG_SEC_OBJECTIVES,
	type TgSecDangerEvaluator,
	type TgSecDangerHit,
	type TgSecDangerRuleId,
	type TgSecObjective,
	type TgSecRequest,
} from "./types.ts";

/** Every objective: the rules no track may turn off. */
const ALL_OBJECTIVES: readonly TgSecObjective[] = TG_SEC_OBJECTIVES;
/** The real-target tracks. CTF is exempt from the business guardrails: its targets are fixtures. */
const REAL_TARGET_OBJECTIVES: readonly TgSecObjective[] = ["redteam", "src"];
/** The CTF track alone. */
const CTF_OBJECTIVES: readonly TgSecObjective[] = ["ctf"];

/**
 * One compiled danger rule: a closed id (the span `rule` vocabulary), a human-readable reason, the
 * tracks it is armed on, and its matcher over the text-scan view. The matcher also sees the tool
 * name — not the argument tree — because "the write tool targets this path" is a command shape, and
 * the tool name is not part of either view.
 */
type DangerRule = {
	readonly id: TgSecDangerRuleId;
	readonly reason: string;
	readonly objectives: readonly TgSecObjective[];
	readonly match: (view: TgSecTextSurface, toolName: string) => boolean;
};

/** True when any string value of the request — `detail` keys included — matches one of the patterns. */
function anyText(view: TgSecTextSurface, patterns: readonly RegExp[]): boolean {
	return view.strings.some((value) => {
		const lowered = value.toLowerCase();
		return patterns.some((pattern) => pattern.test(lowered));
	});
}

/** True when the tool is a file-writing tool, whose `file_path`/`path` value is itself the target. */
function isWriteTool(toolName: string): boolean {
	return toolName === "write" || toolName === "edit" || toolName === "multiedit" || toolName === "patch";
}

/**
 * The **target-destructive** SQL family (all objectives, CTF not exempt). Every pattern demands the
 * destructive verb, never a bare `FROM`, `TABLE`, or `SET`, so reads stay out by construction:
 * `SELECT ... FROM`, `SHOW TABLES`, `DESCRIBE`, `EXPLAIN`, `USE db` and a read-only `find()` match
 * nothing here, and each id carries a near-miss negative in the test suite. Patterns are lowercase
 * because `anyText` lowercases before matching.
 */
const SQL_DESTRUCTIVE: readonly (readonly [TgSecDangerRuleId, RegExp[], string])[] = [
	[
		"danger.sql.drop-table",
		[/\bdrop\s+(?:table|temp(?:orary)?\s+table)s?\b/],
		"a DROP TABLE destroys target table data",
	],
	[
		"danger.sql.drop-database",
		[/\bdrop\s+(?:database|schema)s?\b/],
		"a DROP DATABASE destroys the whole target database",
	],
	["danger.sql.truncate", [/\btruncate\s+(?:table\s+)?[`"']?[\w.$-]+/], "a TRUNCATE empties a target table in place"],
	["danger.sql.delete-from", [/\bdelete\s+from\b/], "a DELETE FROM removes target rows"],
	[
		"danger.sql.alter-drop",
		[/\balter\b[\s\S]*\bdrop\s+(?:table|database|schema|column|index|constraint|partition|user)\b/],
		"an ALTER ... DROP removes a target object",
	],
	[
		"danger.sql.update-set",
		[/\bupdate\s+[`"'[\w.$-]+\s+set\s+[`"'[\w.$-]+\s*=/],
		"an UPDATE ... SET rewrites target rows",
	],
	["danger.sql.insert-into", [/\binsert\s+into\b/], "an INSERT INTO writes target rows"],
	["danger.sql.replace-into", [/\breplace\s+into\b/], "a REPLACE INTO overwrites target rows"],
	[
		"danger.sql.load-data-infile",
		[/\bload\s+data\s+(?:local\s+)?infile\b/, /\bload\s+data\b[\s\S]{0,40}\binfile\b/],
		"LOAD DATA INFILE moves a server file into a target table",
	],
	["danger.sql.into-outfile", [/\binto\s+outfile\b/], "SELECT ... INTO OUTFILE writes a file on the target"],
	["danger.sql.into-dumpfile", [/\binto\s+dumpfile\b/], "SELECT ... INTO DUMPFILE writes a raw file on the target"],
];

/**
 * The **target-destructive** tool-flag and protocol-command half (all objectives, CTF not exempt):
 * sqlmap's shell and file-write switches, destructive web action parameters, the Redis flushes, and
 * the Mongo database drop. These are payload shapes, not shell commands, so they match text —
 * a `--os-shell` inside a command and one inside a POST body are equally the instruction to destroy.
 */
const TOOL_DESTRUCTIVE: readonly (readonly [TgSecDangerRuleId, RegExp[], string])[] = [
	["danger.tool.sqlmap-os-shell", [/--os-shell\b/], "sqlmap --os-shell opens an interactive shell on the target host"],
	["danger.tool.sqlmap-os-cmd", [/--os-cmd\b/], "sqlmap --os-cmd runs a command on the target host"],
	["danger.tool.sqlmap-file-write", [/--file-write\b/], "sqlmap --file-write writes a file onto the target host"],
	[
		"danger.tool.sqlmap-sql-shell",
		[/--sql-shell\b/],
		"sqlmap --sql-shell opens an interactive SQL shell on the target",
	],
	[
		"danger.web.action-destroy",
		[
			/\baction\s*=\s*["']?(?:delete|destroy|drop|remove|purge|truncate)\b/,
			/\b(?:do|op|method|func|route)\s*=\s*["']?(?:delete|destroy|drop)\b/,
		],
		"a web request carries a destructive action parameter",
	],
	["danger.redis.flushall", [/\bflushall\b/], "Redis FLUSHALL wipes every key on the target"],
	["danger.redis.flushdb", [/\bflushdb\b/], "Redis FLUSHDB wipes the current target keyspace"],
	["danger.mongo.drop-database", [/\bdrop\s*database\b/], "a Mongo dropDatabase destroys the target database"],
];

function textRules(table: readonly (readonly [TgSecDangerRuleId, RegExp[], string])[]): readonly DangerRule[] {
	return table.map(([id, patterns, reason]) => ({
		id,
		reason: `danger set: ${reason}`,
		objectives: ALL_OBJECTIVES,
		match: (view: TgSecTextSurface) => anyText(view, patterns),
	}));
}

/**
 * A crontab **write** installs a persistent schedule; a read does not. `crontab -l` (alone or with
 * `-u`) lists and is excluded; `crontab <file>`, `crontab -e`, `crontab -r`, and a bare piped
 * `crontab` (installs from stdin) all change the schedule and hit. `cat /etc/crontab` never reaches
 * this matcher at all: its head is `cat`.
 */
function crontabWrites(command: TgSecCommandGroup): boolean {
	if (command.head !== "crontab") return false;
	const args = command.tokens.slice(1);
	const files = args.filter((token) => !token.startsWith("-"));
	const flags = args.filter((token) => token.startsWith("-"));
	if (files.length > 0) return true;
	if (flags.length === 0) return true;
	return !flags.every((flag) => /^-[a-z]*l[a-z]*$/.test(flag));
}

/**
 * The **persistence** family (all objectives): writes that outlive the session on the target. The
 * read-only shapes named by the design — `cat /etc/crontab`, `crontab -l`, `grep
 * authorized_keys`, `systemctl status` — cannot hit, because every matcher here keys on the write
 * verb or write shape, never on the bare presence of the file or path name. The systemd and
 * authorized_keys rules additionally see the *write tool* case: a `file_path` whose value is the
 * path itself, which is what the落盘 shape looks like when the model calls `write` instead of
 * `shell`.
 */
const PERSISTENCE_RULES: readonly DangerRule[] = [
	{
		id: "danger.persist.crontab",
		reason: "danger set: a crontab write installs a persistent scheduled task",
		objectives: ALL_OBJECTIVES,
		match: (view) => view.commands.some(crontabWrites),
	},
	{
		id: "danger.persist.add-user",
		reason: "danger set: an account-creation command leaves a persistent user on the target",
		objectives: ALL_OBJECTIVES,
		match: (view) => view.commands.some((command) => command.head === "useradd" || command.head === "adduser"),
	},
	{
		id: "danger.persist.authorized-keys",
		reason: "danger set: an SSH authorized_keys write plants persistent key-based access",
		objectives: ALL_OBJECTIVES,
		match: (view, toolName) =>
			anyText(view, [/(?:>>|\btee\b)[\s\S]*authorized_keys/, /authorized_keys[\s\S]*\btee\b/]) ||
			(isWriteTool(toolName) &&
				view.strings.some((value) => value.trim().toLowerCase().endsWith("authorized_keys"))),
	},
	{
		id: "danger.persist.schtasks",
		reason: "danger set: a schtasks create registers a persistent Windows task",
		objectives: ALL_OBJECTIVES,
		match: (view) => anyText(view, [/\bschtasks\b[\s\S]*\/create\b/]),
	},
	{
		id: "danger.persist.systemd-unit",
		reason: "danger set: a systemd unit write or enable leaves a persistent service on the target",
		objectives: ALL_OBJECTIVES,
		match: (view, toolName) =>
			anyText(view, [
				/\bsystemctl\s+enable\b/,
				/(?:>>|tee|\bcp\b|\bmv\b|\binstall\b|\bprintf\b|\becho\b)[\s\S]*\/etc\/systemd\/system/,
			]) ||
			(isWriteTool(toolName) &&
				view.strings.some((value) => value.trim().toLowerCase().startsWith("/etc/systemd/system/"))),
	},
];

/**
 * The **critical-path removal** rule (2026-10-22 decision: forced ask, not hard deny — a human may
 * approve it). `rm` with recursive+force onto `/etc`, `/usr`, and the rest (including sub-paths like
 * `/etc/nginx`) hits; `rm -rf /`, `/*`, `~`, and `$HOME` stay the hard-deny rules' job, and
 * `rm -rf ./build` or `rm -rf /tmp/x` must not hit.
 */
const SYSTEM_DIRECTORIES = ["/etc", "/usr", "/var", "/boot", "/dev", "/sys", "/proc", "/lib", "/bin", "/sbin"];

const CRITICAL_PATH_REMOVAL: readonly DangerRule[] = [
	{
		id: "danger.rm.system-path",
		reason: "danger set: a forced recursive removal of a system directory",
		objectives: ALL_OBJECTIVES,
		match: (view) =>
			view.commands.some((command) => {
				if (command.head !== "rm") return false;
				if (!hasForcedRecursiveFlags(command.tokens)) return false;
				return nonFlagTargets(command).some((target) => {
					const path = target.replace(/\/\*$/, "");
					return SYSTEM_DIRECTORIES.some((directory) => path === directory || path.startsWith(`${directory}/`));
				});
			}),
	},
];

/**
 * The **business-action guardrails** (redteam/src; **CTF exempt** — on a range these verbs are
 * puzzle moves, in production they mutate real money, identity, and mailboxes): password
 * change/reset, contact rebind, payment movement, and SMS/email floods. Deliberately narrow:
 * the English patterns require the business object beside the action verb, so a report that merely
 * mentions a password column or a file transfer does not trip them, and every one carries a
 * near-miss negative in the suite.
 */
const BUSINESS_RULES: readonly DangerRule[] = [
	{
		id: "danger.business.password-change",
		reason: "danger set: a request changes or resets a password on a live business account",
		objectives: REAL_TARGET_OBJECTIVES,
		match: (view) =>
			anyText(view, [
				/\b(?:change|reset|modify|update)\b[\s\S]{0,24}\b(?:password|passwd|pwd)\b/,
				/\b(?:password|passwd|pwd)\b[\s\S]{0,16}\b(?:change|reset|modify)\b/,
				/(?:change|reset|modify|update|set)[_-](?:password|passwd|pwd)|(?:password|passwd|pwd)[_-](?:change|reset|modify)/,
				/(?:修改|重置)密码|密码(?:修改|重置)|改密/,
			]),
	},
	{
		id: "danger.business.contact-rebind",
		reason: "danger set: a request rebinds an account phone number or email",
		objectives: REAL_TARGET_OBJECTIVES,
		match: (view) =>
			anyText(view, [
				/\b(?:re-?bind|relink|unbind)\b[\s\S]{0,24}\b(?:phone|mobile|email|mail)\b/,
				/\b(?:phone|mobile|email)\b[\s\S]{0,16}\b(?:re-?bind|relink|unbind)\b/,
				/换绑|改绑|(?:解绑|绑定)(?:手机|邮箱)|(?:手机|邮箱)(?:号)?(?:换绑|解绑)/,
			]),
	},
	{
		id: "danger.business.payment-move",
		reason: "danger set: a request moves, refunds, or transfers money on a live business system",
		objectives: REAL_TARGET_OBJECTIVES,
		match: (view) =>
			anyText(view, [
				/\b(?:refund|withdraw|remit|payout)\b/,
				/\btransfer\b[\s\S]{0,24}\b(?:money|amount|balance|account|payment|to account|资金|金额|账户)/,
				/(?:转账|退款|提现|汇款|打款)/,
				/\b(?:pay|order|balance|account)\b[\s\S]{0,16}\b(?:refund|transfer)\b/,
			]),
	},
	{
		id: "danger.business.messaging-bomb",
		reason: "danger set: a request floods SMS, email, or phone calls at a live target",
		objectives: REAL_TARGET_OBJECTIVES,
		match: (view) =>
			anyText(view, [
				/\b(?:sms|email|mail|notify)\b[\s\S]{0,24}\b(?:bomb|flood)\b/,
				/\b(?:bomb|flood)\b[\s\S]{0,24}\b(?:sms|email|mail)\b/,
				/(?:短信|邮件|电话)(?:轰炸|洪水)|呼死你/,
			]),
	},
];

/**
 * Public giant-dictionary markers: the names whose line counts are known to be enormous, and the
 * distribution directories that carry them. A custom per-target list without one of these names is
 * not assumed huge (the negative `-w /tmp/candidates.txt` must pass); that trade — missing an
 * unknown big list rather than asking on every small one — is deliberate.
 */
const HUGE_WORDLIST_MARKERS: readonly RegExp[] = [
	/rockyou/,
	/seclists/,
	/darkweb?ll/,
	/probable[-_.]?passwords?/,
	/collection[-_.]?list/,
	/\bcombo[-_.]?list/,
	/backup[-_.]?pass/,
	/brutescene/,
	/skullbrea?kers?/,
	/rootkit[-_.]?pass/,
	/10[-_.]?(?:million|m\w{0,3})\.?(?:txt|lst|gz)/,
	/top[-_.]?(?:1000|1k|10k|100k|1m|10m|100m|1mil|10mil)/,
	/(?:^|[/\\])wordlists?([/\\]|$)/,
	/\/usr\/share\/(?:wordlists?|rocktarr?)/,
];

/** The `-w`/`--wordlist` value of a command, in separated or `=`-attached form; else undefined. */
function wordlistValue(command: TgSecCommandGroup): string | undefined {
	const tokens = command.tokens;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-w" || token === "--wordlist" || token === "--word-list") return tokens[i + 1];
		if (/^--word-?list=/.test(token) || /^-w=/i.test(token)) return token.slice(token.indexOf("=") + 1);
	}
	return undefined;
}

/**
 * The **oversized-wordlist** rule (all three tracks). Hitting it is a budget-and-pacing guardrail,
 * not a safety boundary, and the reason says so: a public giant dictionary turned loose is hours to
 * days of compute whatever the track. Attached short forms (`-wrockyou.txt`) are the known
 * tokenization limitation inherited from the target-flag parser; the `=` forms and separated values
 * cover the documented positives.
 */
const WORDLIST_RULES: readonly DangerRule[] = [
	{
		id: "danger.wordlist.huge",
		reason: "danger set: a public oversized wordlist — a budget and pacing guardrail, not a safety boundary",
		objectives: ALL_OBJECTIVES,
		match: (view) =>
			view.commands.some((command) => {
				const value = wordlistValue(command);
				return value !== undefined && HUGE_WORDLIST_MARKERS.some((marker) => marker.test(value));
			}) ||
			anyText(
				view,
				HUGE_WORDLIST_MARKERS.map((marker) => new RegExp(`(?:-w|--word-?list)[=\\s][^\\s]*${marker.source}`, "i")),
			),
	},
];

/**
 * The CTF cracking rules. On the CTF track, cracking is delegated to the platform's own pacing and
 * rate limits, so `hashcat` and `john` run bare by the agent go to a human instead of riding
 * `yolo`. On the real-target tracks these commands are not the guardrail's subject: `hashcat` there
 * rides the wordlist rule (which is all-track) and ordinary mode dispatch.
 */
const BRUTEFORCE_RULES: readonly DangerRule[] = [
	{
		id: "danger.bruteforce.hashcat",
		reason: "danger set (CTF): hashcat cracking is delegated to platform pacing, not run bare by the agent",
		objectives: CTF_OBJECTIVES,
		match: (view) => view.commands.some((command) => command.head === "hashcat"),
	},
	{
		id: "danger.bruteforce.john-wordlist",
		reason: "danger set (CTF): john with a wordlist is delegated to platform pacing, not run bare by the agent",
		objectives: CTF_OBJECTIVES,
		match: (view) =>
			view.commands.some(
				(command) =>
					command.head === "john" && command.tokens.slice(1).some((token) => /^(?:-w|--word-?list)/.test(token)),
			),
	},
];

/**
 * The whole set in evaluation order — target-destructive, persistence, critical-path removal, then
 * the objective-conditional families. First armed match wins, like every other layer, so one
 * request reports one closed rule id.
 */
const DANGER_RULES: readonly DangerRule[] = [
	...textRules(SQL_DESTRUCTIVE),
	...textRules(TOOL_DESTRUCTIVE),
	...PERSISTENCE_RULES,
	...CRITICAL_PATH_REMOVAL,
	...BUSINESS_RULES,
	...WORDLIST_RULES,
	...BRUTEFORCE_RULES,
];

/**
 * The armed table as data — `[id, reason, objectives]` per rule — so the suite can assert every
 * closed id is present and walk the objective matrix without re-declaring the vocabulary. Internal
 * to the package (not exported from `index.ts`): the rule set is not host-configurable, exactly
 * like the hard-deny list.
 */
export const TG_SEC_DANGER_RULES: readonly (readonly [TgSecDangerRuleId, string, readonly TgSecObjective[]])[] =
	DANGER_RULES.map((rule) => [rule.id, rule.reason, rule.objectives]);

/**
 * Build the dangerous-instruction evaluator for one track (2026-10-22: 赛道 is a construction-time
 * parameter, not a per-call argument). An objective outside `TG_SEC_OBJECTIVES` throws at
 * construction — the guard must not silently fall back to another track's guardrails.
 *
 * The evaluator consumes the package's finished views and nothing else: matching runs on the
 * **text-scan view** (`scanTextSurface`), which carries every string value including `detail` keys,
 * because SQL and payload text is exactly what the danger set matches and it lives under `query`,
 * `body`, `content`. It reads **no** connection-target view: a danger rule never matches a host, so
 * the batch 1c parameter-name filter stays outside this layer's reach and the two views cannot be
 * quietly merged back into one. The tree traversal itself lives only in `command-text.ts`
 * (`test/boundary.test.ts` pins this).
 */
export function createTgSecDangerEvaluator(options: { objective: TgSecObjective }): TgSecDangerEvaluator {
	const objective = options.objective;
	if (!TG_SEC_OBJECTIVES.includes(objective)) {
		throw new TypeError(
			`createTgSecDangerEvaluator: objective ${JSON.stringify(objective)} is not one of ${TG_SEC_OBJECTIVES.join(", ")}`,
		);
	}
	const armed = DANGER_RULES.filter((rule) => rule.objectives.includes(objective));
	return (request: TgSecRequest): TgSecDangerHit => {
		const view = scanTextSurface(request);
		for (const rule of armed) {
			if (rule.match(view, request.toolName)) {
				return { hit: true, rule: rule.id, reason: rule.reason };
			}
		}
		return { hit: false };
	};
}
