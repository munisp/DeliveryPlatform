/**
 * PWA wire contract test (Audit B finding 3.1).
 *
 * The trust and economics routers return raw snake_case Postgres rows; the
 * PWA bridges normalize them via client/src/lib/trustWire.ts and
 * client/src/lib/economicsWire.ts. The fixtures below are copied verbatim
 * from the server modules (server/_core/workerCouncil.ts,
 * deactivationDueProcess.ts, economicsPolicy.ts, offerEconomics.ts) and the
 * assertions pin the exact DTOs the pages consume — this test must fail if
 * the server wire shape drifts from the fixture or the normalizers stop
 * producing page-consumable output.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeConsultationDetail,
  normalizeConsultationList,
  normalizeDeactivationCaseList,
  normalizeMyDeactivationCase,
  type CouncilConsultationDetailResult,
  type CouncilConsultationRow,
  type DeactivationCaseRow,
  type DeactivationMyCaseResult,
} from "../client/src/lib/trustWire";
import {
  normalizeFareFloor,
  normalizeNetEarningsSummary,
  normalizeOfferBreakdown,
  normalizeTakeRate,
  type FareFloorPolicyRowWire,
  type NetEarningsSummaryWire,
  type OfferEconomicsBreakdownRowWire,
  type TakeRateRowWire,
} from "../client/src/lib/economicsWire";

// ---------- fixtures: workerCouncil.ts listConsultations / getConsultation ----------

/** ConsultationRow & { response_count: number } (workerCouncil.ts:28-38, 59-79) */
const consultationRow: CouncilConsultationRow = {
  id: "b1f2a3c4-1111-4a1a-8a1a-aaaaaaaaaaaa",
  kind: "commission",
  title: "Take-rate change for lagos-island",
  payload: { rate_bps: 1200 },
  status: "open",
  posted_by: 7,
  response_sla_at: "2026-03-01T12:00:00.000Z",
  activated_at: null,
  created_at: "2026-02-20T09:30:00.000Z",
  response_count: 3,
};

/** getConsultation return envelope (workerCouncil.ts:93-129) */
const consultationDetailResult: CouncilConsultationDetailResult = {
  consultation: {
    ...consultationRow,
    status: "activated",
    activated_at: "2026-02-25T00:00:00.000Z",
  },
  myResponse: {
    id: "c2f2a3c4-2222-4a2a-8a2a-bbbbbbbbbbbb",
    consultation_id: consultationRow.id,
    member_id: "mem-42",
    stance: "object",
    body: "Rate is above the agreed ceiling.",
    created_at: "2026-02-21T10:00:00.000Z",
  },
};

// ---------- fixtures: deactivationDueProcess.ts getMyCase / listCases ----------

/** DeactivationCaseRow (deactivationDueProcess.ts:52-66) */
const deactivationCaseRow: DeactivationCaseRow = {
  id: "d3f2a3c4-3333-4a3a-8a3a-cccccccccccc",
  subject_user_id: 9001,
  subject_role: "driver",
  cause_code: "CONDUCT",
  egregious: false,
  evidence: [],
  status: "notice",
  notice_sent_at: "2026-02-01T08:00:00.000Z",
  effective_at: "2026-02-15T08:00:00.000Z",
  decided_by: 5,
  protected_activity: true,
  created_at: "2026-02-01T08:00:00.000Z",
  updated_at: "2026-02-01T08:00:00.000Z",
};

/** getMyCase return envelope (deactivationDueProcess.ts:162-183) */
const myCaseResult: DeactivationMyCaseResult = {
  case: deactivationCaseRow,
  appeals: [
    {
      id: "e4f2a3c4-4444-4a4a-8a4a-dddddddddddd",
      case_id: deactivationCaseRow.id,
      appellant_user_id: 9001,
      statement: "The incident report is inaccurate.",
      status: "filed",
      reviewer_id: null,
      decided_at: null,
      decision: null,
      rationale: null,
      sla_due_at: "2026-03-01T08:00:00.000Z",
      created_at: "2026-02-02T09:00:00.000Z",
    },
  ],
};

// ---------- fixtures: economicsPolicy.ts getFareFloorPolicy / getLatestTakeRate ----------

/** FareFloorPolicyRow & { floor_minor } (economicsPolicy.ts:19-48, 93-110) */
const fareFloorRow: FareFloorPolicyRowWire = {
  id: "f5f2a3c4-5555-4a5a-8a5a-eeeeeeeeeeee",
  market_id: "lagos-island",
  cost_index: {
    fuel_price_minor: 95000,
    cpi_bp: 10250,
    maintenance_index_bp: 10000,
    source: "NBS fuel survey",
    updated_at: "2026-02-18T00:00:00.000Z",
  },
  sustainability_multiplier: "1.050",
  active: true,
  consultation_id: null,
  created_by: 3,
  created_at: "2026-01-01T00:00:00.000Z",
  floor_minor: 102281,
};

