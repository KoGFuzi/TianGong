// @ts-nocheck
import { Effect } from "effect";
import { InMemorySessionRepo } from "./src/harness/session/memory.ts";

function asPromiseRepo<T>(repo: any): unknown {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const effect = value.apply(target, args);
        return Effect.runPromise(effect).then((result) => {
          if (prop === "create" || prop === "open" || prop === "fork") {
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
  const repo = new InMemorySessionRepo();
  const repoProxy = asPromiseRepo(repo);
  
  console.log("1. Creating session via proxy...");
  const session = await (repoProxy as any).create({ id: "test" });
  console.log("   session type:", session?.constructor?.name);
  console.log("   session has getMetadata:", typeof (session as any).getMetadata);
  
  console.log("\n2. Calling session.getMetadata()...");
  const metadata = await (session as any).getMetadata();
  console.log("   metadata id:", metadata?.id);
}

main().catch(console.error);
