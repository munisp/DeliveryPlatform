import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const composePath = new URL("../deploy/testing/docker-compose.financial-rehearsal.yml", import.meta.url);

describe("isolated financial topology configuration", () => {
  it("gives the migration client an explicit PostgreSQL connection contract", async () => {
    const compose = await readFile(composePath, "utf8");
    const migrationSection = compose.slice(compose.indexOf("  migrate:"), compose.indexOf("  tigerbeetle-0:"));

    expect(migrationSection).toContain("PGHOST: postgres");
    expect(migrationSection).toContain('PGPORT: "5432"');
    expect(migrationSection).toContain("PGUSER: financial_rehearsal");
    expect(migrationSection).toContain("PGPASSWORD:");
    expect(migrationSection).toContain("PGDATABASE: financial_rehearsal");
    expect(migrationSection).toContain("psql -v ON_ERROR_STOP=1 -f /migrations/0006.sql");
    expect(migrationSection).not.toContain("DATABASE_URL:");
  });
});
