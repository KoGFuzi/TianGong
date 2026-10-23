import { describe, expect, it } from "vitest";
// The evaluator factory is public; the built-in table `TG_SEC_DANGER_RULES` is package-internal by
// batch 2a's shape decision, so this suite imports it from its home module, the same way
// `test/command-text.test.ts` imports the views. `test/boundary.test.ts` pins that `index.ts` hands
// neither out.
import { extractConnectionTargets, scanTextSurface } from "../src/command-text.ts";
import { createTgSecDangerEvaluator, TG_SEC_DANGER_RULES } from "../src/danger.ts";
import { TG_SEC_OBJECTIVES } from "../src/index.ts";
import type { TgSecDangerRuleId, TgSecObjective, TgSecRequest } from "../src/types.ts";

function req(toolName: string, arguments_: Record<string, unknown>): TgSecRequest {
	return { toolName, resource: `tool:${toolName}`, arguments: arguments_ };
}

function shell(command: string): TgSecRequest {
	return req("shell", { command });
}

const REDTEAM = createTgSecDangerEvaluator({ objective: "redteam" });
const CTF = createTgSecDangerEvaluator({ objective: "ctf" });
const SRC = createTgSecDangerEvaluator({ objective: "src" });

function evaluatorFor(objective: TgSecObjective) {
	return objective === "redteam" ? REDTEAM : objective === "ctf" ? CTF : SRC;
}

/** Asserts the hit, names the closed rule, and returns it so a case can inspect the reason. */
function dangerHit(request: TgSecRequest, rule: TgSecDangerRuleId, objective: TgSecObjective = "redteam") {
	const hit = evaluatorFor(objective)(request);
	expect(hit, `${objective} should hit ${rule}`).toEqual({
		hit: true,
		rule,
		reason: expect.stringContaining("danger set"),
	});
	return hit;
}

/** Asserts the request is clean for the danger set on every objective unless one is named. */
function dangerMiss(request: TgSecRequest, objective?: TgSecObjective) {
	const objectives = objective === undefined ? TG_SEC_OBJECTIVES : [objective];
	for (const each of objectives) expect(evaluatorFor(each)(request), `${each} must not hit`).toEqual({ hit: false });
}

describe("construction", () => {
	it("accepts each of the three objectives", () => {
		for (const objective of TG_SEC_OBJECTIVES)
			expect(typeof createTgSecDangerEvaluator({ objective })).toBe("function");
	});

	it("throws on an objective outside the three tracks", () => {
		expect(() => createTgSecDangerEvaluator({ objective: "pentest" as TgSecObjective })).toThrow(TypeError);
		expect(() => createTgSecDangerEvaluator({ objective: "pentest" as TgSecObjective })).toThrow(
			/objective "pentest" is not one of redteam, ctf, src/,
		);
	});

	it("ships the full closed table with every id, reason, and arming list", () => {
		const ids = TG_SEC_DANGER_RULES.map(([id]) => id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.length).toBe(32);
		for (const [, reason, objectives] of TG_SEC_DANGER_RULES) {
			expect(reason.length).toBeGreaterThan(0);
			expect(objectives.length).toBeGreaterThan(0);
			for (const objective of objectives) expect(TG_SEC_OBJECTIVES).toContain(objective);
		}
	});
});

