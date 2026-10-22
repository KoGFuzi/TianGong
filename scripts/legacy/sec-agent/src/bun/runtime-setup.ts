import { bedrockProviderModule } from "@OnePanda-TgSec/tg-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@OnePanda-TgSec/tg-ai/bun-oauth";
import { setBedrockProviderModule } from "@OnePanda-TgSec/tg-ai/compat";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setEmbeddedQuickJSWasmPath } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
setEmbeddedQuickJSWasmPath(quickjsWasmPath);