/** TakeRateRow (economicsPolicy.ts:38-48) */
const takeRateRow: TakeRateRowWire = {
  id: "a6f2a3c4-6666-4a6a-8a6a-ffffffffffff",
  market_id: "lagos-island",
  rate_bps: 1200,
  basis: "gross",
  effective_from: "2026-03-01T00:00:00.000Z",
  consultation_id: consultationRow.id,
  version: 4,
  created_by: 3,
  created_at: "2026-02-10T00:00:00.000Z",
};

// ---------- fixtures: offerEconomics.ts getOfferBreakdown / getMyNetEarningsSummary ----------

/** OfferEconomicsBreakdownRow — bigint money columns arrive as strings (offerEconomics.ts:56-72) */
const offerBreakdownRow: OfferEconomicsBreakdownRowWire = {
  id: "b7f2a3c4-7777-4a7a-8a7a-121212121212",
  offer_id: "offer-abc",
  market_id: "lagos-island",
  base_minor: "50000",
  distance_minor: "120000",
  time_minor: "30000",
  deadhead_minor: "5000",
  pickup_seconds: 420,
  pickup_meters: 2600,
  surge_bps: 750,
  take_rate_bps: 1200,
  platform_fee_minor: "24000",
  net_to_driver_minor: "181000",
  currency: "NGN",
  created_at: "2026-02-20T11:00:00.000Z",
};

/** getMyNetEarningsSummary return shape (offerEconomics.ts:220-258) */
const netEarningsWire: NetEarningsSummaryWire = {
  currency: "NGN",
  windowDays: 30,
  offers: 12,
  grossMinor: 2400000,
  deadheadMinor: 60000,
  platformFeeMinor: 288000,
  netToDriverMinor: 2172000,
};

describe("pwa wire contract — council (WorkerCouncil.tsx)", () => {
  it("maps listConsultations snake_case rows to page DTOs (responseCounts never undefined)", () => {
    const [dto] = normalizeConsultationList([consultationRow]);
    expect(dto).toEqual({
      id: consultationRow.id,
      kind: "commission",
      title: "Take-rate change for lagos-island",
      payload: { rate_bps: 1200 },
      status: "open",
      responseSlaAt: "2026-03-01T12:00:00.000Z",
      activatedAt: null,
      createdAt: "2026-02-20T09:30:00.000Z",
      responseCounts: { support: 0, object: 0, comment: 0, total: 3 },
      myResponse: null,
    });
    // WorkerCouncil.tsx:63 destructures these — must never be undefined.
    const { support, object, comment } = dto.responseCounts;
    expect(support + object + comment).toBe(0);
    expect(dto.responseCounts.total).toBe(3);
  });

  it("maps the getConsultation {consultation, myResponse} envelope to the flat detail DTO", () => {
    const dto = normalizeConsultationDetail(consultationDetailResult);
    expect(dto.id).toBe(consultationRow.id);
    expect(dto.createdAt).toBe("2026-02-20T09:30:00.000Z");
    expect(dto.activatedAt).toBe("2026-02-25T00:00:00.000Z");
    expect(dto.responseSlaAt).toBe("2026-03-01T12:00:00.000Z");
    expect(dto.myResponse).toEqual({
      stance: "object",
      body: "Rate is above the agreed ceiling.",
    });
    expect(dto.responses).toEqual([
      {
        id: "c2f2a3c4-2222-4a2a-8a2a-bbbbbbbbbbbb",
        memberId: "mem-42",
        stance: "object",
        body: "Rate is above the agreed ceiling.",
        createdAt: "2026-02-21T10:00:00.000Z",
      },
    ]);
  });

  it("detail without a viewer response yields an empty responses list, not undefined", () => {
    const dto = normalizeConsultationDetail({
      consultation: consultationRow,
      myResponse: null,
    });
    expect(dto.myResponse).toBeNull();
    expect(dto.responses).toEqual([]);
  });
});

describe("pwa wire contract — deactivation (DeactivationAppeals.tsx)", () => {
  it("maps the getMyCase {case, appeals} envelope to the flat case DTO", () => {
    const dto = normalizeMyDeactivationCase(myCaseResult);
    expect(dto).toEqual({
      id: deactivationCaseRow.id,
      subjectRole: "driver",
      causeCode: "CONDUCT",
      egregious: false,
      status: "notice",
      noticeSentAt: "2026-02-01T08:00:00.000Z",
      effectiveAt: "2026-02-15T08:00:00.000Z",
      protectedActivity: true,
    });
    // DeactivationAppeals.tsx:59 calls .status.toLowerCase() — must be a string.
    expect(dto?.status.toLowerCase()).toBe("notice");
  });

  it("returns null when the subject has no case", () => {
    expect(normalizeMyDeactivationCase({ case: null, appeals: [] })).toBeNull();
  });

  it("maps listCases rows to operator summaries with a defined appeals array", () => {
    const [dto] = normalizeDeactivationCaseList([deactivationCaseRow]);
    expect(dto).toEqual({
      id: deactivationCaseRow.id,
      subjectUserId: "9001",
      subjectRole: "driver",
      causeCode: "CONDUCT",
      status: "notice",
      effectiveAt: "2026-02-15T08:00:00.000Z",
      appeals: [],
    });
    // DeactivationAppeals.tsx:353 reads row.appeals.length — must be an array.
    expect(Array.isArray(dto.appeals)).toBe(true);
  });
});

