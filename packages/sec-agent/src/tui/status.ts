import type { UsageState } from "@OnePanda-TgSec/tg-gibraltar";
import { type Component, Text, truncateToWidth, visibleWidth } from "@OnePanda-TgSec/tg-tui";
import { tgSecStyle } from "./theme.ts";

/** One-line shell state, rendered as an inverse status bar. */
export type TgSecStatusState = {
	project: string;
	lane: string;
	mode: string;
	model: string;
	busy: boolean;
	usage?: UsageState;
};

function totalTokens(usage: UsageState | undefined): number {
	if (usage === undefined) return 0;
	let total = 0;
	for (const entry of Object.values(usage.models)) total += entry.totalTokens;
	for (const entry of Object.values(usage.tools)) total += entry.totalTokens;
	return total;
}

function compactTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m tok`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
	return `${tokens} tok`;
}

export class StatusBar implements Component {
	private state: TgSecStatusState;

	constructor(state: TgSecStatusState) {
		this.state = state;
	}

	setState(patch: Partial<TgSecStatusState>): void {
		this.state = { ...this.state, ...patch };
	}

	getState(): Readonly<TgSecStatusState> {
		return this.state;
	}

	render(width: number): string[] {
		const left = [
			"tgsec",
			this.state.project,
			this.state.lane,
			this.state.mode,
			this.state.model,
			compactTokens(totalTokens(this.state.usage)),
		].join("  ");
		const right = this.state.busy ? "running" : "ready";
		const available = Math.max(1, width - visibleWidth(right) - 3);
		const clippedLeft = truncateToWidth(left, available, "...", false);
		const gap = Math.max(1, width - visibleWidth(clippedLeft) - visibleWidth(right) - 1);
		const line = ` ${clippedLeft}${" ".repeat(gap)}${right}`;
		return [tgSecStyle.inverse(truncateToWidth(line, width, "", true))];
	}

	invalidate(): void {}
}

/** The pending guard ask, shown above the editor; renders nothing while the queue is empty. */
export type TgSecAskPrompt = {
	toolName: string;
	reason: string;
	forced: boolean;
	queued: number;
};

export class AskBar implements Component {
	private readonly text: Text;

	constructor() {
		this.text = new Text("", 1, 0, (value) => `\x1b[43m\x1b[30m${value}\x1b[39m\x1b[49m`);
	}

	setPrompt(prompt: TgSecAskPrompt | undefined): void {
		if (prompt === undefined) {
			this.text.setText("");
			return;
		}
		const scope = prompt.forced ? "forced" : "ask";
		const queue = prompt.queued > 1 ? `  (${prompt.queued} queued)` : "";
		const head = `[guard ${scope}] ${prompt.toolName}: ${prompt.reason}${queue}`;
		const keys = "allow once=y  deny=n  always=a  deny all=ctrl+c";
		this.text.setText(`${head}\n${keys}`);
	}

	render(width: number): string[] {
		return this.text.render(width);
	}

	invalidate(): void {
		this.text.invalidate();
	}
}
