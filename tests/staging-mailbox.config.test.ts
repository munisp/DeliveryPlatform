import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("staging mailbox rehearsal", () => {
  const root = resolve(import.meta.dirname, "..");

  it("pins Mailpit and binds its UI only to loopback", async () => {
    const compose = await readFile(resolve(root, "deploy/testing/docker-compose.staging-mailbox.yml"), "utf8");
    expect(compose).toContain("axllent/mailpit:v1.30.5");
    expect(compose).toContain("127.0.0.1:${STAGING_MAILBOX_UI_PORT:-8025}:8025");
    expect(compose).not.toContain("1025:1025");
  });

  it("requires a staging route and non-routable test recipient before it submits signup", async () => {
    const script = await readFile(resolve(root, "scripts/testing/rehearse-staging-mailbox.sh"), "utf8");
    expect(script).toContain("Refusing a non-staging lifecycle URL");
    expect(script).toContain("non-routable .test domain");
    expect(script).toContain("/api/v1/message/latest/raw");
    expect(script).toContain("/api/auth/email-verification/confirm");
  });
});
