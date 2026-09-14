import { describe, expect, it, beforeAll, afterAll } from "vitest";

/**
 * Live-database integration coverage for identity unification (I-1/I-2) and
 * session revocation (I-4). Requires a Postgres with the platform schema
 * applied (at minimum public.users) and is gated behind an explicit marker
 * so it never runs against a shared database by accident.
 *
 *   RUN_IDENTITY_UNIFICATION_INTEGRATION=I_UNDERSTAND_THIS_USES_A_DISPOSABLE_LOCAL_DATABASE \
 *     DATABASE_URL=postgresql://... vitest run tests/identity-unification.integration.test.ts
 */

const RUN_MARKER = "I_UNDERSTAND_THIS_USES_A_DISPOSABLE_LOCAL_DATABASE";
const enabled =
  process.env.RUN_IDENTITY_UNIFICATION_INTEGRATION === RUN_MARKER &&
  (process.env.DATABASE_URL ?? "").length > 0;
const describeLive = enabled ? describe : describe.skip;

type ResolvePublicUser = typeof import("../server/_core/publicUsers").resolvePublicUser;
type UnifySessionUser = typeof import("../server/_core/publicUsers").unifySessionUser;
type RevokeSession = typeof import("../server/_core/sessionRevocationStore").revokeSession;
type IsSessionRevoked = typeof import("../server/_core/sessionRevocationStore").isSessionRevoked;

describeLive("identity unification against a live database", () => {
  let resolvePublicUser: ResolvePublicUser;
  let unifySessionUser: UnifySessionUser;
  let revokeSession: RevokeSession;
  let isSessionRevoked: IsSessionRevoked;
  let pool: import("pg").Pool;

  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const openId = `operator:test-${suffix}`;
  const ownerOpenId = `switchos-owner-test-${suffix}`;
  const email = `identity-test-${suffix}@example.com`;

  beforeAll(async () => {
    ({ resolvePublicUser, unifySessionUser } = await import("../server/_core/publicUsers"));
    ({ revokeSession, isSessionRevoked } = await import("../server/_core/sessionRevocationStore"));
    const { getPool } = await import("../server/db");
    pool = await getPool();
    const usersTable = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    if (usersTable.rows.length === 0) {
      throw new Error("public.users missing — apply drizzle migrations before running this test");
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM public.users WHERE open_id = ANY($1::text[])`, [
      [openId, ownerOpenId, `operator:email-fallback-${suffix}`, `operator:legacy-${suffix}`, "operator:887766"],
    ]);
    await pool.query(`DELETE FROM public.session_revocations WHERE session_id LIKE $1`, [
      `test-${suffix}%`,
    ]);
  });

  it("provisions a public.users row once and reuses it (open_id keyed)", async () => {
    const created = await resolvePublicUser({
      id: 987654,
      operatorCredentialId: 987654,
      openId,
      email,
      name: "Identity Test",
    });
    expect(created.link).toBe("created");
    expect(created.id).toBeGreaterThan(0);

    const again = await resolvePublicUser({
      id: 987654,
      operatorCredentialId: 987654,
      openId,
      email,
      name: "Identity Test",
    });
    expect(again.id).toBe(created.id);
    expect(again.link).toBe("open_id");
  });

  it("falls back to a case-insensitive email match", async () => {
    const byOpenId = await resolvePublicUser({
      id: 987654,
      operatorCredentialId: 987654,
      openId,
      email,
      name: "Identity Test",
    });
    const byEmail = await resolvePublicUser({
      id: 12345,
      operatorCredentialId: 12345,
      openId: `operator:email-fallback-${suffix}`,
      email: email.toUpperCase(),
      name: "Identity Test",
    });
    expect(byEmail.id).toBe(byOpenId.id);
    expect(byEmail.link).toBe("email");
  });

  it("keeps the bootstrap-owner fallback working (owner open_id keyed row)", async () => {
    const owner = await resolvePublicUser({
      id: null,
      operatorCredentialId: null,
      openId: ownerOpenId,
      email: null,
      name: "Bootstrap Owner",
    });
    expect(owner.id).toBeGreaterThan(0);
    const row = await pool.query(`SELECT open_id FROM public.users WHERE id = $1`, [owner.id]);
    expect(row.rows[0]?.open_id).toBe(ownerOpenId);
  });

  it("unifies the session identity onto public.users while preserving attribution", async () => {
    const resolved = await resolvePublicUser({
      id: 987654,
      operatorCredentialId: 987654,
      openId,
      email,
      name: "Identity Test",
    });

    // token carrying the claim: no re-resolution, id rewritten
    const unified = await unifySessionUser({
      id: 987654,
      name: "Identity Test",
      email,
      role: "operator",
      openId,
      publicUserId: resolved.id,
      operatorCredentialId: 987654,
      sessionId: `test-${suffix}-unify`,
    });
    expect(unified?.id).toBe(resolved.id);
    expect(unified?.publicUserId).toBe(resolved.id);
    expect(unified?.operatorCredentialId).toBe(987654);
    expect(unified?.openId).toBe(openId);

    // legacy token shape (pre-unification: numeric credential id + operator
    // openId, no publicUserId claim): resolved via the helper and the
    // credential id recovered from the operator:<id> openId namespace
    const legacy = await unifySessionUser({
      id: 887766,
      name: "Identity Test",
      email,
      role: "operator",
      openId: `operator:legacy-${suffix}`,
      sessionId: `test-${suffix}-legacy`,
    });
    expect(legacy?.operatorCredentialId).toBeNull();
    expect(legacy?.id).toBeGreaterThan(0);
    expect(legacy?.publicUserId).toBe(legacy?.id);

    const legacyNamespaced = await unifySessionUser({
      id: 887766,
      name: "Identity Test",
      email,
      role: "operator",
      openId: `operator:887766`,
      sessionId: `test-${suffix}-legacy-ns`,
    });
    expect(legacyNamespaced?.operatorCredentialId).toBe(887766);

    expect(await unifySessionUser(null)).toBeNull();
  });

  it("revokes sessions server-side and ignores expired revocations", async () => {
    const sessionId = `test-${suffix}-revoke`;
    expect(await isSessionRevoked(sessionId)).toBe(false);

    await revokeSession({
      sessionId,
      expiresAt: new Date(Date.now() + 60_000),
      reason: "logout",
    });
    expect(await isSessionRevoked(sessionId)).toBe(true);

    // replayed revocation is idempotent
    await revokeSession({
      sessionId,
      expiresAt: new Date(Date.now() + 60_000),
      reason: "logout",
    });
    expect(await isSessionRevoked(sessionId)).toBe(true);

    const expiredId = `test-${suffix}-expired`;
    await revokeSession({
      sessionId: expiredId,
      expiresAt: new Date(Date.now() - 60_000),
      reason: "logout",
    });
    expect(await isSessionRevoked(expiredId)).toBe(false);
  });
});
