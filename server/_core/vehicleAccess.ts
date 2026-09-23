import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db";
import { vehicles, users, companyMembers } from "../../drizzle/schema";

// ---------------------------------------------------------------------------
// Vehicle Access Control — determines whether a user may view or mutate a
// vehicle record. Roles: platform admin > company admin/manager > driver
// (assigned vehicles only) > viewer (read-only).
// ---------------------------------------------------------------------------

export type VehicleAccessLevel = "none" | "read" | "write" | "admin";

interface AccessContext {
  userId: number;
  role: string;
  companyId: number | null;
}

export async function getVehicleAccessLevel(
  ctx: AccessContext,
  vehicleId: number
): Promise<VehicleAccessLevel> {
  const db = getDb();
  if (!db) return "none";

  if (ctx.role === "admin" || ctx.role === "super_admin") return "admin";

  const [vehicle] = await db
    .select({ id: vehicles.id, companyId: vehicles.companyId, assignedDriverId: vehicles.assignedDriverId })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId))
    .limit(1);

  if (!vehicle) return "none";
  if (ctx.companyId == null || vehicle.companyId !== ctx.companyId) return "none";

  if (ctx.role === "company_admin" || ctx.role === "manager") return "write";

  if (ctx.role === "driver") {
    return vehicle.assignedDriverId === ctx.userId ? "write" : "read";
  }

  return "read";
}

export async function canAccessVehicle(
  ctx: AccessContext,
  vehicleId: number,
  required: VehicleAccessLevel = "read"
): Promise<boolean> {
  const level = await getVehicleAccessLevel(ctx, vehicleId);
  const rank: Record<VehicleAccessLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };
  return rank[level] >= rank[required];
}

/**
 * Batch variant: returns the set of vehicle IDs (from the input list) the
 * user can access at the required level. Single query, avoids N+1.
 */
export async function filterAccessibleVehicles(
  ctx: AccessContext,
  vehicleIds: number[],
  required: VehicleAccessLevel = "read"
): Promise<number[]> {
  const db = getDb();
  if (!db || vehicleIds.length === 0) return [];
  if (ctx.role === "admin" || ctx.role === "super_admin") return vehicleIds;
  if (ctx.companyId == null) return [];

  const rows = await db
    .select({ id: vehicles.id, assignedDriverId: vehicles.assignedDriverId })
    .from(vehicles)
    .where(
      and(
        eq(vehicles.companyId, ctx.companyId),
        sql`${vehicles.id} IN (${sql.join(vehicleIds.map((id) => sql`${id}`), sql`, `)})`
      )
    );

  if (required === "read" || ctx.role === "company_admin" || ctx.role === "manager") {
    return rows.map((r) => r.id);
  }

  if (ctx.role === "driver") {
    return rows.filter((r) => r.assignedDriverId === ctx.userId).map((r) => r.id);
  }

  return rows.map((r) => r.id);
}

export async function listCompanyVehicleIds(companyId: number, limit = 1000): Promise<number[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.companyId, companyId))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function isCompanyMember(userId: number, companyId: number): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const rows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(companyMembers)
    .where(and(eq(companyMembers.userId, userId), eq(companyMembers.companyId, companyId)));
  return Number(rows[0]?.count ?? 0) > 0;
}
