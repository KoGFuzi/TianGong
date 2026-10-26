import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, Text } from "@OnePanda-TgSec/tg-tui";
import { tgSecStyle } from "./theme.ts";

/** The picker keeps one screen of rows; the index moves a window over the full result list. */
const MAX_VISIBLE = 10;

/** Fuzzy matches over the item text; an empty query keeps the original order. */
export function filterPickerItems<T>(items: readonly T[], query: string, getText: (item: T) => string): T[] {
	return fuzzyFilter([...items], query, getText);
}

/** Move a list index with wrapping, so the first item follows the last in both directions. */
export function movePickerIndex(current: number, length: number, delta: number): number {
	if (length <= 0) return 0;
	const next = (current + delta) % length;
	return next < 0 ? next + length : next;
}

export type PickerOptions<T> = {
	readonly title: string;
	readonly items: readonly T[];
	readonly getText: (item: T) => string;
	readonly getDescription?: (item: T) => string | undefined;
	readonly query?: string;
	readonly onSelect: (item: T) => void;
	readonly onCancel: () => void;
};

/**
 * A searchable list overlay. `SelectList` filters by prefix only, so this component owns the fuzzy
 * filter and the selection index instead: typing re-filters and resets to the first row, arrows
 * move, enter confirms, escape cancels. The caller hides the overlay handle in both callbacks.
 */
export class Picker<T> extends Container implements Focusable {
	private readonly items: readonly T[];
	private readonly getText: (item: T) => string;
	private readonly getDescription: ((item: T) => string | undefined) | undefined;
	private readonly onSelect: (item: T) => void;
	private readonly onCancel: () => void;
	private readonly search: Input;
	private readonly body = new Text("", 1, 0);
	private visible: T[] = [];
	private index = 0;
	private focusState = false;

	constructor(options: PickerOptions<T>) {
		super();
		this.items = options.items;
		this.getText = options.getText;
		this.getDescription = options.getDescription;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.search = new Input({ prompt: "> ", placeholder: "type to filter" });
		if (options.query !== undefined && options.query !== "") this.search.setValue(options.query);
		this.addChild(new Text(tgSecStyle.bold(tgSecStyle.cyan(options.title)), 1, 0));
		this.addChild(this.search);
		this.addChild(this.body);
		this.addChild(new Text(tgSecStyle.dim("up/down move  enter select  esc cancel"), 1, 0));
		this.refresh();
	}

	get focused(): boolean {
		return this.focusState;
	}

	set focused(value: boolean) {
		this.focusState = value;
		this.search.focused = value;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.move(-MAX_VISIBLE);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.move(MAX_VISIBLE);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.confirm();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		const before = this.search.getValue();
		this.search.handleInput(data);
		if (this.search.getValue() !== before) {
			this.index = 0;
			this.refresh();
		}
	}

	private move(delta: number): void {
		if (this.visible.length === 0) return;
		this.index = movePickerIndex(this.index, this.visible.length, delta);
		this.refresh();
	}

	private confirm(): void {
		const item = this.visible[this.index];
		if (item !== undefined) this.onSelect(item);
	}

	private refresh(): void {
		this.visible = filterPickerItems(this.items, this.search.getValue(), this.getText);
		this.index = this.visible.length === 0 ? 0 : Math.min(this.index, this.visible.length - 1);
		this.body.setText(this.rows().join("\n"));
	}

	private rows(): string[] {
		if (this.visible.length === 0) return [tgSecStyle.dim("no matches")];
		const start = Math.max(0, Math.min(this.index - Math.floor(MAX_VISIBLE / 2), this.visible.length - MAX_VISIBLE));
		return this.visible.slice(start, start + MAX_VISIBLE).map((item, offset) => {
			const position = start + offset;
			const marker = position === this.index ? tgSecStyle.cyan("> ") : "  ";
			const text = this.getText(item);
			const label = position === this.index ? tgSecStyle.bold(text) : text;
			const description = this.getDescription?.(item);
			return `${marker}${label}${description === undefined ? "" : `  ${tgSecStyle.dim(description)}`}`;
		});
	}
}
