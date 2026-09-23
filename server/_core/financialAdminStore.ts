import { eq, and, desc, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  financialInstruments,
  creditNotes,
  creditNoteApplications,
  tokenizationAuditLog,
  users,
} from "../../drizzle/schema";
import { ENV } from "./env";

// ---------------------------------------------------------------------------
// Financial Admin Store — platform-level views over tokenized instruments,
// credit notes, and the tokenization audit trail. Read-only; mutations happen
// in financialCore / paymentProvider.
// ---------------------------------------------------------------------------

export interface InstrumentSummary {
  id: number;
  companyId: number;
  instrumentType: string;
  last4: string | null;
  status: string;
  createdAt: Date;
}

export async function listInstrumentsByCompany(
  companyId: number,
  limit = 100
): Promise<InstrumentSummary[]> {
  const db = getDb();
  if (!db) return [];
  return db
    .select({
      id: financialInstruments.id,
      companyId: financialInstruments.companyId,
      instrumentType: financialInstruments.instrumentType,
      last4: financialInstruments.last4,
      status: financialInstruments.status,
      createdAt: financialInstruments.createdAt,
    })
    .from(financialInstruments)
    .where(eq(financialInstruments.companyId, companyId))
    .orderBy(desc(financialInstruments.createdAt))
    .limit(limit);
}

export async function getCreditNoteWithApplications(creditNoteId: number) {
  const db = getDb();
  if (!db) return null;
  const [note] = await db
    .select()
    .from(creditNotes)
    .where(eq(creditNotes.id, creditNoteId))
    .limit(1);
  if (!note) return null;
  const applications = await db
    .select()
    .from(creditNoteApplications)
    .where(eq(creditNoteApplications.creditNoteId, creditNoteId))
    .orderBy(desc(creditNoteApplications.createdAt));
  return { ...note, applications };
}

export async function getOutstandingCredit(companyId: number): Promise<string> {
  const db = getDb();
  if (!db) return "0";
  const rows = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(amount AS DECIMAL(18,2)) - CAST(applied_amount AS DECIMAL(18,2))), 0)`,
    })
    .from(creditNotes)
    .where(and(eq(creditNotes.companyId, companyId), eq(creditNotes.status, "open")));
  return String(rows[0]?.total ?? "0");
}

export async function getTokenizationAudit(
  companyId: number,
  limit = 200
): Promise<any[]> {
  const db = getDb();
  if (!db) return [];
  return db
    .select()
    .from(tokenizationAuditLog)
    .where(eq(tokenizationAuditLog.companyId, companyId))
    .orderBy(desc(tokenizationAuditLog.createdAt))
    .limit(limit);
}

export async function getFinancialAdminUser(userId: number) {
  const db = getDb();
  if (!db) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

export function isMtlsConfigured(): boolean {
  return Boolean(ENV.mtlsCertPath && ENV.mtlsKeyPath && ENV.mtlsCaPath);
}

export function requireMtlsForPayments(): boolean {
  return ENV.paymentsMtlsRequired;
}
