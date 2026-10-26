import type { AssistantMessage, Usage } from "@OnePanda-TgSec/tg-ai";
import { contentText } from "@OnePanda-TgSec/tg-ai";
import type { UsageState } from "@OnePanda-TgSec/tg-gibraltar";
import {
	type Component,
	Container,
	Markdown,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@OnePanda-TgSec/tg-tui";
import { tgSecMarkdownTheme, tgSecStyle } from "./theme.ts";

/** How much running tool output a card retains; transcript fidelity beyond this is the result entry's job. */
const MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_PREVIEW_LINES = 16;
const PREVIEW_HEAD = 8;
const MAX_ARG_CHARS = 200;

/** The compact one-line argument summary a tool card shows. */
export function summarizeToolArgs(args: Record<string, unknown>): string {
	const command = args.command;
	let text: string;
	if (typeof command === "string") text = command;
	else {
		try {
			text = JSON.stringify(args);
		} catch {
			text = "(unserializable arguments)";
		}
	}
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_ARG_CHARS ? `${flat.slice(0, MAX_ARG_CHARS - 3)}...` : flat;
}

/** Keep the head and tail of long output, each line clipped to the available width. */
export function previewOutputLines(output: string, width: number): string[] {
	const clean = stripTerminalSequences(output).replace(/\r/g, "");
	const lines = clean.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const available = Math.max(8, width - 4);
	const clipped = lines.map((line) => truncateToWidth(line, available, "...", false));
	if (clipped.length <= MAX_PREVIEW_LINES) return clipped;
	const omitted = clipped.length - PREVIEW_HEAD * 2;
	return [
		...clipped.slice(0, PREVIEW_HEAD),
		tgSecStyle.dim(`... ${omitted} line(s) elided ...`),
		...clipped.slice(-PREVIEW_HEAD),
	];
}

/** One tool call as a compact card: header, arguments summary, and a bounded output preview. */
export class ToolCard implements Component {
	readonly callId: string;
	readonly name: string;
	private args: Record<string, unknown>;
	private output = "";
	private status: "running" | "done" | "error" = "running";

	constructor(callId: string, name: string, args: Record<string, unknown> = {}) {
		this.callId = callId;
		this.name = name;
		this.args = args;
	}

	/** Replace the arguments summary; an empty object never overwrites known arguments. */
	setArgs(args: Record<string, unknown>): void {
		if (Object.keys(args).length === 0) return;
		this.args = args;
	}

	setOutput(output: string): void {
		this.output = output.slice(-MAX_OUTPUT_CHARS);
	}

	/** Apply one running update: trim from the retained head, then append, or replace wholesale. */
	applyOutput(update: { trimStart?: number; append?: string } | { set: string }): void {
		if ("set" in update) {
			this.setOutput(update.set);
			return;
		}
		if (update.trimStart !== undefined && update.trimStart > 0) this.output = this.output.slice(update.trimStart);
		if (update.append !== undefined) this.output = (this.output + update.append).slice(-MAX_OUTPUT_CHARS);
	}

	appendOutput(text: string): void {
		this.applyOutput({ append: text });
	}

	finish(isError: boolean): void {
		this.status = isError ? "error" : "done";
	}

	getStatus(): "running" | "done" | "error" {
		return this.status;
	}

	render(width: number): string[] {
		const marker = this.status === "running" ? ">" : this.status === "error" ? "x" : "+";
		const head = `${marker} ${this.name}`;
		const styledHead =
			this.status === "running"
				? tgSecStyle.yellow(head)
				: this.status === "error"
					? tgSecStyle.red(head)
					: tgSecStyle.green(head);
		const summary = summarizeToolArgs(this.args);
		const state = this.status === "running" ? tgSecStyle.dim("running") : tgSecStyle.dim(this.status);
		const header = `${styledHead}${summary === "" ? "" : `  ${tgSecStyle.dim(summary)}`}  ${state}`;
		const lines = [truncateToWidth(header, width, "...", true)];
		const output = this.output.trimEnd();
		if (output === "") {
			if (this.status !== "running") lines.push(tgSecStyle.dim("  (no output)"));
			return lines;
		}
		const preview = previewOutputLines(output, width);
		for (const line of preview) {
			const padded = `${tgSecStyle.gray("  | ")}${line}`;
			lines.push(truncateToWidth(padded, width, "...", true));
		}
		return lines;
	}

	invalidate(): void {}
}

/** User input, prefixed and wrapped as one block. */
export function userMessageText(message: string): Text {
	return new Text(`${tgSecStyle.blue(tgSecStyle.bold("> "))}${message}`, 1, 0);
}

/** The assistant's visible answer: text blocks only; thinking and tool calls have their own blocks. */
export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}

