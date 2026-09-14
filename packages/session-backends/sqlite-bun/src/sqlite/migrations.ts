import type { SqliteDatabase } from "./types.ts";

export async function applyInitialSchema(db: SqliteDatabase): Promise<void> {
	const migrationUrl = new URL("./migrations/001_initial.sql", import.meta.url);
	const migration = await Bun.file(Bun.fileURLToPath(migrationUrl)).text();
	db.exec(migration);
}