describe("family A: target-destructive, armed on every objective, CTF not exempt", () => {
	it("hits destructive SQL and lets the named read-only scenarios pass", () => {
		dangerHit(shell("mysql -h target -e 'DROP TABLE users'"), "danger.sql.drop-table");
		dangerHit(shell('psql -c "DROP DATABASE prod"'), "danger.sql.drop-database");
		dangerHit(shell('sqlplus -c "TRUNCATE TABLE sessions"'), "danger.sql.truncate");
		dangerHit(shell('mysql -e "DELETE FROM users WHERE 1=1"'), "danger.sql.delete-from");
		// The bare form is exactly as destructive, and the task book demands it hits.
		dangerHit(shell('mysql -e "DELETE FROM audit_log"'), "danger.sql.delete-from");
		dangerHit(shell('mysql -e "ALTER TABLE users DROP COLUMN pwd"'), "danger.sql.alter-drop");
		dangerHit(shell(`mysql -e "UPDATE users SET pwd='x' WHERE id=1"`), "danger.sql.update-set");
		dangerHit(shell('mysql -e "INSERT INTO log VALUES (1)"'), "danger.sql.insert-into");
		dangerHit(shell('mysql -e "REPLACE INTO log VALUES (1)"'), "danger.sql.replace-into");
		dangerHit(shell(`mysql -e "LOAD DATA INFILE '/etc/passwd' INTO TABLE x"`), "danger.sql.load-data-infile");
		dangerHit(shell(`mysql -e "SELECT id INTO OUTFILE '/tmp/d' FROM t"`), "danger.sql.into-outfile");
		dangerHit(shell(`mysql -e "SELECT x INTO DUMPFILE '/tmp/e' FROM t"`), "danger.sql.into-dumpfile");
	});

	it("does not hit reads: SELECT, SHOW, DESCRIBE, EXPLAIN, USE, find()", () => {
		dangerMiss(shell('mysql -e "SELECT * FROM users WHERE id=1"'));
		dangerMiss(shell('mysql -e "SHOW TABLES; SHOW DATABASES"'));
		dangerMiss(shell("mysql -e 'DESCRIBE users'"));
		dangerMiss(shell('mysql -e "EXPLAIN SELECT 1"'));
		dangerMiss(shell('mysql -e "USE appdb"'));
		dangerMiss(req("mongo", { operation: "db.users.find({ active: true })" }));
		dangerMiss(req("sql_exec", { query: "SELECT password_hash FROM users LIMIT 10" }));
	});

	it("keeps the near-miss negatives off each SQL id", () => {
		// The TRUNCATE function is arithmetic, not a table emptied in place.
		dangerMiss(shell("SELECT TRUNCATE(1.9,0) FROM dual"));
		// Prose about an "update ... set" without an assignment is not an UPDATE statement.
		dangerMiss(shell("notes: update the set of regression tests"));
		dangerMiss(shell("grep insert query.log"));
		dangerMiss(shell('mysql -e "ALTER TABLE users ADD COLUMN tag TEXT"'));
		dangerMiss(shell("replace the config file"));
		dangerMiss(shell("load the dataset from the env file"));
	});

	it("hits the SQL where the tool call carries it — a named parameter, not shell text", () => {
		// This is the view split doing its job: `query` is a `detail` key for connection targets and
		// plain text for the danger set, so the SQL under it is visible here (see view isolation below).
		dangerHit(req("sql_exec", { query: "DROP TABLE sessions" }), "danger.sql.drop-table");
	});

	it("hits sqlmap's shell and file-write switches wherever they appear", () => {
		dangerHit(shell("sqlmap -u http://target/ --os-shell"), "danger.tool.sqlmap-os-shell");
		dangerHit(shell("sqlmap -u http://target/ --os-cmd=id"), "danger.tool.sqlmap-os-cmd");
		dangerHit(
			shell("sqlmap -u http://target/ --file-write=shell.jsp --file-dest=C:\\inetpub\\shell.jsp"),
			"danger.tool.sqlmap-file-write",
		);
		dangerHit(shell("sqlmap -u http://target/ --sql-shell"), "danger.tool.sqlmap-sql-shell");
		// The same payload inside a written report body is still the instruction the danger set reads.
		dangerHit(req("write", { content: "then run sqlmap --os-shell against the box" }), "danger.tool.sqlmap-os-shell");
		dangerMiss(shell("sqlmap -u http://target/ --level=3 --risk=2"));
	});

	it("hits destructive web action parameters and lets benign ones pass", () => {
		dangerHit(
			req("http_request", { method: "POST", url: "http://target/", body: "action=delete&id=7" }),
			"danger.web.action-destroy",
		);
		dangerHit(
			req("http_request", { url: "http://target/", query: "op=drop&table=users" }),
			"danger.web.action-destroy",
		);
		dangerMiss(req("http_request", { method: "POST", url: "http://target/", body: "action=view&id=7" }));
		dangerMiss(req("http_request", { url: "http://target/", body: "deleted_count=0&action=list" }));
	});

	it("hits the Redis wipes and the Mongo database drop, not their reads", () => {
		dangerHit(shell("redis-cli -h target FLUSHALL"), "danger.redis.flushall");
		dangerHit(shell("redis-cli FLUSHDB"), "danger.redis.flushdb");
		dangerHit(req("mongo", { operation: "db.dropDatabase()" }), "danger.mongo.drop-database");
		dangerMiss(shell("redis-cli GET session:1"));
		dangerMiss(shell("redis-cli KEYS 'cache:*'"));
	});
});

