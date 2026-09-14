#!/usr/bin/env node
/**
 * dead-exports.mjs — dead-export analysis for server/db.ts (H-1).
 *
 * Method:
 *  1. Parse server/db.ts for top-level `export (async )?function|const|class|let|type` symbols.
 *  2. Walk the repo (excluding node_modules, .git, dist, and db.ts itself) and
 *     count occurrences of each symbol as a bare identifier (word-boundary match).
 *     This catches static imports, re-exports, dynamic string-based router maps,
 *     and test references alike — anything that mentions the identifier keeps it.
 *  3. A symbol with zero occurrences outside db.ts is DEAD.
 *
 * Usage:
 *   node scripts/testing/dead-exports.mjs            # human report
 *   node scripts/testing/dead-exports.mjs --json     # machine-readable
 *   node scripts/testing/dead-exports.mjs --check    # exit 1 if dead exports exist (CI)
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DB = path.join(root, "server/db.ts");

const src = readFileSync(DB, "utf8");
const lines = src.split("\n");
const exportRe = /^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/;
const typeRe = /^export\s+type\s+([A-Za-z_$][\w$]*)/;

const symbols = [];
lines.forEach((line, i) => {
  const m = line.match(exportRe);
  if (m) symbols.push({ name: m[1], line: i + 1, kind: "value" });
  const t = line.match(typeRe);
  if (t) symbols.push({ name: t[1], line: i + 1, kind: "type" });
});

// All tracked files except db.ts itself.
const files = execSync("git ls-files", { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && f !== "server/db.ts" && !f.startsWith("node_modules/"))
  .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json|md)$/.test(f));

// Concatenate searchable text once per symbol via grep -F on the whole set.
const fileArgs = files.map((f) => `"${f}"`).join(" ");
const results = symbols.map((sym) => {
  let count = 0;
  let hits = [];
  try {
    const out = execSync(
      `grep -nE '\\b${sym.name}\\b' ${fileArgs} || true`,
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    hits = out.split("\n").filter(Boolean);
    count = hits.length;
  } catch {
    count = 0;
  }
  return { ...sym, externalRefs: count, sampleHits: hits.slice(0, 5) };
});

const dead = results.filter((r) => r.externalRefs === 0);
const alive = results.filter((r) => r.externalRefs > 0);

const args = process.argv.slice(2);
if (args.includes("--json")) {
  console.log(JSON.stringify({ total: results.length, dead, alive: alive.map((a) => a.name) }, null, 2));
} else {
  console.log(`server/db.ts exports: ${results.length} (${results.filter((r) => r.kind === "type").length} types)`);
  console.log(`alive (referenced outside db.ts): ${alive.length}`);
  console.log(`dead  (zero external references):   ${dead.length}`);
  console.log("\n--- DEAD ---");
  for (const d of dead) console.log(`  L${d.line}\t${d.kind}\t${d.name}`);
}
if (args.includes("--check")) process.exit(dead.length ? 1 : 0);
