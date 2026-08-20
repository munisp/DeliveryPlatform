import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("mission-critical financial immutability contracts", () => {
  it("rejects attempts to rewrite transfer, quote, or refund financial identities before emitting outbox intents", () => {
    const outbox = readFileSync(resolve(root, "services/go/mojaloop/funds_outbox.go"), "utf8");
    expect(outbox).toContain("different immutable financial identity");
    expect(outbox).toContain("mojaloop_transfers.amount_minor IS NOT DISTINCT FROM EXCLUDED.amount_minor");
    expect(outbox).toContain("mojaloop_quotes.fees_minor IS NOT DISTINCT FROM EXCLUDED.fees_minor");
    expect(outbox).toContain("mojaloop_refunds.original_transfer_id IS NOT DISTINCT FROM EXCLUDED.original_transfer_id");
    expect(outbox).toContain("verify refund financial identity");
  });

  it("enforces immutability in PostgreSQL and prevents resource-conflicting idempotency replays", () => {
    const migration = readFileSync(resolve(root, "drizzle/0018_mojaloop_financial_identity_immutability.sql"), "utf8");
    const main = readFileSync(resolve(root, "services/go/mojaloop/main.go"), "utf8");
    expect(migration).toContain("mojaloop_reject_financial_identity_rewrite");
    expect(migration).toContain("trg_mojaloop_transfer_identity_immutable");
    expect(migration).toContain("trg_mojaloop_quote_identity_immutable");
    expect(migration).toContain("trg_mojaloop_refund_identity_immutable");
    expect(main).toContain("idempotency key is already bound to a different resource");
  });

  it("does not count failed refunds as settled reversals in reconciliation totals", () => {
    const main = readFileSync(resolve(root, "services/go/mojaloop/main.go"), "utf8");
    const runtime = readFileSync(resolve(root, "services/go/mojaloop/workflow_runtime.go"), "utf8");
    expect(main).toContain('refund.State != "PENDING_LEDGER" && refund.State != "PENDING" && refund.State != "COMPLETED"');
    expect(runtime).toContain("FROM mojaloop_refunds WHERE state IN ('PENDING_LEDGER','PENDING','COMPLETED')");
  });
});
