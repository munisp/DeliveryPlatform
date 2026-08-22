import { afterEach, describe, expect, it } from "vitest";
import { authorizePodUpload } from "../server/_core/podStorage";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
describe("POD storage authorization", () => {
  it("fails closed without storage credentials", () => {
    delete process.env.POD_STORAGE_ENDPOINT;
    expect(() => authorizePodUpload({ tenantId: 7, objectKey: "tenant/7/delivery/a.jpg", contentType: "image/jpeg", maxBytes: 1024 })).toThrow("pod_storage_unconfigured");
  });
  it("simulates a tenant-bound S3-compatible signer only in test mode", () => {
    Object.assign(process.env, { NODE_ENV: "test", POD_STORAGE_TEST_SIGNER: "1", POD_STORAGE_ENDPOINT: "https://storage.test", POD_STORAGE_BUCKET: "pod", POD_STORAGE_ACCESS_KEY: "test", POD_STORAGE_SECRET_KEY: "test" });
    const grant = authorizePodUpload({ tenantId: 7, objectKey: "tenant/7/delivery/a.jpg", contentType: "image/jpeg", maxBytes: 1024 });
    expect(grant.uploadUrl).toContain("tenant%2F7%2Fdelivery%2Fa.jpg");
    expect(grant.headers["X-Test-Upload-Limit"]).toBe("1024");
  });
});
