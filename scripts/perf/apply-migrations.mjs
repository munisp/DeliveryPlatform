#!/usr/bin/env node
/**
 * apply-migrations.mjs — apply drizzle/0000–NNNN migrations to a scratch
 * PostgreSQL (pgserver PG16) with the documented perf-harness stubs.
 *
 * Stubs (see /perf/migration_report.json "stub_notes"):
 *   - CREATE EXTENSION pgcrypto/postgis/citext/btree_gist dropped
 *     (gen_random_uuid() is builtin in PG16; citext becomes a DOMAIN over text)
 *   - geometry/geography column types rewritten to text
 *   - ST_* CHECK constraints and USING gist indexes dropped
 *   - EXCLUDE USING gist constraints dropped (0050, 0058)
 *   - public.gen_random_uuid() unqualified
 *   - SET check_function_bodies = off so SQL-language functions referencing
 *     postgis ST_* still create (their bodies only run where stubbed away)
 *
 * Usage:
 *   DATABASE_URL='postgresql://postgres@/deliveryplatform?host=/tmp/pgdata-perf' \
 *     node scripts/perf/apply-migrations.mjs [--dir drizzle]
 *
 * Exits non-zero and prints the failing file + error on the first failure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const drizzleDir = resolve(repoRoot, process.argv.includes("--dir")
  ? process.argv[process.argv.indexOf("--dir") + 1]
  : "drizzle");

const databaseUrl =
  process.env.PERF_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres@/deliveryplatform?host=/tmp/pgdata-perf";

/** Apply the documented stub transforms to one migration file's SQL. */
export function stubTransform(sql) {
  let out = sql;
  // 1. Drop CREATE EXTENSION statements (pgcrypto/postgis/citext/btree_gist).
  out = out.replace(
    /^\s*CREATE EXTENSION[^;]*;/gim,
    "-- [perf-harness stub] CREATE EXTENSION dropped",
  );
  // 2. gen_random_uuid is builtin in PG16 — drop public. qualification.
  out = out.replace(/\bpublic\.gen_random_uuid\s*\(/gi, "gen_random_uuid(");
  // 3. postgis types -> text (qualified refs inside plpgsql bodies first).
  out = out.replace(/\bpublic\.geography\b/gi, "text");
  out = out.replace(/\bpublic\.geometry\b/gi, "text");
  out = out.replace(/\bgeography\s*\([^)]*\)/gi, "text");
  out = out.replace(/\bgeometry\s*\([^)]*\)/gi, "text");
  // 4. Drop gist index statements (may span two lines).
  out = out.replace(
    /CREATE\s+INDEX\s+[^;]*?USING\s+gist[^;]*?;/gis,
    "-- [perf-harness stub] gist index dropped;",
  );
  // 5. Drop EXCLUDE USING gist table elements (element continues onto a WHERE line).
  out = out.replace(
    /^[ \t]*EXCLUDE\s+USING\s+gist\b[^\n]*(\n[ \t]*WHERE[^\n]*)?/gim,
    "",
  );
  // 6. Drop ST_* CHECK table elements (single-line in all affected migrations).
  out = out.replace(
    /^[ \t]*CHECK\s*\([^\n]*\bST_[A-Za-z]+\([^\n]*\),?[ \t]*\n?/gim,
    "",
  );
  // 7. Repair trailing commas left before a closing paren by the drops above.
  out = out.replace(/,(\s*\n\s*\))/g, "$1");
  return out;
}

const PREAMBLE = `
-- citext stub: DOMAIN over text (pgserver has no citext extension)
DO $$ BEGIN CREATE DOMAIN citext AS text; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- SQL-language function bodies referencing postgis ST_* must not be
-- validated at creation time (the stubs rewrite geometry/geography to text).
SET check_function_bodies = off;
`;

async function main() {
  const files = readdirSync(drizzleDir)
    .filter((f) => /^\d{4}[a-z]?_.*\.sql$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${drizzleDir}`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const results = [];
  try {
    await client.query(PREAMBLE);
    for (const file of files) {
      const raw = readFileSync(join(drizzleDir, file), "utf8");
      const sql = stubTransform(raw);
      try {
        await client.query(sql);
        results.push({ file, status: "ok" });
      } catch (err) {
        results.push({ file, status: "failed", error: err.message });
        console.error(`[apply-migrations] FAILED ${file}: ${err.message}`);
        console.log(JSON.stringify({ results }, null, 2));
        process.exitCode = 1;
        return;
      }
    }
  } finally {
    await client.end();
  }
  const ok = results.filter((r) => r.status === "ok").length;
  console.log(`[apply-migrations] applied ${ok}/${results.length} migrations from ${drizzleDir}`);
  console.log(JSON.stringify({ ok, total: results.length, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
