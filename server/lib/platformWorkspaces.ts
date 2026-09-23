import { getDb } from "../db";
import { users, companies } from "../../drizzle/schema";
import { eq, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Platform Workspace Registry
// Virtual workspaces exposed to platform (super-admin) users. Each workspace
// aggregates cross-company data for a functional domain (Finance, Operations,
// Safety, Compliance, Analytics).
// ---------------------------------------------------------------------------

export interface PlatformWorkspace {
  id: string;
  name: string;
  domain: "finance" | "operations" | "safety" | "compliance" | "analytics";
  description: string;
}

export const PLATFORM_WORKSPACES: PlatformWorkspace[] = [
  {
    id: "platform.finance",
    name: "Platform Finance",
    domain: "finance",
    description: "Cross-company payments, payouts, tokenized instruments, ledger summaries.",
  },
  {
    id: "platform.operations",
    name: "Platform Operations",
    domain: "operations",
    description: "Fleet, scans, jobs, routes, and operational throughput.",
  },
  {
    id: "platform.safety",
    name: "Platform Safety",
    domain: "safety",
    description: "Safety scores, incident trends, and compliance posture.",
  },
  {
    id: "platform.analytics",
    name: "Platform Analytics",
    domain: "analytics",
    description: "Lakehouse telemetry, event streams, and aggregated metrics.",
  },
];

export function listPlatformWorkspaces(): PlatformWorkspace[] {
  return PLATFORM_WORKSPACES;
}

export function getPlatformWorkspace(id: string): PlatformWorkspace | undefined {
  return PLATFORM_WORKSPACES.find((w) => w.id === id);
}

/**
 * Aggregate high-level counts used by platform workspace dashboards.
 * Uses a single round-trip with scalar subqueries to avoid N+1.
 */
export async function getPlatformOverview() {
  const db = getDb();
  if (!db) {
    return { totalCompanies: 0, totalUsers: 0, activeCompanies: 0 };
  }
  const rows = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM companies) AS total_companies,
      (SELECT COUNT(*) FROM companies WHERE status = 'active') AS active_companies,
      (SELECT COUNT(*) FROM users) AS total_users
  `);
  const row: any = Array.isArray(rows) ? rows[0] : (rows as any)?.rows?.[0] ?? {};
  const pick = (r: any) => ({
    totalCompanies: Number(r.total_companies ?? r.totalCompanies ?? 0),
    activeCompanies: Number(r.active_companies ?? r.activeCompanies ?? 0),
    totalUsers: Number(r.total_users ?? r.totalUsers ?? 0),
  });
  if (Array.isArray(row)) return pick(row[0] ?? {});
  return pick(row);
}

export async function listCompaniesMinimal(limit = 200) {
  const db = getDb();
  if (!db) return [];
  return db
    .select({
      id: companies.id,
      name: companies.name,
      status: companies.status,
      createdAt: companies.createdAt,
    })
    .from(companies)
    .limit(limit);
}

export async function getCompanyMemberCount(companyId: number): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .where(eq(users.companyId, companyId));
  return Number(rows[0]?.count ?? 0);
}
