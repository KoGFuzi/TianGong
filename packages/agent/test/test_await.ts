import { Effect } from "effect";

async function main() {
  const effect = Effect.succeed(42);
  console.log("isEffect:", Effect.isEffect(effect));
  
  // Test 1: await on Effect
  const result1 = await effect;
  console.log("await Effect.succeed(42):", result1);
  
  // Test 2: await on Effect.sync
  const effectSync = Effect.sync(() => 43);
  const result2 = await effectSync;
  console.log("await Effect.sync:", result2);
  
  // Test 3: await on Effect.gen
  const effectGen = Effect.gen(function* () { return 44; });
  const result3 = await effectGen;
  console.log("await Effect.gen:", result3);
}

main().catch(console.error);
