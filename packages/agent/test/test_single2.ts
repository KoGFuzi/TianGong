// @ts-nocheck
import { Effect } from "effect";
import {
  JsonlSessionRepo,
} from "./src/harness/session/index.ts";
import { NodeExecutionEnv } from "./src/harness/env/nodejs.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

const root = mkdtempSync(join(tmpdir(), "test-jsonl-"));

const repo = new JsonlSessionRepo({
  fs: new NodeExecutionEnv({ cwd: root }),
  sessionsRoot: root,
});

async function main() {
  console.log("1. Creating session with await...");
  const session1 = await repo.create({ id: "test", cwd: root });
  console.log("   session1 type:", typeof session1);
  console.log("   session1.isEffect:", Effect.isEffect(session1));
  console.log("   session1.constructor.name:", session1?.constructor?.name);
  
  console.log("\n2. Creating session with Effect.runPromise...");
  const session2 = await Effect.runPromise(repo.create({ id: "test2", cwd: root }));
  console.log("   session2 type:", typeof session2);
  console.log("   session2.isEffect:", Effect.isEffect(session2));
  console.log("   session2.constructor.name:", session2?.constructor?.name);
}

main().catch(console.error);
