#!/usr/bin/env bun

const scriptDir = import.meta.dir;
const packageDir = `${scriptDir}/..`;
const distDir = `${packageDir}/dist`;
const migrationSourceDir = `${packageDir}/src/sqlite/migrations`;
const migrationDestDir = `${distDir}/sqlite/migrations`;

async function clean() {
	await Bun.$`rm -rf ${distDir}`;
}

async function copySqliteMigrations() {
	await Bun.$`mkdir -p ${migrationDestDir}`;
	await Bun.$`cp -R ${migrationSourceDir}/. ${migrationDestDir}`;
}

const command = Bun.argv[2];

if (command === "clean") {
	await clean();
	process.exit(0);
}

if (command === "copy-sqlite-migrations") {
	await copySqliteMigrations();
	process.exit(0);
}

console.error("Usage: node scripts/prepare-dist.mjs <clean|copy-sqlite-migrations>");
process.exit(1);