/** The assistant's visible reasoning, joined in one dim block. */
export function assistantThinking(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking)
		.join("\n\n")
		.trim();
}

/** The in-flight rendering: thinking first, then the answer, both as plain text as they arrive. */
export function assistantPartialText(message: AssistantMessage): string {
	const parts: string[] = [];
	const thinking = assistantThinking(message);
	if (thinking !== "") parts.push(tgSecStyle.dim(`[thinking] ${thinking}`));
	const text = assistantText(message);
	if (text !== "") parts.push(text);
	return parts.join("\n\n");
}

/** Final answer blocks: thinking as dim text, the answer as Markdown, the failure as a note. */
export function assistantMessageBlocks(message: AssistantMessage): Component[] {
	const blocks: Component[] = [];
	const thinking = assistantThinking(message);
	if (thinking !== "") blocks.push(new Text(tgSecStyle.dim(`[thinking] ${thinking}`), 1, 0));
	const text = assistantText(message);
	if (text !== "") blocks.push(new Markdown(text, 1, 0, tgSecMarkdownTheme));
	if (message.errorMessage !== undefined && message.errorMessage !== "") {
		blocks.push(new Text(tgSecStyle.red(`error: ${message.errorMessage}`), 1, 0));
	}
	if (message.stopReason === "aborted") blocks.push(new Text(tgSecStyle.dim("[aborted]"), 1, 0));
	return blocks;
}

/** The result text of a tool result message. */
export function toolResultText(content: Parameters<typeof contentText>[0]): string {
	return contentText(content).trim();
}

/** A total line for `/usage`: every model bucket and every tool bucket summed. */
export function formatUsage(usage: UsageState | undefined): string {
	if (usage === undefined) return "usage: none yet";
	const models = Object.values(usage.models) as readonly Usage[];
	const tools = Object.values(usage.tools) as readonly Usage[];
	const tokens = [...models, ...tools].reduce((sum, entry) => sum + entry.totalTokens, 0);
	const cost = [...models, ...tools].reduce((sum, entry) => sum + entry.cost.total, 0);
	const input = models.reduce((sum, entry) => sum + entry.input, 0);
	const output = models.reduce((sum, entry) => sum + entry.output, 0);
	const cacheRead = models.reduce((sum, entry) => sum + entry.cacheRead, 0);
	return `usage: input=${input} output=${output} cacheRead=${cacheRead} total=${tokens} tokens, cost=${cost.toFixed(6)}`;
}

/** The width of a rendered line, for status composition. */
export function lineWidth(line: string): number {
	return visibleWidth(line);
}

/**
 * The transcript column: blocks in append order, separated by one blank line. Spacing lives in
 * render rather than in spacer children, so replacing a streaming block with the final answer does
 * not have to repair a spacer pair.
 */
export class TranscriptView extends Container {
	append(component: Component): void {
		this.addChild(component);
	}

	replace(from: Component, ...to: Component[]): boolean {
		const index = this.children.indexOf(from);
		if (index === -1) return false;
		this.children.splice(index, 1, ...to);
		return true;
	}

	removeBlock(component: Component): void {
		this.removeChild(component);
	}

	get count(): number {
		return this.children.length;
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const rendered = child.render(width);
			if (rendered.length === 0) continue;
			if (lines.length > 0) lines.push("");
			lines.push(...rendered);
		}
		return lines;
	}
}
