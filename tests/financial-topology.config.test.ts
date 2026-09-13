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

  it("keeps the single-node broker below its measured container memory limit", async () => {
    const compose = await readFile(composePath, "utf8");
    const brokerSection = compose.slice(compose.indexOf("  redpanda:"), compose.indexOf("  temporal:"));

    expect(brokerSection).toContain("mem_limit: 1g");
    expect(brokerSection).toContain("- --memory=768M");
  });

  it("uses a writable ephemeral SQLite path for the Temporal development server", async () => {
    const compose = await readFile(composePath, "utf8");
    const temporalSection = compose.slice(compose.indexOf("  temporal:"), compose.indexOf("  mojaloop-api:"));

    expect(temporalSection).toContain("--db-filename /tmp/temporal.db");
    expect(temporalSection).not.toContain("/var/lib/temporal");
  });

  it("provides a loopback-bound Toxiproxy service only for local ledger transport-fault rehearsal", async () => {
    const compose = await readFile(composePath, "utf8");
    const proxySection = compose.slice(compose.indexOf("  toxiproxy:"), compose.indexOf("  postgres:"));

    expect(proxySection).toContain("image: ghcr.io/shopify/toxiproxy:2.12.0");
    expect(proxySection).toContain("network_mode: host");
    expect(proxySection).toContain('command: ["-host", "127.0.0.1"]');
    expect(proxySection).toContain('restart: "no"');
  });
});
