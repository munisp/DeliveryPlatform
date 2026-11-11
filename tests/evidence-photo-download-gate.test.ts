import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2 closure — Finding 2: GET /api/rental-condition/photo/<key> must be
 * party-gated. After key validation the handler extracts the contract id
 * from the key's second path segment and asks
 * vehicle_access.can_view_contract_evidence (drizzle/0101) whether the actor
 * is the contract renter or an operator. Denied → 403, gate failure → 500,
 * allowed → the photo streams as before.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = queryMock;
  },
}));

import { ENV } from "../server/_core/env";
import {
  canViewConditionPhoto,
  handleRentalConditionPhotoDownload,
} from "../server/rental/conditionPhotoUpload";

const CONTRACT_ID = "3f2b7c4e-9a1d-4e2b-8c5f-6d7e8f9a0b1c";
const OBJECT_KEY = `rental-condition/${CONTRACT_ID}/check_out/front-0123456789abcdef.jpg`;
const PHOTO_BYTES = Buffer.from("party-gated-photo-bytes");

let uploadRoot: string;
let savedUploadDir: string;
let savedDatabaseUrl: string;

beforeAll(async () => {
  uploadRoot = await mkdtemp(path.join(tmpdir(), "photo-gate-"));
  const targetPath = path.join(uploadRoot, OBJECT_KEY);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, PHOTO_BYTES);
  savedUploadDir = ENV.rentalConditionUploadDir;
  savedDatabaseUrl = ENV.databaseUrl;
  ENV.rentalConditionUploadDir = uploadRoot;
  // The pool never dials out: pg is mocked above, only the config string is
  // needed so the lazy pool factory does not fail closed.
  ENV.databaseUrl = "postgresql://mocked-in-tests";
});

afterAll(async () => {
  ENV.rentalConditionUploadDir = savedUploadDir;
  ENV.databaseUrl = savedDatabaseUrl;
  await rm(uploadRoot, { recursive: true, force: true });
});

beforeEach(() => {
  queryMock.mockReset();
});

function fakeRequest(user: { id: number; role?: string } | null) {
  return {
    params: { 0: OBJECT_KEY },
    path: "/api/rental-condition/photo/*",
    user,
  } as never;
}

function fakeResponse() {
  const sink = new PassThrough();
  const state = {
    status: 0,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
  };
  const res = Object.assign(sink, {
    state,
    headersSent: false,
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      state.status = state.status || 200;
      return res;
    },
    setHeader(name: string, value: unknown) {
      state.headers[name.toLowerCase()] = value;
      return res;
    },
  });
  return { res: res as never, state, sink };
}

describe("canViewConditionPhoto", () => {
  it("calls vehicle_access.can_view_contract_evidence with actor and contract", async () => {
    queryMock.mockResolvedValue({ rows: [{ allowed: true }] });
    await expect(canViewConditionPhoto(7, CONTRACT_ID)).resolves.toBe(true);
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT vehicle_access.can_view_contract_evidence($1,$2::uuid) AS allowed",
      [7, CONTRACT_ID],
    );
  });

  it("maps a false row and an empty result to false (fail closed)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ allowed: false }] });
    await expect(canViewConditionPhoto(8, CONTRACT_ID)).resolves.toBe(false);
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(canViewConditionPhoto(8, CONTRACT_ID)).resolves.toBe(false);
  });
});

describe("handleRentalConditionPhotoDownload party gate", () => {
  it("serves the photo to the contract renter (gate true)", async () => {
    queryMock.mockResolvedValue({ rows: [{ allowed: true }] });
    const { res, state, sink } = fakeResponse();
    const chunks: Buffer[] = [];
    sink.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise<void>((resolvePromise) =>
      sink.on("end", resolvePromise),
    );
    await handleRentalConditionPhotoDownload(
      fakeRequest({ id: 7, role: "user" }),
      res,
    );
    await done;
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(state.headers["content-type"]).toBe("image/jpeg");
    expect(state.headers["cache-control"]).toBe("private, max-age=3600");
    expect(Buffer.concat(chunks)).toEqual(PHOTO_BYTES);
  });

  it("serves the photo to an operator (gate true)", async () => {
    queryMock.mockResolvedValue({ rows: [{ allowed: true }] });
    const { res, state, sink } = fakeResponse();
    sink.resume(); // drain so the readable side can emit "end"
    const done = new Promise<void>((resolvePromise) =>
      sink.on("end", resolvePromise),
    );
    await handleRentalConditionPhotoDownload(
      fakeRequest({ id: 1, role: "operator" }),
      res,
    );
    await done;
    expect(state.headers["content-type"]).toBe("image/jpeg");
  });

  it("rejects an authenticated non-party with 403 forbidden", async () => {
    queryMock.mockResolvedValue({ rows: [{ allowed: false }] });
    const { res, state } = fakeResponse();
    await handleRentalConditionPhotoDownload(
      fakeRequest({ id: 42, role: "user" }),
      res,
    );
    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: "forbidden" });
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
      42,
      CONTRACT_ID,
    ]);
  });

  it("fails closed with 500 when the access check itself errors", async () => {
    queryMock.mockRejectedValue(new Error("connection reset"));
    const { res, state } = fakeResponse();
    await handleRentalConditionPhotoDownload(
      fakeRequest({ id: 7, role: "user" }),
      res,
    );
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "photo_access_check_failed" });
  });

  it("still rejects malformed keys with 400 before any database call", async () => {
    const { res, state } = fakeResponse();
    await handleRentalConditionPhotoDownload(
      {
        params: { 0: "rental-condition/../check_out/front-0123456789abcdef.jpg" },
        path: "/api/rental-condition/photo/*",
        user: { id: 7, role: "user" },
      } as never,
      res,
    );
    expect(state.status).toBe(400);
    expect(state.body).toEqual({ error: "invalid_object_key" });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
