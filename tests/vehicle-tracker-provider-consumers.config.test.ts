import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), "utf8");

describe("vehicle tracker provider-consumer source integration", () => {
  const migration = read(
    "drizzle/0060_vehicle_tracker_provider_ingest_cursors.sql",
  );
  const store = read("server/_core/vehicleAccess.ts");
  const consumer = read("server/_core/vehicleTrackerProviderConsumers.ts");
  const server = read("server/_core/index.ts");
  const validator = read(
    "scripts/testing/validate-vehicle-tracker-provider-consumers.sh",
  );

  it("keeps provider cursors and batches PostgreSQL-authoritative, lease-fenced, immutable, and function-only", () => {
    expect(migration).toContain("tracker_provider_ingest_cursor");
    expect(migration).toContain("tracker_provider_ingest_batch");
    expect(migration).toContain("FOR UPDATE OF p,c SKIP LOCKED");
    expect(migration).toContain("tracker provider ingest claim fence mismatch");
    expect(migration).toContain("tracker provider ingest cursor mismatch");
    expect(migration).toContain(
      "tracker provider batch key reused with different payload",
    );
    expect(migration).toContain(
      "vehicle_access_tracker_provider_ingest_batch_append_only",
    );
    expect(migration).toContain(
      "REVOKE ALL ON TABLE vehicle_access.tracker_provider_ingest_cursor FROM PUBLIC",
    );
    expect(migration).toContain("resolve_active_tracker_for_provider_ingest");
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION vehicle_access.claim_tracker_provider_ingest",
    );
    expect(store).toContain("claimVehicleTrackerProviderIngest");
    expect(store).toContain("completeVehicleTrackerProviderIngestBatch");
    expect(store).toContain("resolveActiveVehicleTrackerForProviderIngest");
    expect(store).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\s+INTO?\s+vehicle_access\./i,
    );
  });

  it("uses the documented Geotab Authenticate session and GetFeed cursor protocol rather than an invented webhook", () => {
    expect(consumer).toContain('"Authenticate"');
    expect(consumer).toContain('"GetFeed"');
    expect(consumer).toContain('typeName: "LogRecord"');
    expect(consumer).toContain("fromVersion: provider.feedCursor");
    expect(consumer).toContain("toVersion");
    expect(consumer).toContain("geotab_getfeed");
    expect(consumer).toContain("geotabSessions");
    expect(consumer).toContain("bulkRecordVehicleTrackerProviderSignals");
    expect(consumer).toContain("const TRACKER_BULK_RECORD_LIMIT = 250");
    expect(consumer).not.toContain(
      "resolveActiveVehicleTrackerForProviderIngest",
    );
    expect(consumer).not.toContain("ingestVehicleTrackerSignal");
  });

  it("uses Traccar REST authorization and session-cookie WebSocket authentication without treating either as HMAC", () => {
    expect(consumer).toContain("authorizationHeader(config)");
    expect(consumer).toContain(
      'url.pathname = `${url.pathname.replace(/\\/$/, "")}/socket`',
    );
    expect(consumer).toContain("acquireTraccarSessionCookie");
    expect(consumer).toContain("headers: { cookie }");
    expect(consumer).toContain("traccar_rest");
    expect(consumer).toContain("traccar_websocket");
    expect(consumer).toContain("speedKnots * 1.852");
    expect(consumer).not.toMatch(
      /engine[-_ ]?stop|ignition[-_ ]?off|kill[-_ ]?switch/i,
    );
  });

  it("exposes only an internal, token-guarded polling trigger and validates durable cursor evidence", () => {
    const providerRouteStart = server.indexOf(
      '"/internal/vehicle-trackers/providers/poll-once"',
    );
    const commandRouteStart = server.indexOf(
      '"/internal/vehicle-trackers/commands/dispatch-once"',
    );
    expect(providerRouteStart).toBeGreaterThan(-1);
    expect(commandRouteStart).toBeGreaterThan(providerRouteStart);
    const providerRoute = server.slice(providerRouteStart, commandRouteStart);
    expect(providerRoute).toContain("requireInternalServiceAccess(req, res)");
    expect(providerRoute).toContain("vehicle_tracker_provider_kind_invalid");
    expect(validator).toContain(
      "expected altered provider batch rejection: SQLSTATE 23505",
    );
    expect(validator).toContain(
      "expected direct provider cursor denial: SQLSTATE 42501",
    );
    expect(validator).toContain(
      "expected append-only provider batch denial: SQLSTATE 55000",
    );
    expect(validator).toContain(
      "expected stale provider cursor denial: SQLSTATE 55000",
    );
  });
});
