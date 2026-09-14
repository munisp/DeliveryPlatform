import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("identity unification + session revocation wiring", () => {
  it("shares resolvePublicUser from server/_core/publicUsers.ts", () => {
    const publicUsers = source("server/_core/publicUsers.ts");
    expect(publicUsers).toContain("export async function resolvePublicUser");
    expect(publicUsers).toContain("export async function unifySessionUser");
    expect(publicUsers).toContain("ON CONFLICT (open_id) DO NOTHING");

    const selfserve = source("server/_core/selfserveRouter.ts");
    expect(selfserve).toContain('export { resolvePublicUser } from "./publicUsers";');
    expect(selfserve).not.toContain("export async function resolvePublicUser");
  });

  it("issues sessions with the unified public.users subject on the token", () => {
    const server = source("server/_core/index.ts");
    expect(server).toContain("const publicUser = await resolvePublicUser({");
    expect(server).toContain("publicUserId: publicUser.id");
    expect(server).toContain("operatorCredentialId: hasCredentialIdentity ? operator.id : null");

    const auth = source("server/_core/auth.ts");
    expect(auth).toContain("publicUserId");
    expect(auth).toContain("operatorCredentialId");
  });

  it("never derives numeric identity by stripping digits from the OIDC sub (H-4)", () => {
    const auth = source("server/_core/auth.ts");
    expect(auth).not.toContain("replace(/\\D/g");
    expect(auth).toContain("parseOperatorCredentialOpenId");
    expect(auth).toContain("toPositiveInteger(payload.publicUserId)");
  });

  it("unifies ctx.user.id onto public.users at the session-load path and context", () => {
    const server = source("server/_core/index.ts");
    expect(server).toContain("resolveRequestSessionUser");
    expect(server).toContain("return unifySessionUser(user);");
    expect(server).toContain("user: user ? { ...user, id: user.publicUserId ?? user.id } : null");

    const trpc = source("server/_core/trpc.ts");
    expect(trpc).toContain("publicUserId?: number | null;");
    expect(trpc).toContain("operatorCredentialId?: number | null;");
  });

  it("keeps operator-scoped stores on the operator credential id", () => {
    const server = source("server/_core/index.ts");
    expect(server).toContain("function operatorCredentialIdOf(user: SessionUser): number");
    expect(server).toContain("listOperatorSecuritySessions(operatorCredentialIdOf(user))");
    expect(server).toContain("getOnboardingState(operatorCredentialIdOf(user))");
    expect(server).not.toContain("listOperatorSecuritySessions(Number(user.id))");
  });

  it("ships migration 0078 as an append-only session revocation list", () => {
    const migration = source("drizzle/0078_session_revocation.sql");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.session_revocations");
    expect(migration).toContain("session_id TEXT PRIMARY KEY");
    expect(migration).toContain("revoked_at TIMESTAMPTZ NOT NULL");
    expect(migration).toContain("expires_at TIMESTAMPTZ NOT NULL");
    expect(migration).toContain("reason VARCHAR(64)");
    expect(migration).toContain("session_revocations_expires_at_idx");
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/\bALTER TABLE\b/i);
  });

  it("revokes sessions server-side on logout and checks revocation on load (M-2)", () => {
    const server = source("server/_core/index.ts");
    expect(server).toContain('app.post("/api/auth/logout"');
    expect(server).toContain("await revokeSession({");
    expect(server).toContain('reason: "logout"');
    expect(server).toContain("await isSessionRevoked(user.sessionId)");
    expect(server).toContain("res.clearCookie(COOKIE_NAME, getCookieOptions());");

    const store = source("server/_core/sessionRevocationStore.ts");
    expect(store).toContain("export async function revokeSession");
    expect(store).toContain("export async function isSessionRevoked");
    expect(store).toContain("ON CONFLICT (session_id) DO NOTHING");
    expect(store).toContain("DELETE FROM public.session_revocations WHERE expires_at < NOW()");
  });
});
