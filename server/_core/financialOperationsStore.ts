import { createHash, randomUUID } from "crypto";
import { getPool } from "../db";
import type { OpsActor } from "./logisticsOperationsStore";

type InvoiceState = "draft" | "issued" | "partially_paid" | "paid" | "void" | "overdue";
type DisputeState = "opened" | "under_review" | "resolved_customer" | "resolved_operator" | "rejected" | "closed";
const invoiceTransitions: Record<InvoiceState, ReadonlySet<InvoiceState>> = {
  draft: new Set(["issued", "void"]), issued: new Set(["partially_paid", "paid", "void", "overdue"]), partially_paid: new Set(["paid", "void", "overdue"]), paid: new Set(), void: new Set(), overdue: new Set(["partially_paid", "paid", "void"]),
};
const disputeTransitions: Record<DisputeState, ReadonlySet<DisputeState>> = {
  opened: new Set(["under_review", "resolved_customer", "resolved_operator", "rejected"]), under_review: new Set(["resolved_customer", "resolved_operator", "rejected"]), resolved_customer: new Set(["closed"]), resolved_operator: new Set(["closed"]), rejected: new Set(["closed"]), closed: new Set(),
};

function text(value: unknown, field: string, max: number) { const normalized = `${value ?? ""}`.trim(); if (!normalized || normalized.length > max) throw new Error(`invalid_${field}`); return normalized; }
function uuid(value: unknown, field: string) { const normalized = text(value, field, 64); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) throw new Error(`invalid_${field}`); return normalized; }
function minor(value: unknown, field: string) { const amount = Number(value); if (!Number.isSafeInteger(amount) || amount < 0 || amount > 9_000_000_000_000) throw new Error(`invalid_${field}`); return amount; }
function tenant(actor: OpsActor) { const id = actor.tenantId.trim(); if (!id || id.length > 128) throw new Error("tenant_context_required"); return id; }
function currency(value: unknown) { const code = text(value, "currency", 3).toUpperCase(); if (!/^[A-Z]{3}$/.test(code)) throw new Error("invalid_currency"); return code; }
function requireAdmin(actor: OpsActor & { role?: string | null }) { if (!new Set(["admin", "platform_admin", "super_admin", "operator", "ops"]).has(`${actor.role ?? ""}`.toLowerCase())) throw new Error("financial_operations_role_required"); }

