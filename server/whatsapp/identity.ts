import { getPool } from "../db";

/**
 * WhatsApp phone → public.users identity mapping (P2-B).
 *
 * public.users HAS a nullable `phone varchar(20)` column on main
 * (drizzle/schema.ts), so a usable phone match exists: inbound WhatsApp
 * numbers are matched against it. Storage format is unspecified, so matching
 * normalizes BOTH the inbound number and the stored value to digit strings
 * and tries the documented NG equivalences:
 *
 *   E.164 without '+'  "2348012345678"  ↔  local NG "08012345678"
 *
 * Both forms (plus the '+'-prefixed variant of each) are probed with a
 * single ANY($1) query; first (lowest id) match wins.
 *
 * When no phone row matches, the consumer can reply "link <accountId>" with
 * their numeric public.users.id. LIMITATION (documented in flows.ts and in
 * every link reply): that link is unverified and session-local (in-memory,
 * lost on restart) — a temporary measure until verified phone signup /
 * OTP linking lands. Checkout FAILS CLOSED for unlinked numbers; browse and
 * cart stay open.
 */

/** Candidate stored representations for an inbound WhatsApp number. */
export function normalizePhoneVariants(raw: string): string[] {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return [];
  const variants = new Set<string>([digits, `+${digits}`]);
  // NG: 234XXXXXXXXXX (E.164 sans +) <-> 0XXXXXXXXXX (local, 11 digits).
  if (digits.startsWith("234") && digits.length === 13) {
    const local = `0${digits.slice(3)}`;
    variants.add(local);
    variants.add(`+${digits}`);
  }
  if (digits.startsWith("0") && digits.length === 11) {
    variants.add(`234${digits.slice(1)}`);
    variants.add(`+234${digits.slice(1)}`);
  }
  return [...variants];
}

/** Resolve a WhatsApp phone number to a public.users.id, or null. */
export async function findUserIdByPhone(raw: string): Promise<number | null> {
  const variants = normalizePhoneVariants(raw);
  if (variants.length === 0) return null;
  const pool = await getPool();
  const result = await pool.query(
    `SELECT id FROM public.users
     WHERE phone = ANY($1::text[])
     ORDER BY id ASC
     LIMIT 1`,
    [variants],
  );
  const row = result.rows[0];
  return row ? Number(row.id) : null;
}

/** Check a numeric account id exists in public.users (for "link <id>"). */
export async function userExists(userId: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT 1 FROM public.users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return Boolean(result.rows[0]);
}
