import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * P2 closure — Finding 1: rentalCondition.recordReport must verify the
 * client-claimed sha256Hex of every photo whose objectKey is in the
 * rental-condition upload namespace against the bytes actually stored under
 * ENV.rentalConditionUploadDir, and fail closed when no upload directory is
 * configured. Keys outside the namespace (external object stores) pass
 * through unchanged.
 *
 * Also pins the static shape of drizzle/0101_evidence_access_and_fuel_ceiling.sql.
 */

const dataAccessMocks = vi.hoisted(() => ({
  recordConditionReport: vi.fn(async () => "report-id-1"),
  computeReturnSettlement: vi.fn(),
  createInsuranceTier: vi.fn(),
  getConditionDeltaReport: vi.fn(),
  listInsuranceTiersForOffer: vi.fn(async () => []),
  retireInsuranceTier: vi.fn(),
  selectContractInsurance: vi.fn(),
}));

vi.mock("../server/_core/vehicleCondition", () => dataAccessMocks);

import { ENV } from "../server/_core/env";
import { rentalConditionRouter } from "../server/rental/conditionInsurance";

const CONTRACT_ID = "3f2b7c4e-9a1d-4e2b-8c5f-6d7e8f9a0b1c";

function namespacedKey(view = "front", contractId = CONTRACT_ID) {
  return `rental-condition/${contractId}/check_out/${view}-0123456789abcdef.jpg`;
}

const PHOTO_BYTES = Buffer.from("evidence-photo-bytes");
const PHOTO_SHA256 = createHash("sha256").update(PHOTO_BYTES).digest("hex");

function photoFor(objectKey: string, sha256Hex = PHOTO_SHA256) {
  return {
    zone: "front" as const,
    objectKey,
    contentType: "image/jpeg" as const,
    sha256Hex,
    damageFlag: false,
  };
}

const BASE_REPORT = {
  contractId: CONTRACT_ID,
  phase: "check_out" as const,
  odometerKm: 12_345,
  fuelPct: 80,
  overallCondition: "good" as const,
  idempotencyKey: "report-key-0001",
};

function caller(userId = 9) {
  return rentalConditionRouter.createCaller({
    req: { headers: {} },
    res: {},
    user: { id: userId, name: "Rental Worker", role: "user" },
  } as never);
}

let uploadRoot: string;
let savedUploadDir: string;

beforeAll(async () => {
  uploadRoot = await mkdtemp(path.join(tmpdir(), "evidence-verify-"));
  savedUploadDir = ENV.rentalConditionUploadDir;
  ENV.rentalConditionUploadDir = uploadRoot;
});

afterAll(async () => {
  ENV.rentalConditionUploadDir = savedUploadDir;
  await rm(uploadRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
  ENV.rentalConditionUploadDir = uploadRoot;
});

async function seedPhoto(objectKey: string, bytes: Buffer = PHOTO_BYTES) {
  const targetPath = path.join(uploadRoot, objectKey);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes);
}

