#!/usr/bin/env bun
// Generate per-file .dot diagrams for each .ts file in the model directory.
// Each .dot shows the file's exported types and their dependency relationships.
//
// Usage: bun scripts/generate-dot-diagrams.ts

import * as fs from "node:fs";
import * as path from "node:path";

const modelRoot = path.resolve(import.meta.dir, "../model");
const diagramRoot = path.resolve(modelRoot, "diagrams");

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield full;
  }
}

interface ParsedFile {
  readonly path: string;
  readonly exports: ReadonlyArray<{ readonly name: string; readonly kind: "type" | "interface" | "const" | "class" | "function" | "enum" }>;
  readonly imports: ReadonlyArray<{ readonly specifier: string; readonly names: ReadonlyArray<string> }>;
}

function parseFile(file: string): ParsedFile {
  const src = fs.readFileSync(file, "utf8");
  const exports: { name: string; kind: "type" | "interface" | "const" | "class" | "function" | "enum" }[] = [];
  const imports: { specifier: string; names: string[] }[] = [];

  const exportRegex = /export\s+(?:abstract\s+)?(?:async\s+)?(?:declare\s+)?(type|interface|const|class|function|enum)\s+([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = exportRegex.exec(src)) !== null) {
		exports.push({ name: m[2]!, kind: m[1] as "type" | "interface" | "const" | "class" | "function" | "enum" });
  }

  const importRegex = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
  while ((m = importRegex.exec(src)) !== null) {
		const names = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
		imports.push({ specifier: m[2]!, names });
  }
  return { path: file, exports, imports };
}

function resolveSpecifier(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec);
  return base;
}

function generateDot(file: ParsedFile, byName: ReadonlyMap<string, ReadonlyArray<ParsedFile>>): string {
  const fileName = path.relative(modelRoot, file.path);
  const title = `model/${fileName}`;
  const out: string[] = [];
  out.push(`digraph ${toIdent(fileName.replace(/[^A-Za-z0-9_]/g, "_"))} {`);
  out.push(`  rankdir=LR;`);
  out.push(`  graph [fontname="Helvetica", fontsize=11, label=${escape(title)}];`);
  out.push(`  node  [fontname="Helvetica", fontsize=9, shape=record, style="rounded,filled", fillcolor="#f6f8fa"];`);
  out.push(`  edge  [fontname="Helvetica", fontsize=8];`);
  out.push(`  compound=true;`);
  out.push("");

  // Each exported symbol as a node
  for (const exp of file.exports) {
    out.push(`  ${toIdent(exp.name)} [label=${escape(`${exp.kind}\\n${exp.name}`)}];`);
  }
  out.push("");

  // For each import, link to external file nodes grouped by directory
  const seen = new Set<string>();
  for (const imp of file.imports) {
    const resolved = resolveSpecifier(file.path, imp.specifier);
    if (!resolved) continue;
    const targetName = path.relative(modelRoot, resolved).replace(/\.ts$/, "").replace(/[^A-Za-z0-9_]/g, "_");
    if (seen.has(targetName)) continue;
    seen.add(targetName);
    for (const localExp of file.exports) {
      out.push(`  ${toIdent(localExp.name)} -> ${toIdent(targetName)} [style=dashed, color=gray, label="imports"];`);
      break; // one edge per import is enough
    }
  }
  out.push("}");
  return out.join("\n");
}

function escape(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function toIdent(s: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

const files: ParsedFile[] = [];
for (const f of walk(modelRoot)) {
  if (f.includes("/diagrams/") || f.endsWith("index.ts")) continue; // skip indexes; their per-file content is not unique
  files.push(parseFile(f));
}

const byName = new Map<string, ParsedFile[]>();
for (const f of files) {
  const name = path.relative(modelRoot, f.path).replace(/\.ts$/, "");
  const arr = byName.get(name) ?? [];
  arr.push(f);
  byName.set(name, arr);
}

let count = 0;
for (const file of files) {
  const rel = path.relative(modelRoot, file.path);
  const target = path.join(diagramRoot, rel.replace(/\.ts$/, ".dot"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, generateDot(file, byName));
  count++;
}
console.log(`Generated ${count} per-file .dot diagrams.`);
