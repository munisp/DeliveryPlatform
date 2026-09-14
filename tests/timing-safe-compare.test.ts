import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { tokensEqual } from "../server/_core/security";

const root = process.cwd();
const source = (relativePath: string) =>
  readFileSync(resolve(root, relativePath), "utf8");

describe("tokensEqual constant-time comparison helper", () => {
  it("returns true for identical tokens", () => {
    expect(tokensEqual("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for different tokens of equal length", () => {
    expect(tokensEqual("s3cr3t-token", "s3cr3t-tokem")).toBe(false);
  });

  it("returns false without throwing when lengths differ", () => {
    expect(tokensEqual("short", "a-much-longer-token")).toBe(false);
    expect(tokensEqual("a-much-longer-token", "short")).toBe(false);
    expect(tokensEqual("", "non-empty")).toBe(false);
  });

  it("is implemented with crypto.timingSafeEqual", () => {
    const body = source("server/_core/security.ts");
    expect(body).toContain("timingSafeEqual");
    expect(body).toMatch(/export function tokensEqual/);
  });
});

describe("timing-safe secret comparison coverage", () => {
  it("uses tokensEqual for internal-service token checks in the HTTP server", () => {
    const body = source("server/_core/index.ts");
    expect(body).toContain('import { tokensEqual } from "./security"');
    expect(body).toContain("tokensEqual(provided, ENV.internalServiceToken)");
    expect(body).toContain("tokensEqual(providedToken, expectedToken)");
    expect(body).not.toMatch(/provided\s*===\s*ENV\.internalServiceToken/);
  });

  it("uses tokensEqual for the OIDC callback state comparison", () => {
    const body = source("server/_core/index.ts");
    expect(body).toContain("tokensEqual(state, storedState)");
    expect(body).not.toContain("state !== storedState");
    expect(body).not.toContain("state === storedState");
  });

  it("uses tokensEqual for the OIDC nonce comparison", () => {
    const body = source("server/_core/auth.ts");
    expect(body).toContain('import { tokensEqual } from "./security"');
    expect(body).toContain("tokensEqual(payload.nonce, expectedNonce)");
    expect(body).not.toContain("payload.nonce !== expectedNonce");
    expect(body).not.toContain("payload.nonce === expectedNonce");
  });

  it("does not reintroduce strict-equality secret comparisons in the HTTP server", () => {
    const body = source("server/_core/index.ts");
    expect(body).not.toMatch(/X-Internal-Service-Token.*===/);
    expect(body).not.toMatch(/internalServiceToken\s*(===|!==)/);
  });
});
