import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  handleRentalConditionPhotoDownload,
  resolveConditionPhotoPath,
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

let downloadRoot: string;

beforeAll(async () => {
  downloadRoot = await mkdtemp(path.join(tmpdir(), "rental-condition-dl-"));
});

afterAll(async () => {
  await rm(downloadRoot, { recursive: true, force: true });
});

async function seedPhoto(objectKey: string, bytes: Buffer) {
  const targetPath = path.join(downloadRoot, objectKey);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes);
  return targetPath;
}

describe("resolveConditionPhotoPath", () => {
  it("resolves a stored photo with the correct content type per extension", async () => {
    const cases: Array<[string, string]> = [
      [keyFor("check_out", "front_left", "jpg"), "image/jpeg"],
      [keyFor("check_out", "rear", "jpeg"), "image/jpeg"],
      [keyFor("check_in", "dashboard_odometer", "png"), "image/png"],
      [keyFor("check_in", "dashcam", "webp"), "image/webp"],
    ];
    for (const [objectKey, contentType] of cases) {
      const expectedPath = await seedPhoto(objectKey, Buffer.alloc(64, 3));
      const resolved = await resolveConditionPhotoPath(downloadRoot, objectKey);
      expect(resolved).toEqual({
        status: 200,
        path: expectedPath,
        contentType,
        sizeBytes: 64,
      });
    }
  });

  it("fails closed with 503 when the storage root is not configured", async () => {
    for (const root of ["", "   ", undefined, null]) {
      const resolved = await resolveConditionPhotoPath(
        root,
        keyFor("check_out"),
      );
      expect(resolved).toEqual({
        status: 503,
        error: "photo_storage_not_configured",
      });
    }
  });

  it("rejects traversal, absolute and backslash keys with 400", async () => {
    const badKeys = [
      `../${keyFor("check_out")}`,
      `/${keyFor("check_out")}`,
      "rental-condition/../check_out/front-0123456789abcdef.jpg",
      "rental-condition\\3f2b7c4e-9a1d-4e2b-8c5f-6d7e8f9a0b1c\\check_out\\front-0123456789abcdef.jpg",
      `${keyFor("check_out")}/..`,
      "",
    ];
    for (const objectKey of badKeys) {
      const resolved = await resolveConditionPhotoPath(downloadRoot, objectKey);
      expect(resolved).toEqual({ status: 400, error: "invalid_object_key" });
    }
  });

  it("rejects wrong phase and wrong shape keys with 400", async () => {
    const badKeys = [
      keyFor("checkout" as "check_out"),
      keyFor("CHECK_OUT" as "check_out"),
      `rental-condition/${CONTRACT_ID}/check_out/front-${DIGEST_SUFFIX}.gif`,
      `rental-condition/not-a-uuid/check_out/front-${DIGEST_SUFFIX}.jpg`,
      `other-prefix/${CONTRACT_ID}/check_out/front-${DIGEST_SUFFIX}.jpg`,
    ];
    for (const objectKey of badKeys) {
      const resolved = await resolveConditionPhotoPath(downloadRoot, objectKey);
      expect(resolved).toEqual({ status: 400, error: "invalid_object_key" });
    }
  });

  it("rejects root-prefix escape attempts before touching storage", async () => {
    // A sibling directory whose name shares the root prefix must never be
    // reachable: the strict key shape plus the resolvedRoot + path.sep guard
    // both reject these before any filesystem access.
    const escapeAttempts = [
      `../${path.basename(downloadRoot)}-evil/${keyFor("check_out")}`,
      `../../${keyFor("check_in")}`,
      `....//${keyFor("check_out")}`,
    ];
    for (const objectKey of escapeAttempts) {
      const resolved = await resolveConditionPhotoPath(downloadRoot, objectKey);
      expect(resolved).toEqual({ status: 400, error: "invalid_object_key" });
    }
  });

  it("returns 404 for a well-formed key whose file is missing", async () => {
    const resolved = await resolveConditionPhotoPath(
      downloadRoot,
      keyFor("check_in", "missing"),
    );
    expect(resolved).toEqual({ status: 404, error: "photo_not_found" });
  });

  it("returns 404 when the resolved path is a directory, not a file", async () => {
    const objectKey = keyFor("check_out", "dircase");
    await mkdir(path.join(downloadRoot, objectKey), { recursive: true });
    const resolved = await resolveConditionPhotoPath(downloadRoot, objectKey);
    expect(resolved).toEqual({ status: 404, error: "photo_not_found" });
  });
});

describe("handleRentalConditionPhotoDownload", () => {
  function fakeResponse() {
    const state = {
      status: 0,
      body: undefined as unknown,
      headers: {} as Record<string, unknown>,
    };
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
        setHeader(name: string, value: unknown) {
          state.headers[name.toLowerCase()] = value;
          return this;
        },
      },
    };
  }

  it("rejects unauthenticated requests with 401", async () => {
    const { res, state } = fakeResponse();
    await handleRentalConditionPhotoDownload(
      {
        params: { 0: keyFor("check_out") },
        path: "/api/rental-condition/photo/*",
      } as never,
      res as never,
    );
    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: "unauthorized" });
  });

  it("fails closed with 503 when RENTAL_CONDITION_UPLOAD_DIR is unset", async () => {
    // The sandbox process does not set RENTAL_CONDITION_UPLOAD_DIR, so
    // ENV.rentalConditionUploadDir is "" and the handler must fail closed.
    const { res, state } = fakeResponse();
    await handleRentalConditionPhotoDownload(
      {
        params: { 0: keyFor("check_out", "handler_failclosed") },
        path: "/api/rental-condition/photo/*",
        user: { id: 7, role: "driver", tenantId: "tenant-a" },
      } as never,
      res as never,
    );
    expect(state.status).toBe(503);
    expect(state.body).toEqual({ error: "photo_storage_not_configured" });
  });
});