describe("family B: persistence, armed on every objective", () => {
	it("hits every crontab write shape", () => {
		dangerHit(shell("crontab -e"), "danger.persist.crontab");
		dangerHit(shell("crontab /tmp/job"), "danger.persist.crontab");
		dangerHit(shell("crontab -r"), "danger.persist.crontab");
		dangerHit(shell('echo "* * * * * curl http://target/beat" | crontab'), "danger.persist.crontab");
	});

	it("lets the named read-only crontab scenarios pass", () => {
		dangerMiss(shell("crontab -l"));
		dangerMiss(shell("cat /etc/crontab"));
		dangerMiss(shell("ls /var/spool/cron/crontabs"));
	});

	it("hits account creation and lets a pass-through mention sit at a non-command position", () => {
		dangerHit(shell("useradd -m backdoor"), "danger.persist.add-user");
		dangerHit(shell("adduser ops2"), "danger.persist.add-user");
		dangerHit(shell("sudo useradd hidden"), "danger.persist.add-user");
		dangerMiss(shell("grep useradd /var/log/syslog"));
	});

	it("hits authorized_keys writes through shell and through the write tool, not the grep", () => {
		dangerHit(
			shell("echo ssh-rsa AAAAB3…rXy | tee -a /home/u/.ssh/authorized_keys"),
			"danger.persist.authorized-keys",
		);
		dangerHit(shell("cat key.pub >> ~/.ssh/authorized_keys"), "danger.persist.authorized-keys");
		dangerHit(
			req("write", { file_path: "/home/u/.ssh/authorized_keys", content: "ssh-rsa AAAA" }),
			"danger.persist.authorized-keys",
		);
		dangerMiss(shell("grep ssh-rsa ~/.ssh/authorized_keys"));
		dangerMiss(req("read", { file_path: "/home/u/.ssh/authorized_keys" }));
	});

	it("hits the Windows task registration and lets the query pass", () => {
		dangerHit(shell("schtasks /create /tn updater /sc daily /tr malware.exe"), "danger.persist.schtasks");
		dangerMiss(shell("schtasks /query /tn updater"));
	});

	it("hits systemd unit writes and enables, and lets the status and the cat pass", () => {
		dangerHit(shell("systemctl enable evil.service"), "danger.persist.systemd-unit");
		dangerHit(
			shell("printf '[Service]\nExecStart=/tmp/x' > /etc/systemd/system/evil.service"),
			"danger.persist.systemd-unit",
		);
		dangerHit(
			req("write", { file_path: "/etc/systemd/system/evil.service", content: "[Unit]" }),
			"danger.persist.systemd-unit",
		);
		dangerMiss(shell("systemctl status nginx"));
		dangerMiss(shell("cat /etc/systemd/system/evil.service"));
		dangerMiss(req("read", { file_path: "/etc/systemd/system/evil.service" }));
	});
});