describe("recordReport evidence verification", () => {
  it("accepts a photo whose stored bytes match the claimed sha256", async () => {
    const key = namespacedKey();
    await seedPhoto(key);
    const result = await caller().recordReport({
      ...BASE_REPORT,
      photos: [photoFor(key)],
    });
    expect(result).toEqual({ reportId: "report-id-1" });
    expect(dataAccessMocks.recordConditionReport).toHaveBeenCalledTimes(1);
    expect(dataAccessMocks.recordConditionReport).toHaveBeenCalledWith(
      expect.objectContaining({
        photos: [expect.objectContaining({ objectKey: key, sha256Hex: PHOTO_SHA256 })],
      }),
    );
  });

  it("rejects a sha256 that does not match the stored bytes (evidence_hash_mismatch)", async () => {
    const key = namespacedKey();
    await seedPhoto(key);
    const wrongSha = "b".repeat(64);
    await expect(
      caller().recordReport({ ...BASE_REPORT, photos: [photoFor(key, wrongSha)] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "evidence_hash_mismatch" });
    expect(dataAccessMocks.recordConditionReport).not.toHaveBeenCalled();
  });

  it("rejects a namespaced photo that was never uploaded (evidence_not_uploaded)", async () => {
    const key = namespacedKey("missing");
    await expect(
      caller().recordReport({ ...BASE_REPORT, photos: [photoFor(key)] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "evidence_not_uploaded" });
    expect(dataAccessMocks.recordConditionReport).not.toHaveBeenCalled();
  });

  it("fails closed with PRECONDITION_FAILED when no upload directory is configured", async () => {
    ENV.rentalConditionUploadDir = "";
    const key = namespacedKey();
    await expect(
      caller().recordReport({ ...BASE_REPORT, photos: [photoFor(key)] }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "photo_storage_not_configured",
    });
    expect(dataAccessMocks.recordConditionReport).not.toHaveBeenCalled();
  });

  it("passes photos with keys outside our namespace through unchanged", async () => {
    // External object-store key: not verifiable by us and out of scope.
    ENV.rentalConditionUploadDir = "";
    const externalKey = "condition/contract-1/check-out-odometer.jpg";
    const result = await caller().recordReport({
      ...BASE_REPORT,
      photos: [photoFor(externalKey, "c".repeat(64))],
    });
    expect(result).toEqual({ reportId: "report-id-1" });
    expect(dataAccessMocks.recordConditionReport).toHaveBeenCalledWith(
      expect.objectContaining({
        photos: [expect.objectContaining({ objectKey: externalKey })],
      }),
    );
  });

  it("verifies only the namespaced subset of a mixed photo list", async () => {
    const key = namespacedKey();
    await seedPhoto(key);
    const result = await caller().recordReport({
      ...BASE_REPORT,
      photos: [photoFor(key), photoFor("external/evidence/photo-1.jpg", "d".repeat(64))],
    });
    expect(result).toEqual({ reportId: "report-id-1" });
    expect(dataAccessMocks.recordConditionReport).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// drizzle/0101 static pins
// ---------------------------------------------------------------------------
const root = resolve(import.meta.dirname, "..");
const migration0101 = readFileSync(
  resolve(root, "drizzle/0101_evidence_access_and_fuel_ceiling.sql"),
  "utf8",
);
const migration0097 = readFileSync(
  resolve(root, "drizzle/0097_settlement_disputes.sql"),
  "utf8",
);
const migration0058 = readFileSync(
  resolve(root, "drizzle/0058_gig_vehicle_rental_operations.sql"),
  "utf8",
);

describe("drizzle/0101_evidence_access_and_fuel_ceiling.sql", () => {
  it("defines can_view_contract_evidence as STABLE SECURITY DEFINER with pinned search_path", () => {
    expect(migration0101).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.can_view_contract_evidence(",
    );
    expect(migration0101).toContain("p_actor integer, p_contract uuid");
    expect(migration0101).toContain(
      "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vehicle_access",
    );
  });

  it("gates on operator role or the contract renter (worker_user_id)", () => {
    expect(migration0101).toContain("vehicle_access.is_operator(p_actor)");
    expect(migration0101).toContain("c.worker_user_id = p_actor");
    // Column sanity: worker_user_id is the renter column on access_contract.
    expect(migration0058).toContain("worker_user_id");
  });

  it("raises the adjusted ceiling to include the fuel charge", () => {
    expect(migration0101).toContain(
      "v_max_adjustment := v_settlement.renter_damage_liability_minor + v_settlement.excess_km_charge_minor + v_settlement.fuel_charge_minor;",
    );
    // Sanity: fuel_charge_minor is a real return_settlement column (0096).
    const migration0096 = readFileSync(
      resolve(root, "drizzle/0096_rental_condition_insurance.sql"),
      "utf8",
    );
    expect(migration0096).toContain("fuel_charge_minor bigint NOT NULL");
    expect(migration0096).toContain(
      "total_charge_minor = excess_km_charge_minor + fuel_charge_minor + renter_damage_liability_minor",
    );
  });

  it("keeps every other decide_settlement_dispute line byte-identical to 0097", () => {
    const extractFn = (sql: string) => {
      const start = sql.indexOf(
        "CREATE OR REPLACE FUNCTION vehicle_access.decide_settlement_dispute(",
      );
      const end = sql.indexOf("$$;", start);
      return sql.slice(start, end + 3);
    };
    const from0097 = extractFn(migration0097);
    const from0101 = extractFn(migration0101);
    const strip = (fn: string) =>
      fn
        .split("\n")
        // Drop comment lines (the ceiling comment changed) and the ceiling
        // assignment itself; every remaining line must be byte-identical.
        .filter(
          (line) =>
            !line.trim().startsWith("--") && !line.includes("v_max_adjustment"),
        )
        .join("\n");
    expect(strip(from0101)).toBe(strip(from0097));
    // Error codes and event payloads preserved.
    for (const pin of [
      "'operator role required' USING ERRCODE = '42501'",
      "'dispute_not_open' USING ERRCODE = '23514'",
      "'adjustment exceeds disputable charge total' USING ERRCODE = '23514'",
      "'adjustment only permitted for adjusted disputes' USING ERRCODE = '23514'",
      "'vehicle_access.settlement_dispute.decided'",
      "'vehicle_access.contract.settlement_dispute_decided'",
    ]) {
      expect(from0101).toContain(pin);
    }
  });

  it("guards the GRANT block behind a pg_roles existence check", () => {
    expect(migration0101).toContain(
      "IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN",
    );
    expect(migration0101).toContain(
      "GRANT EXECUTE ON FUNCTION vehicle_access.can_view_contract_evidence(integer,uuid) TO vehicle_access_service;",
    );
    expect(migration0101).toContain(
      "GRANT EXECUTE ON FUNCTION vehicle_access.decide_settlement_dispute(integer,uuid,vehicle_access.dispute_status,bigint,text,text,timestamptz) TO vehicle_access_service;",
    );
  });
});