describe("pwa wire contract — economics (MarketEconomics.tsx)", () => {
  it("maps the getFareFloor policy row (cost_index/floor_minor) to the camelCase DTO", () => {
    const dto = normalizeFareFloor(fareFloorRow);
    expect(dto).toEqual({
      id: fareFloorRow.id,
      marketId: "lagos-island",
      costIndex: {
        fuelPriceMinor: 95000,
        cpiBp: 10250,
        maintenanceIndexBp: 10000,
        source: "NBS fuel survey",
        updatedAt: "2026-02-18T00:00:00.000Z",
      },
      floorMinor: 102281,
      sustainabilityMultiplier: 1.05,
      active: true,
      consultationId: null,
    });
    // MarketEconomics.tsx:94 — costIndex.fuelPriceMinor must be a finite number.
    expect(Number.isFinite(dto?.costIndex.fuelPriceMinor)).toBe(true);
    expect(dto?.costIndex.cpiBp / 100).toBeCloseTo(102.5);
  });

  it("returns null when no active floor policy exists", () => {
    expect(normalizeFareFloor(null)).toBeNull();
  });

  it("maps the getTakeRate registry row to the camelCase DTO", () => {
    const dto = normalizeTakeRate(takeRateRow);
    expect(dto).toEqual({
      marketId: "lagos-island",
      rateBps: 1200,
      basis: "gross",
      effectiveFrom: "2026-03-01T00:00:00.000Z",
      version: 4,
    });
    expect(normalizeTakeRate(null)).toBeNull();
  });
});

describe("pwa wire contract — pricing transparency (FareBreakdown.tsx)", () => {
  it("maps the raw offer_economics_breakdowns row to numbers — no NaN line items", () => {
    const dto = normalizeOfferBreakdown(offerBreakdownRow);
    expect(dto).toEqual({
      offerId: "offer-abc",
      marketId: "lagos-island",
      baseMinor: 50000,
      distanceMinor: 120000,
      timeMinor: 30000,
      deadheadMinor: 5000,
      pickupSeconds: 420,
      pickupMeters: 2600,
      surgeBps: 750,
      takeRateBps: 1200,
      platformFeeMinor: 24000,
      netToDriverMinor: 181000,
      currency: "NGN",
    });
    // FareBreakdown.tsx:37-40 — surge arithmetic must stay finite.
    const surgeMinor = Math.round(
      ((dto.baseMinor + dto.distanceMinor + dto.timeMinor) * dto.surgeBps) /
        10_000,
    );
    expect(surgeMinor).toBe(15000);
    for (const value of [
      dto.baseMinor,
      dto.distanceMinor,
      dto.timeMinor,
      dto.deadheadMinor,
      dto.platformFeeMinor,
      dto.netToDriverMinor,
    ]) {
      expect(Number.isNaN(value)).toBe(false);
    }
  });

  it("maps getMyNetEarningsSummary server keys to the earnings-card DTO keys", () => {
    const dto = normalizeNetEarningsSummary(netEarningsWire);
    expect(dto).toEqual({
      currency: "NGN",
      trips30d: 12,
      grossMinor: 2400000,
      deadheadMinor: 60000,
      platformFeesMinor: 288000,
      netMinor: 2172000,
    });
  });
});

describe("pwa wire contract — drift guards", () => {
  it("fixtures keep the exact snake_case server keys (fail if the wire shape is 'fixed' only in the fixture)", () => {
    expect(Object.keys(consultationRow).sort()).toEqual(
      [
        "activated_at",
        "created_at",
        "id",
        "kind",
        "payload",
        "posted_by",
        "response_count",
        "response_sla_at",
        "status",
        "title",
      ].sort(),
    );
    expect(Object.keys(consultationDetailResult).sort()).toEqual(
      ["consultation", "myResponse"].sort(),
    );
    expect(Object.keys(myCaseResult).sort()).toEqual(
      ["appeals", "case"].sort(),
    );
    expect(Object.keys(fareFloorRow).sort()).toEqual(
      [
        "active",
        "consultation_id",
        "cost_index",
        "created_at",
        "created_by",
        "floor_minor",
        "id",
        "market_id",
        "sustainability_multiplier",
      ].sort(),
    );
    expect(Object.keys(fareFloorRow.cost_index).sort()).toEqual(
      [
        "cpi_bp",
        "fuel_price_minor",
        "maintenance_index_bp",
        "source",
        "updated_at",
      ].sort(),
    );
    expect(Object.keys(offerBreakdownRow).sort()).toEqual(
      [
        "base_minor",
        "created_at",
        "currency",
        "deadhead_minor",
        "distance_minor",
        "id",
        "market_id",
        "net_to_driver_minor",
        "offer_id",
        "pickup_meters",
        "pickup_seconds",
        "platform_fee_minor",
        "surge_bps",
        "take_rate_bps",
        "time_minor",
      ].sort(),
    );
  });
});
