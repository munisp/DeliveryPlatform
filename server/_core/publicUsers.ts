import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import type { SessionUser } from "./trpc";

/**
 * Shared public.users identity helpers.
 *
 * `public.users.id` is the single domain subject platform-wide: courier
 * domain tables (`drivers`, `vehicle_access.*`, `mobility.*`), the
 * operations `created_by` columns (drizzle/0028), the financial
 * `mojaloop_is_financial_administrator` checks (drizzle/0056) and the
 * role-scoped tracking functions (drizzle/0066) all key on it.
 *
 * Sessions are still issued against `operator_credentials` (per-credential
 * openId `operator:<credentialId>`, bootstrap-owner fallback on
 * ENV.ownerOpenId) or arrive as external OIDC JWTs. resolvePublicUser maps
 * either flavor onto the caller's `public.users` row; unifySessionUser
 * rewrites the session identity so `SessionUser.id` IS the public users id
 * while the operator credential id and openId remain available for
 * audit/attribution.
 */

export type LinkedPublicUser = {
  id: number;
  link: "open_id" | "email" | "created";
};

/**
 * Resolve (or ensure) the caller's row in `public.users`.
 *
 * Match by open_id first (rank 0), then by case-insensitive email (rank 1).
 * When no row exists yet, one is provisioned from the session identity so
 * the caller always operates inside the public.users ID space. The
 * `ON CONFLICT (open_id) DO NOTHING` absorbs the race where two concurrent
 * first requests provision the same row.
 *
 * Passing the operator-credential id straight through to domain tables
 * would be a cross-identity IDOR: credential ids and user ids collide
 * numerically while referring to different people. The fallback openId
 * therefore prefers the operator credential id (never the public users id,
 * which would alias a DIFFERENT credential's `operator:<id>` key).
 */
export async function resolvePublicUser(
  user: Pick<SessionUser, "openId" | "email" | "name"> & {
    id?: number | null;
    operatorCredentialId?: number | null;
  },
): Promise<LinkedPublicUser> {
  const pool = await getPool();
  const fallbackCredentialId =
    user.operatorCredentialId && user.operatorCredentialId > 0
      ? user.operatorCredentialId
      : user.id && user.id > 0
        ? user.id
        : null;
  const openId =
    user.openId && user.openId.trim().length > 0
      ? user.openId.trim()
      : fallbackCredentialId !== null
        ? `operator:${fallbackCredentialId}`
        : null;
  const email = user.email ?? null;

  const found = await pool.query<{
    id: number;
    link: "open_id" | "email";
  }>(
    `SELECT id, link
     FROM (
       SELECT u.id, 'open_id'::text AS link, 0 AS rank
       FROM public.users u
       WHERE $1::text IS NOT NULL AND u.open_id = $1
       UNION ALL
       SELECT u.id, 'email'::text AS link, 1 AS rank
       FROM public.users u
       WHERE $2::text IS NOT NULL AND u.email IS NOT NULL
         AND lower(u.email) = lower($2)
     ) matches
     ORDER BY rank, id
     LIMIT 1`,
    [openId, email],
  );
  const existing = found.rows[0];
  if (existing) {
    return { id: Number(existing.id), link: existing.link };
  }

  if (!openId) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "public_user_resolution_failed",
    });
  }

  // Ensure a public.users row exists for this identity.
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO public.users (open_id, name, email, login_method, last_signed_in)
     VALUES ($1, $2, $3, 'operator_credential', now())
     ON CONFLICT (open_id) DO NOTHING
     RETURNING id`,
    [openId, user.name ?? null, email],
  );
  const created = inserted.rows[0];
  if (created) {
    return { id: Number(created.id), link: "created" };
  }
  const raced = await pool.query<{ id: number }>(
    `SELECT id FROM public.users WHERE open_id = $1`,
    [openId],
  );
  const racedRow = raced.rows[0];
  if (!racedRow) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "public_user_resolution_failed",
    });
  }
  return { id: Number(racedRow.id), link: "open_id" };
}

/**
 * Rewrite a verified session identity onto the unified domain subject:
 *
 * - `id` becomes the caller's `public.users.id` (resolving/provisioning the
 *   row when the token does not carry it yet — e.g. tokens minted before
 *   unification or external OIDC bearer JWTs).
 * - `operatorCredentialId` keeps the `operator_credentials.id` (when the
 *   session came from an operator credential) for operator-scoped stores
 *   (`operator_security_sessions`, account lifecycle) and audit.
 * - `openId` is preserved verbatim for attribution and open_id lookups.
 *
 * Returns null unchanged so callers can pipe getSessionUserFromRequest
 * straight through.
 */
function credentialIdFromOpenId(openId: string | null | undefined): number | null {
  if (!openId) return null;
  const match = /^operator:(\d{1,15})$/.exec(openId.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function unifySessionUser(
  user: SessionUser | null,
): Promise<SessionUser | null> {
  if (!user) return null;
  const operatorCredentialId =
    user.operatorCredentialId && user.operatorCredentialId > 0
      ? user.operatorCredentialId
      : credentialIdFromOpenId(user.openId);
  let publicUserId =
    user.publicUserId && user.publicUserId > 0 ? user.publicUserId : null;
  if (publicUserId === null) {
    const resolved = await resolvePublicUser({
      id: operatorCredentialId ?? (user.id > 0 ? user.id : null),
      operatorCredentialId,
      openId: user.openId,
      email: user.email,
      name: user.name,
    });
    publicUserId = resolved.id;
  }
  return {
    ...user,
    id: publicUserId,
    publicUserId,
    operatorCredentialId,
  };
}
