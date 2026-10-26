import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@OnePanda-TgSec/tg-tui";

/** Wrap text in one SGR pair; raw codes keep the shell independent of terminal color detection. */
function sgr(open: string, close: string): (text: string) => string {
	return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}

/** The shell's palette. Every helper is idempotent around plain text and nests without leaking. */
export const tgSecStyle = {
	bold: sgr("1", "22"),
	dim: sgr("2", "22"),
	italic: sgr("3", "23"),
	underline: sgr("4", "24"),
	strike: sgr("9", "29"),
	inverse: sgr("7", "27"),
	red: sgr("31", "39"),
	green: sgr("32", "39"),
	yellow: sgr("33", "39"),
	blue: sgr("34", "39"),
	magenta: sgr("35", "39"),
	cyan: sgr("36", "39"),
	gray: sgr("90", "39"),
	white: sgr("97", "39"),
};

export const tgSecMarkdownTheme: MarkdownTheme = {
	heading: (text) => tgSecStyle.bold(tgSecStyle.cyan(text)),
	link: (text) => tgSecStyle.underline(tgSecStyle.blue(text)),
	linkUrl: (text) => tgSecStyle.dim(text),
	code: (text) => tgSecStyle.yellow(text),
	codeBlock: (text) => text,
	codeBlockBorder: (text) => tgSecStyle.gray(text),
	quote: (text) => tgSecStyle.italic(tgSecStyle.gray(text)),
	quoteBorder: (text) => tgSecStyle.gray(text),
	hr: (text) => tgSecStyle.gray(text),
	listBullet: (text) => tgSecStyle.cyan(text),
	bold: (text) => tgSecStyle.bold(text),
	italic: (text) => tgSecStyle.italic(text),
	strikethrough: (text) => tgSecStyle.strike(text),
	underline: (text) => tgSecStyle.underline(text),
};

const selectList: SelectListTheme = {
	selectedPrefix: (text) => tgSecStyle.cyan(text),
	selectedText: (text) => tgSecStyle.bold(text),
	description: (text) => tgSecStyle.gray(text),
	scrollInfo: (text) => tgSecStyle.gray(text),
	noMatch: (text) => tgSecStyle.gray(text),
};

export const tgSecEditorTheme: EditorTheme = {
	borderColor: (text) => tgSecStyle.gray(text),
	selectList,
};
