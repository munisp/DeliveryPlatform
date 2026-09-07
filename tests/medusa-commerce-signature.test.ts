import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { verifyMedusaWebhookSignature } from "../server/_core/medusaCommerce";

describe("Medusa commerce event signatures", () => {
  const body = Buffer.from('{"order_id":"ord_test_001"}', "utf8");
  const secret = "test-medusa-webhook-secret-at-least-32-characters";
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a matching SHA-256 signature with or without its conventional prefix", () => {
    expect(verifyMedusaWebhookSignature(body, signature, secret)).toBe(true);
    expect(
      verifyMedusaWebhookSignature(body, `sha256=${signature}`, secret),
    ).toBe(true);
  });

  it("rejects malformed, mismatched, and replay-altered raw bodies", () => {
    expect(
      verifyMedusaWebhookSignature(body, "sha256=not-a-digest", secret),
    ).toBe(false);
    expect(
      verifyMedusaWebhookSignature(body, signature, `${secret}-other`),
    ).toBe(false);
    expect(
      verifyMedusaWebhookSignature(
        Buffer.from('{"order_id":"ord_test_002"}'),
        signature,
        secret,
      ),
    ).toBe(false);
  });
});
