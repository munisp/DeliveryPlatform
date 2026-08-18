import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("account lifecycle migration and token safety contracts", () => {
  const root = resolve(import.meta.dirname, "..");

  it("owns lifecycle identity state in a migration with hashed, single-use, expiring tokens", async () => {
    const migration = await readFile(resolve(root, "drizzle/0008_account_lifecycle.sql"), "utf8");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS account_lifecycle_tokens");
    expect(migration).toContain("token_hash CHAR(64) NOT NULL UNIQUE");
    expect(migration).toContain("expires_at TIMESTAMPTZ NOT NULL");
    expect(migration).toContain("consumed_at TIMESTAMPTZ");
    expect(migration).toContain("CHECK (purpose IN ('email_verification', 'password_reset', 'invitation'))");
    expect(migration).toContain("email_verified_at TIMESTAMPTZ");
    expect(migration).toContain("onboarding_completed_at TIMESTAMPTZ");
  });

  it("keeps lifecycle links opaque, hashes tokens before storage, and never returns raw tokens from the API store", async () => {
    const store = await readFile(resolve(root, "server/_core/accountLifecycleStore.ts"), "utf8");

    expect(store).toContain('createHash("sha256").update(token).digest("hex")');
    expect(store).toContain("WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()");
    expect(store).toContain("SET consumed_at = NOW()");
    expect(store).toContain("UPDATE account_lifecycle_tokens SET revoked_at = NOW()");
    expect(store).toContain("async function issueToken");
    expect(store).not.toContain("export async function issueToken");
  });

  it("requires verified active operators for organization creation and tenant-admin authority for invitations", async () => {
    const store = await readFile(resolve(root, "server/_core/accountLifecycleStore.ts"), "utf8");

    expect(store).toContain("verified_active_operator_required");
    expect(store).toContain("tenant_admin_required");
    expect(store).toContain("invited_email_already_belongs_to_another_tenant");
  });

  it("provides an isolated rollback counterpart for the lifecycle migration", async () => {
    const rollback = await readFile(resolve(root, "drizzle/rollback/0008_account_lifecycle.down.sql"), "utf8");

    expect(rollback).toContain("DROP TABLE IF EXISTS account_lifecycle_tokens");
    expect(rollback).toContain("DROP COLUMN IF EXISTS onboarding_completed_at");
  });
});
