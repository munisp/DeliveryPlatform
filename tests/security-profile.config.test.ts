import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFile(resolve(process.cwd(), relativePath), "utf8");

describe("operator security profile contracts", () => {
  it("persists revocable security sessions with hashed identifiers and assurance metadata", async () => {
    const [store, migration, auth] = await Promise.all([
      source("server/_core/operatorAuthStore.ts"),
      source("drizzle/0017_operator_security_sessions.sql"),
      source("server/_core/auth.ts"),
    ]);

    expect(migration).toContain("operator_security_sessions");
    expect(store).toContain("session_hash");
    expect(store).toContain("revokeOperatorSecuritySession");
    expect(store).toContain("isOperatorSecuritySessionActive");
    expect(auth).toContain(".setJti(user.sessionId");
    expect(auth).toContain("mfaAuthenticated");
  });

  it("exposes authenticated security profile and friendly blocked-action feedback", async () => {
    const [server, page, app] = await Promise.all([
      source("server/_core/index.ts"),
      source("client/src/pages/SecurityProfile.tsx"),
      source("client/src/App.tsx"),
    ]);

    expect(server).toContain('app.get("/api/auth/security"');
    expect(server).toContain('app.delete("/api/auth/security/sessions/:id"');
    expect(server).toContain("Retry-After");
    expect(page).toContain("Manage MFA authenticators");
    expect(page).toContain("Action blocked by security policy");
    expect(page).toContain("Too many requests");
    expect(app).toContain('path="/profile/security"');
    expect(app).toContain('path="/security/blocked"');
  });
});
