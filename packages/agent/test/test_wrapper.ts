// @ts-nocheck
import { Effect } from "effect";
import { JsonlSessionRepo } from "./src/harness/session/jsonl/repo.ts";
import { NodeExecutionEnv } from "./src/harness/env/nodejs.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

function withDefaultSessionCwd(repository: any, cwd: string): any {
  return {
    create(options: any) {
      const optionsWithCwd = { ...options, cwd };
      return repository.create(optionsWithCwd);
    },
    open: (metadata: any) => repository.open(metadata),
    list: () => repository.list(),
    delete: (metadata: any) => repository.delete(metadata),
    fork(source: any, options: any) {
      const optionsWithCwd = { ...options, cwd };
      return repository.fork(source, optionsWithCwd);
    },
  };
}

function asPromiseRepo<T>(repo: any): unknown {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const effect = value.apply(target, args);
        console.log(`  [asPromiseRepo] ${String(prop)} - isEffect: ${Effect.isEffect(effect)}`);
        return Effect.runPromise(effect).then((result) => {
          if (prop === "create" || prop === "open" || prop === "fork") {
            console.log(`  [asPromiseRepo] Wrapping session for ${String(prop)}`);
            return asPromiseSession(result);
          }
          return result;
        });
      };
    },
  }) as unknown;
}

function asPromiseSession(session: any): unknown {
  return new Proxy(session, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        if (Effect.isEffect(result)) {
          return Effect.runPromise(result);
        }
        if (prop === "view" && result && typeof result === "object") {
          return asPromiseSession(result);
        }
        return result;
      };
    },
  }) as unknown;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "test-jsonl-"));
  try {
    const repo = new JsonlSessionRepo({
      fs: new NodeExecutionEnv({ cwd: root }),
      sessionsRoot: root,
    });
    const wrappedRepo = withDefaultSessionCwd(repo, root);
    const proxiedRepo = asPromiseRepo(wrappedRepo);
    
    console.log("Creating session...");
    const session = await (proxiedRepo as any).create({ id: "test" });
    console.log("session type:", typeof session);
    console.log("session has getMetadata:", typeof (session as any).getMetadata);
    
    if ((session as any).getMetadata) {
      const metadata = await (session as any).getMetadata();
      console.log("metadata id:", metadata?.id);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
}

main().catch(console.error);
