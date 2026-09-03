// @ts-nocheck
import {
  JsonlSessionRepo,
} from "./src/harness/session/index.ts";
import { NodeExecutionEnv } from "./src/harness/env/nodejs.ts";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdtempSync } from "node:fs";

const root = mkdtempSync(join(tmpdir(), "test-jsonl-"));
console.log("root:", root);

const repo = new JsonlSessionRepo({
  fs: new NodeExecutionEnv({ cwd: root }),
  sessionsRoot: root,
});

async function main() {
  console.log("1. Creating session...");
  const session = await repo.create({ id: "test", cwd: root });
  console.log("   session type:", typeof session);
  console.log("   session.constructor.name:", session?.constructor?.name);
  console.log("   session has getMetadata:", typeof session?.getMetadata);
  
  if (session?.getMetadata) {
    console.log("\n2. Getting metadata...");
    const metadata = await session.getMetadata();
    console.log("   metadata:", metadata?.id);
  } else {
    console.log("   ERROR: getMetadata is not a function!");
    console.log("   session keys:", Object.keys(session || {}));
  }
}

main().catch(console.error);
