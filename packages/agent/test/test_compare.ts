// @ts-nocheck
import { Effect } from "effect";
import { InMemorySessionRepo } from "./src/harness/session/memory.ts";
import { JsonlSessionRepo } from "./src/harness/session/index.ts";
import { NodeExecutionEnv } from "./src/harness/env/nodejs.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

async function main() {
  // Test InMemorySessionRepo
  console.log("=== InMemorySessionRepo ===");
  const memRepo = new InMemorySessionRepo();
  const memSession1 = await memRepo.create({ id: "test" });
  console.log("await create - isEffect:", Effect.isEffect(memSession1));
  const memSession2 = await Effect.runPromise(memRepo.create({ id: "test2" }));
  console.log("Effect.runPromise - isEffect:", Effect.isEffect(memSession2));
  
  // Test JsonlSessionRepo
  console.log("\n=== JsonlSessionRepo ===");
  const root = mkdtempSync(join(tmpdir(), "test-jsonl-"));
  try {
    const jsonRepo = new JsonlSessionRepo({
      fs: new NodeExecutionEnv({ cwd: root }),
      sessionsRoot: root,
    });
    const jsonSession1 = await jsonRepo.create({ id: "test", cwd: root });
    console.log("await create - isEffect:", Effect.isEffect(jsonSession1));
    const jsonSession2 = await Effect.runPromise(jsonRepo.create({ id: "test2", cwd: root }));
    console.log("Effect.runPromise - isEffect:", Effect.isEffect(jsonSession2));
  } finally {
    rmSync(root, { recursive: true });
  }
}

main().catch(console.error);
