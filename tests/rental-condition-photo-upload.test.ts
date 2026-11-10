import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONDITION_PHOTO_MAX_BYTES,
  conditionPhotoContentTypeMatchesKey,
  decodeConditionPhotoBase64,
  handleRentalConditionPhotoUpload,
  isAllowedConditionPhotoContentType,
  isValidConditionPhotoObjectKey,
  storeConditionPhoto,
} from "../server/rental/conditionPhotoUpload";

const CONTRACT_ID = "3f2b7c4e-9a1d-4e2b-8c5f-6d7e8f9a0b1c";
const DIGEST_SUFFIX = "0123456789abcdef";

function keyFor(
  phase: "check_out" | "check_in",
  view = "front_left",
  extension = "jpg",
  contractId = CONTRACT_ID,
) {
  return `rental-condition/${contractId}/${phase}/${view}-${DIGEST_SUFFIX}.${extension}`;
}

function base64OfBytes(length: number) {
  return Buffer.alloc(length, 7).toString("base64");
}

let uploadRoot: string;

beforeAll(async () => {
  uploadRoot = await mkdtemp(path.join(tmpdir(), "rental-condition-photos-"));
});

afterAll(async () => {
  await rm(uploadRoot, { recursive: true, force: true });
});

describe("isValidConditionPhotoObjectKey", () => {
  it("accepts the exact shapes the mobile client builds", () => {
    expect(isValidConditionPhotoObjectKey(keyFor("check_out"))).toBe(true);
    expect(isValidConditionPhotoObjectKey(keyFor("check_in"))).toBe(true);
    expect(
      isValidConditionPhotoObjectKey(keyFor("check_in", "rear", "png")),
    ).toBe(true);
    expect(
      isValidConditionPhotoObjectKey(keyFor("check_out", "dashcam", "webp")),
    ).toBe(true);
    expect(
      isValidConditionPhotoObjectKey(keyFor("check_out", "front_left", "jpeg")),
    ).toBe(true);
    expect(
      isValidConditionPhotoObjectKey(
        keyFor("check_in", "front", "jpg", CONTRACT_ID.toUpperCase()),
      ),
    ).toBe(true);
    // Minimum-length view label (2 chars) and underscore-only label are valid.
    expect(
      isValidConditionPhotoObjectKey(keyFor("check_out", "ab", "jpg")),
    ).toBe(true);
    expect(
      isValidConditionPhotoObjectKey(keyFor("check_out", "__", "jpg")),
    ).toBe(true);
  });

  it("rejects traversal, absolute paths and separator tricks", () => {
    expect(isValidConditionPhotoObjectKey(`../${keyFor("check_out")}`)).toBe(
      false,
    );
    expect(
      isValidConditionPhotoObjectKey(
        "rental-condition/../check_out/front-0123456789abcdef.jpg",
      ),
    ).toBe(false);
    expect(
      isValidConditionPhotoObjectKey(`/${keyFor("check_out")}`),
    ).toBe(false);
    expect(
      isValidConditionPhotoObjectKey(
        "rental-condition\\3f2b7c4e-9a1d-4e2b-8c5f-6d7e8f9a0b1c\\check_out\\front-0123456789abcdef.jpg",
      ),
    ).toBe(false);
    expect(
      isValidConditionPhotoObjectKey(
        keyFor("check_out", "front_left", "jpg") + "/..",
      ),
    ).toBe(false);
  });

  it("rejects wrong phase, missing digest suffix and bad extensions", () => {
    expect(
      isValidConditionPhotoObjectKey(keyFor("checkout" as "check_out")),
    ).toBe(false);
    expect(isValidConditionPhotoObjectKey(keyFor("CHECK_OUT" as "check_out"))).toBe(false);
    expect(
      isValidConditionPhotoObjectKey(
        `rental-condition/${CONTRACT_ID}/check_out/front.jpg`,
      ),
    ).toBe(false);
    expect(
      isValidConditionPhotoObjectKey(
        `rental-condition/${CONTRACT_ID}/check_out/front-${DIGEST_SUFFIX}.gif`,
      ),
    ).toBe(false);
    expect(
      isValidConditionPhotoObjectKey(
        `rental-condition/${CONTRACT_ID}/check_out/front-${DIGEST_SUFFIX.slice(0, 15)}.jpg`,
      ),
    ).toBe(false);
    expect(
      isValidConditionPhotoObjectKey(
        `rental-condition/${CONTRACT_ID}/check_out/front-0123456789abcdeg.jpg`,
      ),
    ).toBe(false);
    expect(
      isValidConditionPhotoObjectKey(
        `rental-condition/not-a-uuid/check_out/front-${DIGEST_SUFFIX}.jpg`,
      ),
    ).toBe(false);
    expect(
      isValidConditionPhotoObjectKey(
        `other-prefix/${CONTRACT_ID}/check_out/front-${DIGEST_SUFFIX}.jpg`,
      ),
    ).toBe(false);
    expect(isValidConditionPhotoObjectKey("")).toBe(false);
    expect(isValidConditionPhotoObjectKey(null)).toBe(false);
    expect(isValidConditionPhotoObjectKey(undefined)).toBe(false);
  });
});

