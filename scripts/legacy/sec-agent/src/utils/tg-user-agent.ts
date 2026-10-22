export function getTgUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `tg/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