export async function createInvoice(actor: OpsActor & { role?: string | null }, input: { invoiceNumber: unknown; customerReference: unknown; currency: unknown; taxMinor?: unknown; dueAt?: unknown; lines: unknown }) {
  requireAdmin(actor); const tenantId = tenant(actor); const invoiceNumber = text(input.invoiceNumber, "invoice_number", 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{3,62}$/.test(invoiceNumber)) throw new Error("invalid_invoice_number");
  const customerReference = text(input.customerReference, "customer_reference", 160); const currencyCode = currency(input.currency); const taxMinor = input.taxMinor === undefined ? 0 : minor(input.taxMinor, "tax_minor");
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 1000) throw new Error("invalid_invoice_lines");
  const lines = input.lines.map((line, index) => { if (!line || typeof line !== "object" || Array.isArray(line)) throw new Error("invalid_invoice_line"); const entry = line as Record<string, unknown>; const quantity = Number(entry.quantity); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) throw new Error("invalid_invoice_quantity"); const unitAmountMinor = minor(entry.unitAmountMinor, "invoice_unit_amount_minor"); return { lineNo: index + 1, description: text(entry.description, "invoice_line_description", 500), quantity, unitAmountMinor, lineAmountMinor: quantity * unitAmountMinor, metadata: entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata) ? entry.metadata : {} }; });
  const subtotal = lines.reduce((sum, line) => sum + line.lineAmountMinor, 0); const dueAt = input.dueAt === undefined || input.dueAt === null || input.dueAt === "" ? null : new Date(`${input.dueAt}`); if (dueAt && (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now())) throw new Error("invalid_due_at");
  const pool = await getPool(); const client = await pool.connect();
  try { await client.query("BEGIN"); const invoice = await client.query(`INSERT INTO billing.invoice (tenant_id, invoice_number, customer_reference, currency, subtotal_minor, tax_minor, total_minor, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text, invoice_number, state::text, total_minor, currency, due_at, created_at`, [tenantId, invoiceNumber, customerReference, currencyCode, subtotal, taxMinor, subtotal + taxMinor, dueAt, actor.id]); const id = invoice.rows[0].id as string; for (const line of lines) await client.query(`INSERT INTO billing.invoice_line (invoice_id,line_no,description,quantity,unit_amount_minor,line_amount_minor,metadata) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)`, [id, line.lineNo, line.description, line.quantity, line.unitAmountMinor, line.lineAmountMinor, JSON.stringify(line.metadata)]); await client.query("COMMIT"); return { ...invoice.rows[0], lineCount: lines.length }; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function transitionInvoice(actor: OpsActor & { role?: string | null }, input: { invoiceId: unknown; nextState: unknown }) {
  requireAdmin(actor); const invoiceId = uuid(input.invoiceId, "invoice_id"); const nextState = text(input.nextState, "invoice_state", 32) as InvoiceState; if (!(nextState in invoiceTransitions)) throw new Error("invalid_invoice_state"); const pool = await getPool(); const client = await pool.connect();
  try { await client.query("BEGIN"); const current = await client.query("SELECT state::text FROM billing.invoice WHERE id=$1::uuid AND tenant_id=$2 FOR UPDATE", [invoiceId, tenant(actor)]); if (current.rowCount !== 1) throw new Error("invoice_not_found"); const previous = current.rows[0].state as InvoiceState; if (!invoiceTransitions[previous].has(nextState)) throw new Error("invalid_invoice_transition"); const result = await client.query(`UPDATE billing.invoice SET state=$3::billing.invoice_state, issued_at=CASE WHEN $3='issued' THEN NOW() ELSE issued_at END, paid_at=CASE WHEN $3='paid' THEN NOW() ELSE paid_at END, updated_at=NOW() WHERE id=$1::uuid AND tenant_id=$2 RETURNING id::text, state::text, updated_at`, [invoiceId, tenant(actor), nextState]); await client.query("COMMIT"); return result.rows[0]; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function openDispute(actor: OpsActor & { role?: string | null }, input: { invoiceId?: unknown; paymentReference: unknown; disputeType: unknown; amountMinor: unknown; currency: unknown; reason: unknown; evidenceRefs?: unknown }) {
  requireAdmin(actor); const tenantId = tenant(actor); const invoiceId = input.invoiceId === undefined || input.invoiceId === null || input.invoiceId === "" ? null : uuid(input.invoiceId, "invoice_id"); const paymentReference = text(input.paymentReference, "payment_reference", 160); const disputeType = text(input.disputeType, "dispute_type", 96); if (!/^[a-z][a-z0-9_.-]{2,95}$/.test(disputeType)) throw new Error("invalid_dispute_type"); const amountMinor = minor(input.amountMinor, "dispute_amount_minor"); if (!amountMinor) throw new Error("invalid_dispute_amount_minor"); const reason = text(input.reason, "dispute_reason", 2000); const evidenceRefs = input.evidenceRefs === undefined ? [] : input.evidenceRefs; if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 32) throw new Error("invalid_dispute_evidence"); const evidence = evidenceRefs.map((ref) => text(ref, "evidence_ref", 512));
  const pool = await getPool(); const client = await pool.connect();
  try { await client.query("BEGIN"); if (invoiceId) { const invoice = await client.query("SELECT 1 FROM billing.invoice WHERE id=$1::uuid AND tenant_id=$2", [invoiceId, tenantId]); if (invoice.rowCount !== 1) throw new Error("invoice_not_found"); } const dispute = await client.query(`INSERT INTO billing.payment_dispute (tenant_id,invoice_id,payment_reference,dispute_type,amount_minor,currency,reason,opened_by) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8) RETURNING id::text,state::text,created_at`, [tenantId, invoiceId, paymentReference, disputeType, amountMinor, currency(input.currency), reason, actor.id]); const id = dispute.rows[0].id as string; for (const ref of evidence) await client.query("INSERT INTO billing.dispute_evidence (dispute_id,evidence_ref,evidence_digest,submitted_by) VALUES ($1::uuid,$2,$3,$4)", [id, ref, createHash("sha256").update(ref).digest(), actor.id]); await client.query("COMMIT"); return { ...dispute.rows[0], evidenceCount: evidence.length }; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function decideDispute(actor: OpsActor & { role?: string | null }, input: { disputeId: unknown; nextState: unknown; outcomeNote?: unknown }) {
  requireAdmin(actor);
  const id = uuid(input.disputeId, "dispute_id");
  const nextState = text(input.nextState, "dispute_state", 32) as DisputeState;
  if (!(nextState in disputeTransitions)) throw new Error("invalid_dispute_state");
  const outcomeNote = input.outcomeNote === undefined || input.outcomeNote === null ? null : text(input.outcomeNote, "outcome_note", 2000);
  const tenantId = tenant(actor);
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT state::text FROM billing.payment_dispute WHERE id=$1::uuid AND tenant_id=$2 FOR UPDATE", [id, tenantId]);
    if (current.rowCount !== 1) throw new Error("dispute_not_found");
    const previous = current.rows[0].state as DisputeState;
    if (!disputeTransitions[previous].has(nextState)) throw new Error("invalid_dispute_transition");
    const resolved = ["resolved_customer", "resolved_operator", "rejected", "closed"].includes(nextState);
    const result = await client.query(`UPDATE billing.payment_dispute SET state=$3::billing.dispute_state, outcome_note=$4,
      resolved_by=CASE WHEN $5 THEN $6 ELSE resolved_by END, resolved_at=CASE WHEN $5 THEN NOW() ELSE resolved_at END,
      updated_at=NOW() WHERE id=$1::uuid AND tenant_id=$2 RETURNING id::text,state::text,outcome_note,resolved_at`,
    [id, tenantId, nextState, outcomeNote, resolved, actor.id]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function requestReport(actor: OpsActor & { role?: string | null }, input: { reportKind: unknown; filterSpec?: unknown }) { requireAdmin(actor); const reportKind = text(input.reportKind, "report_kind", 32); if (!["invoice_aging","dispute_register","operations_sla"].includes(reportKind)) throw new Error("invalid_report_kind"); const filterSpec = input.filterSpec && typeof input.filterSpec === "object" && !Array.isArray(input.filterSpec) ? input.filterSpec : {}; const pool = await getPool(); const result = await pool.query("INSERT INTO billing.governed_report_export (tenant_id,report_kind,requested_by,filter_spec) VALUES ($1,$2::text,$3,$4::jsonb) RETURNING id::text,state::text,created_at", [tenant(actor), reportKind, actor.id, JSON.stringify(filterSpec)]); return result.rows[0]; }

export async function generateDueReports(limit = 20) { const pool = await getPool(); const client = await pool.connect(); const generated: string[] = []; try { await client.query("BEGIN"); const due = await client.query("SELECT id::text,tenant_id,report_kind FROM billing.governed_report_export WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1", [limit]); for (const report of due.rows) { let data: unknown[] = []; if (report.report_kind === "invoice_aging") data = (await client.query("SELECT invoice_number,state::text,total_minor,currency,due_at FROM billing.invoice WHERE tenant_id=$1 ORDER BY due_at NULLS LAST,created_at DESC LIMIT 1000", [report.tenant_id])).rows; else if (report.report_kind === "dispute_register") data = (await client.query("SELECT payment_reference,dispute_type,state::text,amount_minor,currency,created_at,resolved_at FROM billing.payment_dispute WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1000", [report.tenant_id])).rows; else data = (await client.query("SELECT state::text,count(*)::int AS count FROM operations.work_order WHERE tenant_id=$1 GROUP BY state ORDER BY state", [report.tenant_id])).rows; await client.query("UPDATE billing.governed_report_export SET state='generated', result_payload=$2::jsonb, freshness_at=NOW(), expires_at=NOW() + INTERVAL '7 days', updated_at=NOW() WHERE id=$1::uuid", [report.id, JSON.stringify({ reportKind: report.report_kind, rows: data, generatedAt: new Date().toISOString() })]); generated.push(report.id); } await client.query("COMMIT"); return { generated }; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }

export async function listFinancialOperations(actor: OpsActor & { role?: string | null }) { requireAdmin(actor); const pool = await getPool(); const tenantId = tenant(actor); const [invoices, disputes, reports] = await Promise.all([pool.query("SELECT id::text,invoice_number,customer_reference,currency,state::text,total_minor,due_at,issued_at,paid_at,updated_at FROM billing.invoice WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200", [tenantId]), pool.query("SELECT id::text,payment_reference,dispute_type,amount_minor,currency,state::text,reason,outcome_note,created_at,resolved_at FROM billing.payment_dispute WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200", [tenantId]), pool.query("SELECT id::text,report_kind,state::text,result_payload,freshness_at,expires_at,created_at FROM billing.governed_report_export WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50", [tenantId])]); return { invoices: invoices.rows, disputes: disputes.rows, reports: reports.rows }; }

export function financialOperationsErrorStatus(error: unknown) { const code = error instanceof Error ? error.message : "financial_operations_error"; if (code.includes("not_found")) return { status: 404, code }; if (code.includes("transition") || code.includes("duplicate")) return { status: 409, code }; if (code.startsWith("invalid_") || code.includes("required") || code.includes("role")) return { status: 400, code }; return { status: 503, code: "financial_operations_unavailable" }; }
export function financialOperationId() { return randomUUID(); }
