import type { TgSecAskChannel, TgSecAskReply, TgSecDecision, TgSecRequest } from "@OnePanda-TgSec/tg-sec-guard";
import type { SecApprovalQueue } from "@OnePanda-TgSec/tg-sec-server";
import { createInterface } from "node:readline";

/** One recorded ask: the request and the decision that escalated it. */
export type SecAskedEntry = {
	readonly request: TgSecRequest;
	readonly decision: TgSecDecision & { effect: "ask" };
};

/** Scripted ask channel for tests and non-interactive runs. */
export type SecQueueAskChannel = {
	readonly ask: TgSecAskChannel;
	/** Every ask the channel has seen, in order. */
	readonly asked: readonly SecAskedEntry[];
};

/**
 * A queue channel that answers from a script. When the script is exhausted the channel answers
 * `deny`: a scripted run that forgot to script an answer must fail closed, not hang and not pass.
 */
export function createQueueAskChannel(replies: readonly TgSecAskReply[] = []): SecQueueAskChannel {
	const pending = [...replies];
	const asked: SecAskedEntry[] = [];
	const ask: TgSecAskChannel = async (request, decision) => {
		asked.push({ request, decision });
		const reply = pending.shift();
		return reply ?? "deny";
	};
	return { ask, asked };
}

/**
 * The WebUI ask channel: the guard's escalation is parked on the sidecar's approval queue, the
 * browser sees an `ask` frame and answers with `ask_reply`, and the guard's existing `always`
 * semantics apply unchanged. A closed queue resolves `deny`, so a vanished sidecar fails closed.
 */
export function createApprovalAskChannel(approvals: SecApprovalQueue): TgSecAskChannel {
	return (request, decision) =>
		approvals.ask({
			toolName: request.toolName,
			resource: request.resource,
			reason: decision.reason,
			forced: decision.forced,
			args: request.arguments,
		});
}

export type StdinAskChannelOptions = {
	/** Where the prompt is written; defaults to the process stdout stream pair. */
	write?: (line: string) => void;
	/** When absent, the channel binds `node:readline` to the given input stream. */
	input?: NodeJS.ReadableStream;
};

function parseReply(answer: string): TgSecAskReply | undefined {
	const token = answer.trim().toLowerCase();
	if (token === "y" || token === "allow") return "allow";
	if (token === "n" || token === "deny") return "deny";
	if (token === "a" || token === "always") return "always";
	return undefined;
}

/**
 * The operator's terminal ask channel: prints the reason, waits for `y`/`n`/`a`. An empty or
 * unparseable answer re-prompts once, then denies — a human who cannot answer is a human who is
 * not present, and the guard fails closed.
 */
export function createStdinAskChannel(options: StdinAskChannelOptions = {}): TgSecAskChannel {
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const input = options.input ?? process.stdin;
	const ask: TgSecAskChannel = async (request, decision) => {
		const prompt = `[guard ask] ${request.toolName}: ${decision.reason}\n允许一次=y / 拒绝=n / 长期允许=a > `;
		const rl = createInterface({ input, output: options.input === undefined ? process.stdout : undefined });
		try {
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const answer = await new Promise<string>((resolve, reject) => {
					rl.once("close", () => resolve(""));
					rl.question(prompt, resolve);
					input.once?.("error", reject);
				});
				const reply = parseReply(answer);
				if (reply !== undefined) return reply;
				write("(答 y / n / a)");
			}
			return "deny";
		} finally {
			rl.close();
		}
	};
	return ask;
}
