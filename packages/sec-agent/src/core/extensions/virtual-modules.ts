import * as bundledTgAgentCore from "@OnePanda-TgSec/tg-agent-core";
import * as bundledTgAiCompat from "@OnePanda-TgSec/tg-ai/compat";
import * as bundledTgAiOauth from "@OnePanda-TgSec/tg-ai/oauth";
import * as bundledTgAiProviders from "@OnePanda-TgSec/tg-ai/providers/all";
import * as bundledTgTui from "@OnePanda-TgSec/tg-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @OnePanda-TgSec/tg-sec-agent.
import * as bundledTgCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@OnePanda-TgSec/tg-agent-core": bundledTgAgentCore,
	"@OnePanda-TgSec/tg-tui": bundledTgTui,
	// Extensions resolve the tg-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@OnePanda-TgSec/tg-ai": bundledTgAiCompat,
	"@OnePanda-TgSec/tg-ai/compat": bundledTgAiCompat,
	"@OnePanda-TgSec/tg-ai/oauth": bundledTgAiOauth,
	"@OnePanda-TgSec/tg-ai/providers/all": bundledTgAiProviders,
	"@OnePanda-TgSec/tg-sec-agent": bundledTgCodingAgent,
};