describe("content type allowlist and extension agreement", () => {
  it("allows exactly jpeg/png/webp", () => {
    expect(isAllowedConditionPhotoContentType("image/jpeg")).toBe(true);
    expect(isAllowedConditionPhotoContentType("image/png")).toBe(true);
    expect(isAllowedConditionPhotoContentType("image/webp")).toBe(true);
    expect(isAllowedConditionPhotoContentType("image/gif")).toBe(false);
    expect(isAllowedConditionPhotoContentType("IMAGE/JPEG")).toBe(false);
    expect(isAllowedConditionPhotoContentType("image/jpeg ")).toBe(false);
  });

  it("requires the extension to agree with the content type", () => {
    expect(
      conditionPhotoContentTypeMatchesKey(keyFor("check_out", "front", "jpg"), "image/jpeg"),
    ).toBe(true);
    expect(
      conditionPhotoContentTypeMatchesKey(keyFor("check_out", "front", "jpeg"), "image/jpeg"),
    ).toBe(true);
    expect(
      conditionPhotoContentTypeMatchesKey(keyFor("check_out", "front", "png"), "image/png"),
    ).toBe(true);
    expect(
      conditionPhotoContentTypeMatchesKey(keyFor("check_out", "front", "webp"), "image/webp"),
    ).toBe(true);
    expect(
      conditionPhotoContentTypeMatchesKey(keyFor("check_out", "front", "png"), "image/jpeg"),
    ).toBe(false);
    expect(
      conditionPhotoContentTypeMatchesKey(keyFor("check_out", "front", "jpg"), "image/webp"),
    ).toBe(false);
  });

  it("storeConditionPhoto rejects mismatched or disallowed content types", async () => {
    const mismatch = await storeConditionPhoto({
      root: uploadRoot,
      objectKey: keyFor("check_out", "mismatch", "png"),
      contentType: "image/jpeg",
      contentBase64: base64OfBytes(16),
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toEqual({ error: "invalid_content_type" });

    const disallowed = await storeConditionPhoto({
      root: uploadRoot,
      objectKey: keyFor("check_out", "disallowed", "jpg"),
      contentType: "image/gif",
      contentBase64: base64OfBytes(16),
    });
    expect(disallowed.status).toBe(400);
    expect(disallowed.body).toEqual({ error: "invalid_content_type" });
  });
});

describe("decodeConditionPhotoBase64", () => {
  it("rejects non-strict base64 (whitespace, bad characters, empty)", () => {
    const good = Buffer.from("hello-condition-photo").toString("base64");
    expect(decodeConditionPhotoBase64(good, "image/jpeg").ok).toBe(true);
    expect(
      decodeConditionPhotoBase64(`${good.slice(0, 8)}\n${good.slice(8)}`, "image/jpeg"),
    ).toEqual({ ok: false, error: "invalid_content_base64" });
    expect(decodeConditionPhotoBase64(`${good} `, "image/jpeg")).toEqual({
      ok: false,
      error: "invalid_content_base64",
    });
    expect(decodeConditionPhotoBase64("not!base64!", "image/jpeg")).toEqual({
      ok: false,
      error: "invalid_content_base64",
    });
    expect(decodeConditionPhotoBase64("", "image/jpeg")).toEqual({
      ok: false,
      error: "invalid_content_base64",
    });
    expect(decodeConditionPhotoBase64("====", "image/jpeg")).toEqual({
      ok: false,
      error: "invalid_content_base64",
    });
    expect(decodeConditionPhotoBase64(undefined, "image/jpeg")).toEqual({
      ok: false,
      error: "invalid_content_base64",
    });
  });

  it("rejects disallowed content types before decoding", () => {
    expect(decodeConditionPhotoBase64("AAAA", "image/gif")).toEqual({
      ok: false,
      error: "invalid_content_type",
    });
  });

  it("enforces the 6,000,000 byte decoded cap at the boundary", () => {
    expect(CONDITION_PHOTO_MAX_BYTES).toBe(6_000_000);
    const atCap = decodeConditionPhotoBase64(
      base64OfBytes(6_000_000),
      "image/jpeg",
    );
    expect(atCap.ok).toBe(true);
    const overCap = decodeConditionPhotoBase64(
      base64OfBytes(6_000_001),
      "image/jpeg",
    );
    expect(overCap).toEqual({ ok: false, error: "photo_too_large" });
  });
});

describe("storeConditionPhoto", () => {
  it("fails closed with 503 when the storage root is not configured", async () => {
    const result = await storeConditionPhoto({
      root: "",
      objectKey: keyFor("check_out", "noroot"),
      contentType: "image/jpeg",
      contentBase64: base64OfBytes(16),
    });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "photo_storage_not_configured" });
  });

  it("rejects invalid object keys before touching storage", async () => {
    const result = await storeConditionPhoto({
      root: uploadRoot,
      objectKey: `../${keyFor("check_out", "escape")}`,
      contentType: "image/jpeg",
      contentBase64: base64OfBytes(16),
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_object_key" });
  });

  it("returns 413 when the decoded photo exceeds the cap", async () => {
    const result = await storeConditionPhoto({
      root: uploadRoot,
      objectKey: keyFor("check_in", "toolarge"),
      contentType: "image/jpeg",
      contentBase64: base64OfBytes(6_000_001),
    });
    expect(result.status).toBe(413);
    expect(result.body).toEqual({ error: "photo_too_large" });
  });

  it("accepts a photo of exactly 6,000,000 decoded bytes", async () => {
    const result = await storeConditionPhoto({
      root: uploadRoot,
      objectKey: keyFor("check_in", "atcap"),
      contentType: "image/jpeg",
      contentBase64: base64OfBytes(6_000_000),
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      objectKey: keyFor("check_in", "atcap"),
      sizeBytes: 6_000_000,
    });
  });

  it("writes once (201), then reuses identical bytes (200), and conflicts on different bytes (409)", async () => {
    const objectKey = keyFor("check_out", "driver_side");
    const contentBase64 = base64OfBytes(2048);

    const first = await storeConditionPhoto({
      root: uploadRoot,
      objectKey,
      contentType: "image/jpeg",
      contentBase64,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      objectKey,
      sizeBytes: 2048,
    });
    expect(first.body).not.toHaveProperty("reused");
    const sha256Hex = first.body.sha256Hex;
    expect(sha256Hex).toMatch(/^[0-9a-f]{64}$/);

    const stored = await readFile(path.join(uploadRoot, objectKey));
    expect(stored.length).toBe(2048);

    const retry = await storeConditionPhoto({
      root: uploadRoot,
      objectKey,
      contentType: "image/jpeg",
      contentBase64,
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({
      objectKey,
      sha256Hex,
      sizeBytes: 2048,
      reused: true,
    });

    const conflict = await storeConditionPhoto({
      root: uploadRoot,
      objectKey,
      contentType: "image/jpeg",
      contentBase64: base64OfBytes(2049),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: "object_key_conflict" });

    // A pre-existing foreign file at the target path also conflicts.
    const foreignKey = keyFor("check_in", "foreign");
    await rm(path.join(uploadRoot, path.dirname(foreignKey)), {
      recursive: true,
      force: true,
    });
    await storeConditionPhoto({
      root: uploadRoot,
      objectKey: keyFor("check_in", "seed_dir"),
      contentType: "image/jpeg",
      contentBase64: base64OfBytes(4),
    });
    await writeFile(path.join(uploadRoot, foreignKey), Buffer.alloc(32, 9));
    const foreign = await storeConditionPhoto({
      root: uploadRoot,
      objectKey: foreignKey,
      contentType: "image/jpeg",
      contentBase64: base64OfBytes(32),
    });
    expect(foreign.status).toBe(409);
  });
});

describe("handleRentalConditionPhotoUpload", () => {
  function fakeResponse() {
    const state = { status: 0, body: undefined as unknown };
    return {
      state,
      res: {
        status(code: number) {
          state.status = code;
          return this;
        },
        json(body: unknown) {
          state.body = body;
          return this;
        },
      },
    };
  }

  it("rejects unauthenticated requests with 401", async () => {
    const { res, state } = fakeResponse();
    await handleRentalConditionPhotoUpload(
      { body: {}, path: "/api/rental-condition/photo" } as never,
      res as never,
    );
    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: "unauthorized" });
  });

  it("fails closed with 503 when RENTAL_CONDITION_UPLOAD_DIR is unset", async () => {
    // The sandbox process does not set RENTAL_CONDITION_UPLOAD_DIR, so
    // ENV.rentalConditionUploadDir is "" and the handler must fail closed.
    const { res, state } = fakeResponse();
    await handleRentalConditionPhotoUpload(
      {
        body: {
          objectKey: keyFor("check_out", "handler_failclosed"),
          contentType: "image/jpeg",
          contentBase64: base64OfBytes(16),
        },
        path: "/api/rental-condition/photo",
        user: { id: 7, role: "driver", tenantId: "tenant-a" },
      } as never,
      res as never,
    );
    expect(state.status).toBe(503);
    expect(state.body).toEqual({ error: "photo_storage_not_configured" });
  });
});
