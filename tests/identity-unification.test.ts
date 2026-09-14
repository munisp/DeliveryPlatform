import { describe, expect, it } from "vitest";

import {
  createSessionToken,
  getSessionFromRequest,
  verifySessionToken,
} from "../server/_core/auth";

/**
 * Identity unification contract tests (no database required):
 * the signed session token carries the unified public.users subject and the
 * operator credential id as separate, collision-free claims, and external
 * OIDC subjects are never reduced to a munged numeric id (H-4).
 */

describe("session token identity claims", () => {
  it("carries publicUserId and operatorCredentialId; id is the public users id", async () => {
    const token = await createSessionToken({
      sub: "42",
      name: "Ops",
      email: "ops@example.com",
      role: "operator",
      openId: "operator:42",
      tenantId: "tenant-1",
      scopes: ["platform:read"],
      sessionId: "session-abc",
      publicUserId: 9001,
      operatorCredentialId: 42,
    });

    const user = await verifySessionToken(token);
    expect(user).not.toBeNull();
    expect(user?.id).toBe(9001);
    expect(user?.publicUserId).toBe(9001);
    expect(user?.operatorCredentialId).toBe(42);
    expect(user?.openId).toBe("operator:42");
    expect(user?.sessionId).toBe("session-abc");
  });

  it("reads legacy tokens (numeric sub, operator:<id> openId) as credential identity", async () => {
    const legacy = await createSessionToken({
      sub: "7",
      name: "Legacy",
      email: null,
      role: "admin",
      openId: "operator:7",
      sessionId: "legacy-session",
    });

    const user = await verifySessionToken(legacy);
    expect(user).not.toBeNull();
    expect(user?.operatorCredentialId).toBe(7);
    expect(user?.publicUserId).toBeNull();
    // pre-unification placeholder: the session-load path rewrites this to
    // the resolved public.users id
    expect(user?.id).toBe(7);
  });

  it("exposes jti and expiry for server-side revocation checks", async () => {
    const token = await createSessionToken({
      sub: "5",
      name: "Ops",
      role: "operator",
      openId: "operator:5",
      sessionId: "jti-revoke-me",
      publicUserId: 77,
      operatorCredentialId: 5,
    });

    const session = await getSessionFromRequest({
      authorization: `Bearer ${token}`,
    });
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("jti-revoke-me");
    expect(session?.expiresAt).toBeInstanceOf(Date);
    expect(session?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(session?.user.id).toBe(77);
  });
});

describe("H-4: OIDC subject handling never munges digits", () => {
  it("keeps distinct non-numeric subs distinct (no digit-strip collision)", async () => {
    // Under the old digit-munging both of these collapsed to id 12.
    const tokenA = await createSessionToken({
      sub: "user-1a2b",
      name: "A",
      role: "viewer",
      openId: "user-1a2b",
    });
    const tokenB = await createSessionToken({
      sub: "user-12ab",
      name: "B",
      role: "viewer",
      openId: "user-12ab",
    });

    const userA = await verifySessionToken(tokenA);
    const userB = await verifySessionToken(tokenB);
    expect(userA).not.toBeNull();
    expect(userB).not.toBeNull();
    expect(userA?.openId).toBe("user-1a2b");
    expect(userB?.openId).toBe("user-12ab");
    expect(userA?.operatorCredentialId).toBeNull();
    expect(userB?.operatorCredentialId).toBeNull();
    expect(userA?.publicUserId).toBeNull();
    // unresolved placeholder, NOT a derived numeric identity
    expect(userA?.id).toBe(0);
    expect(userB?.id).toBe(0);
  });

  it("does not resurrect numeric ids from subs containing digits", async () => {
    const token = await createSessionToken({
      sub: "auth0|65f1c2a9e871234567890123",
      name: "Ext",
      role: "viewer",
      openId: "auth0|65f1c2a9e871234567890123",
    });
    const user = await verifySessionToken(token);
    expect(user).not.toBeNull();
    expect(user?.operatorCredentialId).toBeNull();
    expect(user?.id).toBe(0);
    expect(user?.openId).toBe("auth0|65f1c2a9e871234567890123");
  });
});
