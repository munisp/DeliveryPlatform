import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), "utf8");

describe("vehicle tracker bulk idempotency source integration", () => {
  const migration = read("drizzle/0061_vehicle_tracker_bulk_idempotency.sql");
  const store = read("server/_core/vehicleAccess.ts");
  const consumer = read("server/_core/vehicleTrackerProviderConsumers.ts");
  const environment = read("server/_core/env.ts");
  const validator = read(
    "scripts/testing/validate-vehicle-tracker-provider-consumers.sh",
  );

  it("preserves global non-partitioned replay identity before a future observed-time partition migration", () => {
    expect(migration).toContain("tracker_signal_idempotency");
    expect(migration).toContain("PRIMARY KEY (tracker_id, external_event_id)");
    expect(migration).toContain("UNIQUE (tracker_signal_id)");
    expect(migration).toContain(
      "tracker event id reused with different payload",
    );
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain(
      "vehicle_access_tracker_signal_idempotency_append_only",
    );
    expect(migration).toContain("ERRCODE");
    expect(migration).toContain("ERRCODE = '55000'");
  });

  it("accepts only lease-fenced bounded bulk authority calls and grants no direct table access", () => {
    expect(migration).toContain(
      "jsonb_array_length(p_records) NOT BETWEEN 1 AND 250",
    );
    expect(migration).toContain("tracker provider ingest claim fence mismatch");
    expect(migration).toContain("tracker provider ingest source mismatch");
    expect(migration).toContain(
      "REVOKE ALL ON TABLE vehicle_access.tracker_signal_idempotency FROM PUBLIC",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION vehicle_access.bulk_record_tracker_provider_signals",
    );
    expect(store).toContain("bulkRecordVehicleTrackerProviderSignals");
    expect(store).toContain(
      "vehicle_access.bulk_record_tracker_provider_signals",
    );
  });

  it("routes provider positions through chunks no larger than 250 and advances the provider cursor only after bulk outcomes", () => {
    expect(consumer).toContain("const TRACKER_BULK_RECORD_LIMIT = 250");
    expect(consumer).toContain("for (const records of chunks(");
    expect(consumer).toContain("bulkRecordVehicleTrackerProviderSignals");
    const geotabPersist = consumer.indexOf(
      "const ingested = await persistGeotabRecords",
    );
    const geotabComplete = consumer.indexOf(
      "await completeVehicleTrackerProviderIngestBatch",
      geotabPersist,
    );
    expect(geotabPersist).toBeGreaterThan(-1);
    expect(geotabComplete).toBeGreaterThan(geotabPersist);
  });

  it("uses a dedicated bounded four-to-eight connection tracker pool rather than scaling the general vehicle-access pool", () => {
    expect(environment).toContain("VEHICLE_TRACKER_DATABASE_POOL_MAX");
    expect(environment).toContain(
      '"VEHICLE_TRACKER_DATABASE_POOL_MAX",\n    4,\n    4,\n    8',
    );
    expect(store).toContain("function trackerDatabase()");
    expect(store).toContain("max: ENV.vehicleTrackerDatabasePoolMax");
    expect(store).toContain("connectionTimeoutMillis: 5_000");
    expect(store).toContain("idleTimeoutMillis: 30_000");
  });

  it("proves the disposable authority rejects altered event replay and direct registry access", () => {
    expect(validator).toContain("bulk_recorded=PASS");
    expect(validator).toContain("bulk_duplicate=PASS");
    expect(validator).toContain(
      "expected altered tracker signal rejection: SQLSTATE 23505",
    );
    expect(validator).toContain(
      "expected direct tracker idempotency denial: SQLSTATE 42501",
    );
    expect(validator).toContain(
      "expected append-only tracker identity denial: SQLSTATE 55000",
    );
  });
});
