import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static pins for drizzle/0102_dispute_idempotency_replay_checks.sql.
 *
 * Hardening wave: vehicle_access.open_settlement_dispute (0097) and
 * vehicle_access.decide_settlement_dispute (0097, ceiling adjusted in 0101)
 * returned success on idempotency-key replay without checking that the
 * replayed parameters match the stored row/decision. 0102 makes mismatched
 * same-key replays raise 'idempotency key replay with different parameters'
 * (ERRCODE 22023) while exact replays keep their prior behavior.
 */

const root = resolve(import.meta.dirname, "..");
const migration0102 = readFileSync(
  resolve(root, "drizzle/0102_dispute_idempotency_replay_checks.sql"),
  "utf8",
);
const migration0101 = readFileSync(
  resolve(root, "drizzle/0101_evidence_access_and_fuel_ceiling.sql"),
  "utf8",
);
const migration0097 = readFileSync(
  resolve(root, "drizzle/0097_settlement_disputes.sql"),
  "utf8",
);

const extractFn = (sql: string, name: string) => {
  const start = sql.indexOf(
    `CREATE OR REPLACE FUNCTION vehicle_access.${name}(`,
  );
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end + 3);
};

describe("drizzle/0102_dispute_idempotency_replay_checks.sql", () => {
  it("replaces both dispute functions with pinned search_path", () => {
    expect(migration0102).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.open_settlement_dispute(",
    );
    expect(migration0102).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.decide_settlement_dispute(",
    );
    const occurrences = migration0102.match(
      /SECURITY DEFINER SET search_path = pg_catalog, vehicle_access/g,
    );
    expect(occurrences).toHaveLength(2);
  });

  it("open_settlement_dispute checks stored contract_id and reason on key replay", () => {
    const fn = extractFn(migration0102, "open_settlement_dispute");
    expect(fn).toContain(
      "SELECT id, contract_id, reason INTO v_id, v_stored_contract, v_stored_reason",
    );
    expect(fn).toContain(
      "IF v_stored_contract <> p_contract OR v_stored_reason <> p_reason THEN",
    );
    expect(fn).toContain(
      "RAISE EXCEPTION 'idempotency key replay with different parameters' USING ERRCODE = '22023';",
    );
    // Exact replay still returns the stored dispute id.
    expect(fn).toContain("RETURN v_id;");
    // Real column/parameter names from 0097.
    expect(migration0097).toContain("p_actor integer, p_contract uuid, p_reason vehicle_access.dispute_reason");
  });

  it("decide_settlement_dispute checks stored status, adjustment and note on key replay", () => {
    const fn = extractFn(migration0102, "decide_settlement_dispute");
    expect(fn).toContain(
      "IF v_dispute.status <> p_status\n" +
        "         OR v_dispute.adjustment_minor IS DISTINCT FROM p_adjustment_minor\n" +
        "         OR v_dispute.operator_note IS DISTINCT FROM p_operator_note THEN",
    );
    expect(fn).toContain(
      "RAISE EXCEPTION 'idempotency key replay with different parameters' USING ERRCODE = '22023';",
    );
    // Replay gate still keyed on the prior decision event.
    expect(fn).toContain(
      "aggregate_type = 'settlement_dispute' AND aggregate_id = p_dispute AND idempotency_key = p_key",
    );
    // Non-replay on a decided dispute still raises the 0097 error.
    expect(fn).toContain("'dispute_not_open' USING ERRCODE = '23514'");
  });

  it("keeps the 0101 fuel-inclusive adjustment ceiling", () => {
    const fn = extractFn(migration0102, "decide_settlement_dispute");
    expect(fn).toContain(
      "v_max_adjustment := v_settlement.renter_damage_liability_minor + v_settlement.excess_km_charge_minor + v_settlement.fuel_charge_minor;",
    );
    expect(extractFn(migration0101, "decide_settlement_dispute")).toContain(
      "v_max_adjustment := v_settlement.renter_damage_liability_minor + v_settlement.excess_km_charge_minor + v_settlement.fuel_charge_minor;",
    );
  });

  it("changes only the replay branches versus the 0097/0101 bodies", () => {
    // Reverting exactly the 0102 replay-branch edits (and the two new DECLARE
    // lines) must reproduce the 0097/0101 function bodies byte-for-byte.
    const openFn0102 = extractFn(migration0102, "open_settlement_dispute");
    const openReverted = openFn0102
      .replace(
        "  v_id uuid;\n  v_stored_contract uuid;\n  v_stored_reason vehicle_access.dispute_reason;\n",
        "  v_id uuid;\n",
      )
      .replace(
        "  SELECT id, contract_id, reason INTO v_id, v_stored_contract, v_stored_reason\n" +
          "  FROM vehicle_access.settlement_dispute WHERE idempotency_key = p_key;\n" +
          "  IF v_id IS NOT NULL THEN\n" +
          "    -- Same-key replay: succeed only when the stored dispute matches the\n" +
          "    -- supplied parameters; a mismatched replay is a client bug and must fail\n" +
          "    -- loudly instead of silently returning the unrelated dispute id.\n" +
          "    IF v_stored_contract <> p_contract OR v_stored_reason <> p_reason THEN\n" +
          "      RAISE EXCEPTION 'idempotency key replay with different parameters' USING ERRCODE = '22023';\n" +
          "    END IF;\n" +
          "    RETURN v_id;\n" +
          "  END IF;",
        "  SELECT id INTO v_id FROM vehicle_access.settlement_dispute WHERE idempotency_key = p_key;\n" +
          "  IF v_id IS NOT NULL THEN RETURN v_id; END IF;",
      );
    expect(openReverted).toBe(extractFn(migration0097, "open_settlement_dispute"));

    const decideFn0102 = extractFn(migration0102, "decide_settlement_dispute");
    const decideReverted = decideFn0102.replace(
      "IF EXISTS (SELECT 1 FROM vehicle_access.rental_operations_event WHERE aggregate_type = 'settlement_dispute' AND aggregate_id = p_dispute AND idempotency_key = p_key) THEN\n" +
        "      -- Same-key replay: succeed only when the stored decision matches the\n" +
        "      -- supplied decision parameters; a mismatched replay is a client bug and\n" +
        "      -- must fail loudly instead of silently confirming a different decision.\n" +
        "      IF v_dispute.status <> p_status\n" +
        "         OR v_dispute.adjustment_minor IS DISTINCT FROM p_adjustment_minor\n" +
        "         OR v_dispute.operator_note IS DISTINCT FROM p_operator_note THEN\n" +
        "        RAISE EXCEPTION 'idempotency key replay with different parameters' USING ERRCODE = '22023';\n" +
        "      END IF;\n" +
        "      RETURN p_dispute;\n" +
        "    END IF;",
      "IF EXISTS (SELECT 1 FROM vehicle_access.rental_operations_event WHERE aggregate_type = 'settlement_dispute' AND aggregate_id = p_dispute AND idempotency_key = p_key) THEN RETURN p_dispute; END IF;",
    );
    expect(decideReverted).toBe(extractFn(migration0101, "decide_settlement_dispute"));
  });

  it("preserves validation order and error codes ahead of the replay branches", () => {
    const openFn = extractFn(migration0102, "open_settlement_dispute");
    const inputCheck = openFn.indexOf("'invalid settlement dispute input' USING ERRCODE = '22023'");
    const renterCheck = openFn.indexOf("'contract renter required' USING ERRCODE = '42501'");
    const replayCheck = openFn.indexOf("v_stored_contract <> p_contract");
    const openDupe = openFn.indexOf("'open dispute already exists for contract' USING ERRCODE = '23505'");
    expect(inputCheck).toBeGreaterThan(-1);
    expect(inputCheck).toBeLessThan(renterCheck);
    expect(renterCheck).toBeLessThan(replayCheck);
    expect(replayCheck).toBeLessThan(openDupe);

    const decideFn = extractFn(migration0102, "decide_settlement_dispute");
    for (const pin of [
      "'operator role required' USING ERRCODE = '42501'",
      "'invalid idempotency key' USING ERRCODE = '22023'",
      "'invalid dispute decision' USING ERRCODE = '23514'",
      "'adjustment exceeds disputable charge total' USING ERRCODE = '23514'",
      "'adjustment only permitted for adjusted disputes' USING ERRCODE = '23514'",
      "'vehicle_access.settlement_dispute.decided'",
      "'vehicle_access.contract.settlement_dispute_decided'",
    ]) {
      expect(decideFn).toContain(pin);
    }
  });

  it("guards the GRANT block behind a pg_roles existence check", () => {
    expect(migration0102).toContain(
      "IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service') THEN",
    );
    expect(migration0102).toContain(
      "GRANT EXECUTE ON FUNCTION vehicle_access.open_settlement_dispute(integer,uuid,vehicle_access.dispute_reason,text,text,timestamptz) TO vehicle_access_service;",
    );
    expect(migration0102).toContain(
      "GRANT EXECUTE ON FUNCTION vehicle_access.decide_settlement_dispute(integer,uuid,vehicle_access.dispute_status,bigint,text,text,timestamptz) TO vehicle_access_service;",
    );
  });
});