describe("family C: critical-path removal is a danger-set ask, not a hard deny", () => {
	it("hits forced recursive rm on the system directories and their sub-paths", () => {
		dangerHit(shell("rm -rf /etc/nginx"), "danger.rm.system-path");
		dangerHit(shell("rm -rf /usr/*"), "danger.rm.system-path");
		dangerHit(shell("rm --force --recursive /var/log"), "danger.rm.system-path");
		dangerHit(shell("rm -rf /boot /sys /proc /lib /bin /sbin /dev"), "danger.rm.system-path");
	});

	it("leaves the hard deny's own shapes out of the danger set: /, /*, ~, $HOME are denies, not asks", () => {
		// The boundary between the two layers exactly as the 2026-10-22 decision draws it: the
		// unappealable shapes stay in hard deny (`test/hard-deny.test.ts` asserts the denial), and
		// this layer starts where a human may still approve.
		dangerMiss(shell("rm -rf /"));
		dangerMiss(shell("rm -rf /*"));
		dangerMiss(shell("rm -rf ~"));
		dangerMiss(shell("rm -rf $HOME"));
	});

	it("lets work-tree and scratch removals pass", () => {
		dangerMiss(shell("rm -rf ./build"));
		dangerMiss(shell("rm -rf /tmp/x"));
		// No force-recursive pair: a plain file removal under /bin is not the wipe shape.
		dangerMiss(shell("rm -f /bin/ls"));
	});

	it("sees a critical-path removal inside combined-flag shells and substitutions", () => {
		// The same shapes the hard-deny suite pins: the parser now reaches bodies behind `-lc`/`-ic`
		// and targets followed by a closing parenthesis.
		dangerHit(shell("bash -lc 'rm -rf /etc'"), "danger.rm.system-path");
		dangerHit(shell("echo $(rm -rf /etc)"), "danger.rm.system-path");
	});

	it("does not promote prose or a script-file argument to a command", () => {
		// The parenthesis fix must not turn a numbered list in a report into a command position, and a
		// shell reading a script file still has no body to parse.
		dangerMiss(req("write", { content: "steps:\n1) rm -rf /etc" }));
		dangerMiss(shell("printf '1) rm -rf /etc'"));
		dangerMiss(shell("bash script.sh"));
	});
});

describe("family D: objective-conditional rules", () => {
	it("arms the business guardrails on redteam and src, exempts CTF", () => {
		for (const objective of ["redteam", "src"] as const) {
			dangerHit(
				req("http_request", { body: '{"op":"change_password","new":"x"}' }),
				"danger.business.password-change",
				objective,
			);
			dangerHit(
				req("http_request", { body: "rebind phone 13800000000" }),
				"danger.business.contact-rebind",
				objective,
			);
			dangerHit(req("http_request", { body: "帮用户换绑邮箱" }), "danger.business.contact-rebind", objective);
			dangerHit(req("http_request", { body: "issue a refund of 500" }), "danger.business.payment-move", objective);
			dangerHit(req("http_request", { body: "执行转账 1000 元" }), "danger.business.payment-move", objective);
			dangerHit(shell("apitest --endpoint sms --flood 13800000000"), "danger.business.messaging-bomb", objective);
			dangerHit(req("http_request", { body: "发起短信轰炸" }), "danger.business.messaging-bomb", objective);
			// The Chinese reset-password phrase is the armed shape, asserted as a hit on the armed tracks.
			dangerHit(req("http_request", { body: "重置密码后验证登录" }), "danger.business.password-change", objective);
		}
		for (const request of [
			req("http_request", { body: '{"op":"change_password","new":"x"}' }),
			req("http_request", { body: "rebind phone 13800000000" }),
			req("http_request", { body: "issue a refund of 500" }),
			req("http_request", { body: "发起短信轰炸" }),
		]) {
			dangerMiss(request, "ctf");
		}
	});

	it("keeps the business near-misses clean on the armed tracks", () => {
		dangerMiss(shell("grep -r 'password' src/config"));
		dangerMiss(shell("transfer the archive to the backup host"));
		dangerMiss(req("http_request", { body: "send one test email to the user" }));
		dangerMiss(req("http_request", { body: "check whether the phone number was already unbound" }));
	});

	it("arms the oversized-wordlist guardrail on all three tracks, as a budget guardrail", () => {
		for (const objective of TG_SEC_OBJECTIVES) {
			const hit = dangerHit(
				shell("wfuzz -w /usr/share/wordlists/rockyou.txt -u http://target/FUZZ"),
				"danger.wordlist.huge",
				objective,
			);
			// The reason must say what it is: a pacing decision, not a safety boundary.
			expect(hit.reason).toContain("budget");
			expect(hit.reason).toContain("not a safety boundary");
			dangerHit(
				shell("hydra -l admin --wordlist=SecLists/Passwords/Default-Credentials/ssh.guess -t 4 ssh://target"),
				"danger.wordlist.huge",
				objective,
			);
		}
		// A custom per-target list with no public-huge marker is not assumed big: the heuristic trades
		// missing an unknown large list for never asking on small ones.
		dangerMiss(shell("hydra -w /tmp/candidates.txt -l admin ssh://target"));
	});

	it("arms the cracking delegation on CTF only", () => {
		dangerHit(shell("hashcat -m 1000 -a 0 hash.txt dump.txt"), "danger.bruteforce.hashcat", "ctf");
		dangerHit(shell("john -w dict.txt hash.txt"), "danger.bruteforce.john-wordlist", "ctf");
		// The same commands on the real-target tracks are not this guardrail's subject: there the
		// wordlist rule (all-track) and ordinary mode dispatch cover them.
		dangerMiss(shell("hashcat -m 1000 hash.txt pot.txt"), "redteam");
		dangerMiss(shell("hashcat -m 1000 hash.txt pot.txt"), "src");
		dangerMiss(shell("john -w dict.txt hash.txt"), "redteam");
		// Even on CTF, `john` with no wordlist flag is not the delegated shape.
		dangerMiss(shell("john hash.txt"), "ctf");
	});
});

