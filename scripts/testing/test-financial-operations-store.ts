import assert from "node:assert/strict";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
Object.assign(process.env, {
  DATABASE_URL: databaseUrl, NODE_ENV: "production", INTERNAL_SERVICE_TOKEN: "financial-operations-test-token-0123456789",
  SESSION_SECRET: "financial-operations-session-secret-0123456789", JWT_SECRET: "financial-operations-jwt-secret-0123456789",
  OAUTH_SERVER_URL: "https://identity.test", PUBLIC_APP_ORIGIN: "https://operator.test", BOOTSTRAP_OPERATOR_PASSWORD: "financial-operations-bootstrap-password-0123456789",
  PERMIFY_ENDPOINT: "https://permify.test", PERMIFY_AUTH_TOKEN: "financial-operations-permify-token-0123456789", OPA_ENDPOINT: "https://opa.test", OPA_AUTH_TOKEN: "financial-operations-opa-token-0123456789", ALLOWED_ORIGINS: "https://operator.test",
});
const { getPool } = await import("../../server/db");
const { createInvoice, decideDispute, generateDueReports, listFinancialOperations, openDispute, requestReport, transitionInvoice } = await import("../../server/_core/financialOperationsStore");
const actor = { id: 44, tenantId: "tenant-finance-test", role: "admin" };
const draft = await createInvoice(actor, { invoiceNumber: "LAG-9001", customerReference: "customer-verified-reference", currency: "NGN", taxMinor: 750, dueAt: new Date(Date.now() + 86_400_000).toISOString(), lines: [{ description: "Independent dispatch service", quantity: 2, unitAmountMinor: 12500 }, { description: "Compliance workflow surcharge", quantity: 1, unitAmountMinor: 2500 }] });
assert.equal(Number(draft.total_minor), 28250); assert.equal(draft.lineCount, 2);
await assert.rejects(() => transitionInvoice(actor, { invoiceId: draft.id, nextState: "paid" }), /invalid_invoice_transition/);
const issued = await transitionInvoice(actor, { invoiceId: draft.id, nextState: "issued" }); assert.equal(issued.state, "issued");
const paymentReference = "verified-payment-reference-9001";
const dispute = await openDispute(actor, { invoiceId: draft.id, paymentReference, disputeType: "customer_payment_dispute", amountMinor: 28250, currency: "NGN", reason: "Customer submitted a complete transaction evidence pack.", evidenceRefs: ["s3://approved-evidence/disputes/9001/payment-proof.json"] });
assert.equal(dispute.state, "opened"); assert.equal(dispute.evidenceCount, 1);
const reviewing = await decideDispute(actor, { disputeId: dispute.id, nextState: "under_review", outcomeNote: "Case assigned to independent reviewer." }); assert.equal(reviewing.state, "under_review");
const resolved = await decideDispute(actor, { disputeId: dispute.id, nextState: "resolved_customer", outcomeNote: "Provider verification supports a customer adjustment." }); assert.equal(resolved.state, "resolved_customer");
const report = await requestReport(actor, { reportKind: "invoice_aging", filterSpec: { currency: "NGN" } }); assert.equal(report.state, "queued");
const generated = await generateDueReports(); assert.ok(generated.generated.includes(report.id));
const snapshot = await listFinancialOperations(actor); assert.equal(snapshot.invoices.length, 1); assert.equal(snapshot.disputes.length, 1); assert.equal(snapshot.reports[0]?.state, "generated"); assert.equal((snapshot.reports[0]?.result_payload as { rows?: unknown[] })?.rows?.length, 1);
const pool = await getPool(); const evidence = await pool.query("SELECT count(*)::int AS count FROM billing.dispute_evidence"); assert.equal(evidence.rows[0]?.count, 1); await pool.end(); process.stdout.write("Financial operations store test passed.\n");
