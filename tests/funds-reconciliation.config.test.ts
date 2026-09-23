import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8");

// Enum value sets mirrored from drizzle/0000_jittery_pride.sql (+ 0094).
// These are the ONLY values PostgreSQL will accept in comparisons against
// transactions.type / transactions.status; anything else fails at parse
// time with `invalid input value for enum ...` and 500s the endpoint —
// the exact defect that kept fundsReconciliation dark (W6).
const TRANSACTION_TYPE_VALUES = new Set([
  "payment",
  "refund",
  "payout",
  "settlement",
  "commission",
  "chargeback", // added by drizzle/0094_transaction_type_chargeback.sql
]);
const TRANSACTION_STATUS_VALUES = new Set([
  "pending",
  "completed",
  "failed",
  "cancelled",
]);

/** SQL template literals in db.ts that read from public.transactions. */
function transactionSqlChunks(db: string): string[] {
  return db
    .split("`")
    .filter(
      (chunk) =>
        /FROM\s+transactions[\s\n]/.test(chunk) ||
        /FROM\s+transactions$/.test(chunk.trimEnd()),
    );
}

function literalsFor(column: "type" | "status", sql: string): string[] {
  const out: string[] = [];
  // Lookbehind excludes compound identifiers like entry_type/ticket_status.
  const eq = new RegExp(
    `(?<![a-zA-Z_])${column}\\s*=\\s*'([a-z_]+)'`,
    "g",
  );
  const inList = new RegExp(
    `(?<![a-zA-Z_])${column}\\s+IN\\s*\\(([^)]*)\\)`,
    "g",
  );
  for (const m of sql.matchAll(eq)) out.push(m[1]);
  for (const m of sql.matchAll(inList)) {
    for (const lit of m[1].matchAll(/'([a-z_]+)'/g)) out.push(lit[1]);
  }
  return out;
}

describe("W6 funds reconciliation: transactions enum literal contract", () => {
  it("migration 0094 adds 'chargeback' to transaction_type idempotently", () => {
    const migrations = readdirSync(resolve(root, "drizzle")).filter((f) =>
      f.startsWith("0094"),
    );
    expect(migrations.length).toBe(1);
    const sql = source(`drizzle/${migrations[0]}`);
    expect(sql).toMatch(
      /ALTER\s+TYPE\s+transaction_type\s+ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'chargeback'/i,
    );
    // Single statement, no explicit transaction wrapper (ADD VALUE is
    // forbidden inside BEGIN/COMMIT on PostgreSQL < 12).
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
  });

  it("every transactions.type literal in db.ts is a valid transaction_type value", () => {
    const db = source("server/db.ts");
    const chunks = transactionSqlChunks(db);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      for (const lit of literalsFor("type", chunk)) {
        expect(
          TRANSACTION_TYPE_VALUES.has(lit),
          `invalid transaction_type literal '${lit}' in: ${chunk.slice(0, 120)}...`,
        ).toBe(true);
      }
    }
  });

  it("every transactions.status literal in db.ts is a valid transaction_status value", () => {
    const db = source("server/db.ts");
    const chunks = transactionSqlChunks(db);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      for (const lit of literalsFor("status", chunk)) {
        expect(
          TRANSACTION_STATUS_VALUES.has(lit),
          `invalid transaction_status literal '${lit}' in: ${chunk.slice(0, 120)}...`,
        ).toBe(true);
      }
    }
  });

  it("funds snapshot guards the driver_incentives leg with to_regclass", () => {
    const db = source("server/db.ts");
    // The incentives table has no DDL in this schema; the leg must probe
    // the catalog and substitute a zeroed result when the table is absent.
    expect(db).toContain("to_regclass('public.driver_incentives')");
    expect(db).toContain("incentivesTableExists");
  });
});