describe("the objective matrix, cell by cell", () => {
	// The task book's matrix: three objectives × {A, B, C, D-business, D-wordlist, D-cracking}, each
	// cell asserted against the real evaluator rather than the arming table alone.
	it("A and B and C hit on all three tracks; business hits except CTF; wordlist hits everywhere; cracking only on CTF", () => {
		const matrix: readonly (readonly [string, TgSecRequest, Record<TgSecObjective, boolean>])[] = [
			["A", shell("sqlmap -u http://target/ --os-shell"), { redteam: true, ctf: true, src: true }],
			["B", shell("useradd -m ops3"), { redteam: true, ctf: true, src: true }],
			["C", shell("rm -rf /var/log/syslog"), { redteam: true, ctf: true, src: true }],
			["D-business", shell("帮客户把手机号换绑"), { redteam: true, ctf: false, src: true }],
			["D-wordlist", shell("john --wordlist=rockyou.txt hashes.txt"), { redteam: true, ctf: true, src: true }],
			["D-cracking", shell("hashcat -b capture.pcap.crack"), { redteam: false, ctf: true, src: false }],
		];
		for (const [family, request, expected] of matrix) {
			for (const objective of TG_SEC_OBJECTIVES) {
				const hit = evaluatorFor(objective)(request);
				expect(hit.hit, `${family} on ${objective}`).toBe(expected[objective]);
			}
		}
	});
});

describe("view isolation: the danger set reads the text-scan view, never the target view", () => {
	it("scanTextSurface sees SQL under a detail key and the danger set hits it", () => {
		const request = req("sql_exec", { query: "DROP TABLE sessions" });
		expect(scanTextSurface(request).strings).toEqual(["DROP TABLE sessions"]);
		expect(REDTEAM(request)).toEqual({
			hit: true,
			rule: "danger.sql.drop-table",
			reason: expect.any(String),
		});
	});

	it("extractConnectionTargets stays blind to the same text: a URL under `body` is not a target", () => {
		const request = req("http_request", { url: "http://target/", body: "next=http://127.0.0.1/admin" });
		expect(scanTextSurface(request).strings).toContain("next=http://127.0.0.1/admin");
		// The batch 1c parameter-name filter still governs the other view: `body` is a detail key,
		// so the loopback URL inside it produces no candidate at all, while the declared `url` does.
		expect(extractConnectionTargets(request)).toEqual([{ host: "target", evidence: "strong" }]);
	});

	it("a host the target view finds is not what a danger rule matches on", () => {
		// The danger set reads text, not tiers: registering nothing about `localhost` does not soften
		// a danger hit, and a pure host call with no danger text stays clean for this layer.
		expect(REDTEAM(req("connect", { host: "127.0.0.1" }))).toEqual({ hit: false });
		expect(REDTEAM(req("sql_exec", { query: "localhost is down" }))).toEqual({ hit: false });
	});
});
