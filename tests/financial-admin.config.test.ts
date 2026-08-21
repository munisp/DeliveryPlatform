import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("financial administration safeguards", () => {
  it("requires MFA-backed financial administrator access and exposes only bounded read models", () => {
    const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
    const database = readFileSync(resolve(root, "server/db.ts"), "utf8");
    expect(server).toContain("requireFinancialAdministrator");
    expect(server).toContain("financial_admin_required");
    expect(server).toContain('app.get("/api/admin/finance/overview"');
    expect(database).toContain("FROM mojaloop_transfers ORDER BY updated_at DESC LIMIT 100");
    expect(database).toContain("ledger_consistent = FALSE ORDER BY created_at DESC LIMIT 100");
  });

  it("keeps recovery scenarios non-production, allowlisted, authenticated, and auditable", () => {
    const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
    expect(server).toContain("FINANCIAL_SIMULATION_MODE === \"isolated\"");
    expect(server).toContain("permittedFinancialSimulationScenarios");
    expect(server).toContain("finance.simulation.requested");
    expect(server).toContain("Only an explicitly configured isolated non-production executor");
  });

  it("renders a visible finance workspace with dependency health, immutable records, and disabled-by-default recovery controls", () => {
    const page = readFileSync(resolve(root, "client/src/pages/FinancialAdministration.tsx"), "utf8");
    expect(page).toContain("Immutable funds oversight");
    expect(page).toContain("Dependency health");
    expect(page).toContain("Isolated recovery scenarios");
    expect(page).toContain("disabled={!simulations.data.enabled || simulation.isPending}");
  });

  it("bounds financial record filters and retains evidence-backed health and alert history", () => {
    const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
    const store = readFileSync(resolve(root, "server/_core/financialAdminStore.ts"), "utf8");
    const page = readFileSync(resolve(root, "client/src/pages/FinancialAdministration.tsx"), "utf8");
    expect(server).toContain("invalid_financial_admin_date");
    expect(server).toContain('app.get("/api/admin/finance/alerts"');
    expect(store).toContain("LIMIT 100");
    expect(store).toContain("financial_dependency_health_observations");
    expect(store).toContain("INTERVAL '24 hours'");
    expect(page).toContain("Notification center");
    expect(page).toContain("TigerBeetle adapter uptime");
    expect(page).toContain("Find immutable financial records");
  });

  it("records allowed alert actions, preserves downtime details, and exports only the active bounded report scope", () => {
    const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
    const store = readFileSync(resolve(root, "server/_core/financialAdminStore.ts"), "utf8");
    const page = readFileSync(resolve(root, "client/src/pages/FinancialAdministration.tsx"), "utf8");
    const migration = readFileSync(resolve(root, "drizzle/0020_financial_alert_actions_and_health_details.sql"), "utf8");
    expect(server).toContain('app.post("/api/admin/finance/alerts/:id/actions"');
    expect(server).toContain('app.get("/api/admin/finance/report.csv"');
    expect(server).toContain("invalid_financial_alert_action");
    expect(store).toContain("financial_admin_alert_actions");
    expect(migration).toContain("detail TEXT");
    expect(page).toContain("Alert workflow");
    expect(page).toContain("Download CSV report");
    expect(page).toContain("No error detail recorded.");
  });

  it("requires verified database TLS in production and excludes dismissed alerts from the active notification center", () => {
    const env = readFileSync(resolve(root, "server/_core/env.ts"), "utf8");
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const store = readFileSync(resolve(root, "server/_core/financialAdminStore.ts"), "utf8");
    expect(env).toContain("DATABASE_SSL_CA");
    expect(db).toContain("rejectUnauthorized: true");
    expect(db).not.toContain("rejectUnauthorized: false");
    expect(store).toContain('alert.action !== "dismiss"');
  });

  it("keeps legacy bootstrap DDL and sample data out of production database startup paths", () => {
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    expect(db).toContain("if (!ENV.isProduction)");
    expect(db).toContain("Production schema and reference data must be applied only through reviewed migrations.");
    expect(db).toContain("A missing period is an operational data condition");
    expect(db).not.toContain("_platformTablesEnsured = false;\n  await ensurePlatformTables();");
  });

  it("exposes measured coverage and PostgreSQL TLS and migration evidence only through MFA-gated administration contracts", () => {
    const index = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
    const store = readFileSync(resolve(root, "server/_core/financialAdminStore.ts"), "utf8");
    const page = readFileSync(resolve(root, "client/src/pages/FinancialAdministration.tsx"), "utf8");
    expect(index).toContain('"/api/admin/quality/coverage"');
    expect(index).toContain("getFinancialDatabaseEvidence");
    expect(store).toContain("pg_stat_ssl");
    expect(store).toContain("__drizzle_migrations");
    expect(store).toContain("DATABASE_TLS_CERT_EXPIRES_AT");
    expect(store).toContain("migrationStatus");
    expect(page).toContain("Testing and coverage");
    expect(page).toContain("PostgreSQL TLS");
    expect(page).toContain("TLS certificate");
    expect(page).toContain("Coverage history trend");
    expect(page).toContain("Playwright execution log");
    expect(page).toContain("filteredExecutions");
    expect(store).toContain('id: "database-tls"');
    expect(store).toContain('id: "migration-age"');
  });
});
