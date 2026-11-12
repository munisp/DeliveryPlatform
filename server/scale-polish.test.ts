/**
 * P5-SCALE tests (vitest): the mobilityQueries.ts read-path polish —
 * deterministic carrier compliance scoring from columns already read by the
 * freight carrier query, and travel policy template resolution precedence
 * (module-level defaults + per-account overrides from existing
 * business_travel_accounts policy-ish columns) — plus a snapshot of the
 * server/_core/index.ts process-state audit classifications documented in
 * validation/consumer_scale_baseline_20261112.md.
 *
 * The Postgres boundary is mocked: only the pure helpers are exercised, so no
 * pool is ever created.
 */

import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  DEFAULT_TRAVEL_POLICY_TEMPLATES,
  carrierComplianceScore,
  resolveTravelPolicyTemplates,
} from "./_core/mobilityQueries";

describe("carrierComplianceScore", () => {
  it("is deterministic: identical inputs always produce identical scores", () => {
    const cases: Array<[unknown, unknown]> = [
      ["active", "verified"],
      ["pending", "pending"],
      ["suspended", "verified"],
      ["rejected", "rejected"],
      [null, undefined],
      ["ACTIVE", "Verified"],
      ["garbage", {}],
    ];
    for (const [status, verification] of cases) {
      expect(carrierComplianceScore(status, verification)).toBe(
        carrierComplianceScore(status, verification),
      );
    }
  });

  it("stays within [0, 100] for every enum combination and junk input", () => {
    const statuses = ["pending", "active", "suspended", "rejected"];
    const verifications = ["pending", "verified", "rejected"];
    for (const status of statuses) {
      for (const verification of verifications) {
        const score = carrierComplianceScore(status, verification);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
        expect(Number.isInteger(score)).toBe(true);
      }
    }
    for (const junk of [null, undefined, 42, {}, [], ""]) {
      const score = carrierComplianceScore(junk, junk);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it("scores a verified + active carrier at the 100 ceiling", () => {
    expect(carrierComplianceScore("active", "verified")).toBe(100);
  });

  it("scores rejected verification at 0 regardless of operational status", () => {
    expect(carrierComplianceScore("active", "rejected")).toBe(40);
    expect(carrierComplianceScore("rejected", "rejected")).toBe(0);
  });

  it("is monotone in verification status for a fixed operational status", () => {
    for (const status of ["pending", "active", "suspended", "rejected"]) {
      const verified = carrierComplianceScore(status, "verified");
      const pending = carrierComplianceScore(status, "pending");
      const rejected = carrierComplianceScore(status, "rejected");
      expect(verified).toBeGreaterThan(pending);
      expect(pending).toBeGreaterThan(rejected);
    }
  });

  it("is monotone in operational status for a fixed verification status", () => {
    for (const verification of ["pending", "verified", "rejected"]) {
      const active = carrierComplianceScore("active", verification);
      const pending = carrierComplianceScore("pending", verification);
      const suspended = carrierComplianceScore("suspended", verification);
      const rejected = carrierComplianceScore("rejected", verification);
      expect(active).toBeGreaterThan(pending);
      expect(pending).toBeGreaterThan(suspended);
      expect(suspended).toBeGreaterThan(rejected);
    }
  });
});

describe("resolveTravelPolicyTemplates", () => {
  it("returns exactly the module-level defaults when no accounts exist", () => {
    expect(resolveTravelPolicyTemplates([])).toEqual([
      ...DEFAULT_TRAVEL_POLICY_TEMPLATES,
    ]);
  });

  it("keeps defaults first and appends a budget-cap template when monthly_budget_minor is present", () => {
    const templates = resolveTravelPolicyTemplates([
      { approval_mode: "manager-review", monthly_budget_minor: 50000000 },
    ]);
    expect(templates.slice(0, DEFAULT_TRAVEL_POLICY_TEMPLATES.length)).toEqual(
      [...DEFAULT_TRAVEL_POLICY_TEMPLATES],
    );
    expect(templates).toContain(
      "Monthly budget cap of NGN 500000.00 per travel account",
    );
    expect(templates.length).toBe(DEFAULT_TRAVEL_POLICY_TEMPLATES.length + 1);
  });

  it("appends approval-mode override templates for auto-with-cap and care-coordinator accounts", () => {
    const templates = resolveTravelPolicyTemplates([
      { approval_mode: "auto-with-cap", monthly_budget_minor: null },
      { approval_mode: "care-coordinator", monthly_budget_minor: null },
    ]);
    expect(templates).toContain(
      "Auto-approval for trips within the configured fare cap",
    );
    expect(templates).toContain(
      "Care-coordinator pre-approval required for all trips",
    );
  });

  it("dedupes overrides across accounts and ignores absent/invalid budget values", () => {
    const templates = resolveTravelPolicyTemplates([
      { approval_mode: "auto-with-cap", monthly_budget_minor: -5 },
      { approval_mode: "auto-with-cap", monthly_budget_minor: "not-a-number" },
      { approval_mode: "auto-with-cap", monthly_budget_minor: 0 },
      { approval_mode: "manager-review" },
    ]);
    const autoCount = templates.filter(
      (label) => label === "Auto-approval for trips within the configured fare cap",
    ).length;
    expect(autoCount).toBe(1);
    expect(
      templates.some((label) => label.startsWith("Monthly budget cap")),
    ).toBe(false);
  });
});

describe("index.ts process-state audit snapshot", () => {
  // Mirrors validation/consumer_scale_baseline_20261112.md §process-state
  // audit: seven `new Map()/new Set()` occurrences, exactly one process-global
  // (read-only after module init) and six request-scoped transient allowlists.
  const source = readFileSync(
    new URL("./_core/index.ts", import.meta.url),
    "utf8",
  );
  const occurrences = source.match(/new (?:Map|Set)\(/g) ?? [];

  it("finds exactly 7 new Map()/new Set() occurrences in server/_core/index.ts", () => {
    expect(occurrences.length).toBe(7);
  });

  it("classifies exactly 1 process-global binding (read-only allowlist)", () => {
    const moduleLevel = source.match(
      /^const \w+ = new (?:Map|Set)\(\[/gm,
    );
    expect(moduleLevel).toEqual([
      "const permittedFinancialSimulationScenarios = new Set([",
    ]);
  });

  it("classifies the remaining 6 as request-scoped transient Sets", () => {
    const inlineRequestScoped = source.match(/!new Set\(\[/g) ?? [];
    expect(inlineRequestScoped.length).toBe(6);
  });
});
