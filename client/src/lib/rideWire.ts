import { formatNairaMinor } from "./consumerWire";

/**
 * P3-R ride-hailing wire normalizers. Mirrors consumerWire.ts conventions:
 * snake/camel tolerant, malformed rows dropped, money stays a minor-unit
 * string until formatted with exact integer math.
 */

export const RIDE_TERMINAL_STATES = new Set([
  "completed",
  "cancelled",
  "unfulfilled",
  "refunded",
]);

export function isRideTerminalState(state: string | null | undefined): boolean {
  return state != null && RIDE_TERMINAL_STATES.has(state);
}

export function rideStateLabel(state: string | null | undefined): string {
  switch (state) {
    case "quote_created":
      return "Quote created";
    case "requested":
      return "Finding a driver";
    case "matching":
      return "Matching you with drivers";
    case "driver_offered":
      return "Offer sent to a driver";
    case "driver_reserved":
      return "Driver reserved";
    case "driver_en_route":
      return "Driver on the way";
    case "driver_arrived":
      return "Driver has arrived";
    case "pickup_verified":
      return "Pickup confirmed";
    case "in_progress":
      return "Trip in progress";
    case "completed_pending_payment":
      return "Completing payment";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "unfulfilled":
      return "No driver available";
    case "payment_failed":
      return "Payment failed";
    case "payment_review":
      return "Payment under review";
    case "safety_paused":
      return "Paused for safety review";
    case "disputed":
      return "Under dispute";
    case "refunded":
      return "Refunded";
    default:
      return "Unknown";
  }
}

export type RideTripSummary = {
  tripId: string;
  state: string;
  pickupAddress: string;
  destinationAddress: string;
  requestedAt: string | null;
  completedAt: string | null;
  isTerminal: boolean;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pick(row: Record<string, unknown>, snake: string, camel: string) {
  return row[snake] ?? row[camel];
}

export function normalizeRideTripSummary(
  raw: unknown,
): RideTripSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const tripId = asString(pick(row, "trip_id", "tripId")) ?? asString(row.id);
  const state = asString(row.state);
  if (!tripId || !state) return null;
  return {
    tripId,
    state,
    pickupAddress: asString(pick(row, "pickup_address", "pickupAddress")) ?? "",
    destinationAddress:
      asString(pick(row, "destination_address", "destinationAddress")) ?? "",
    requestedAt: asString(pick(row, "requested_at", "requestedAt")),
    completedAt: asString(pick(row, "completed_at", "completedAt")),
    isTerminal: isRideTerminalState(state),
  };
}

export function normalizeRideTrips(raw: unknown): RideTripSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeRideTripSummary(entry))
    .filter((entry): entry is RideTripSummary => entry !== null);
}

export type RideQuote = {
  quoteId: string;
  baseKobo: string;
  distanceKobo: string;
  timeKobo: string;
  demandKobo: string;
  taxesAndFeesKobo: string;
  totalKobo: string;
  /** P7 flexible pricing modes: flat-fee platform fee ("0" on legacy quotes). */
  platformFeeKobo: string;
  feePayer: "rider" | "driver" | null;
  pricingModel: string | null;
  quotedDistanceM: number;
  quotedDurationS: number;
};

export type RideTripEvent = {
  id: string;
  sequenceNo: number;
  eventType: string;
  actorKind: string;
  previousState: string | null;
  nextState: string | null;
  occurredAt: string | null;
};

export type RideTripDetail = {
  trip: RideTripSummary & {
    assignedDriverUserId: number | null;
    cancellationActor: string | null;
    cancellationCode: string | null;
  };
  quote: RideQuote | null;
  events: RideTripEvent[];
  paymentReference: string | null;
};

export function normalizeRideQuote(raw: unknown): RideQuote | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const quoteId = asString(pick(row, "quote_id", "quoteId")) ?? asString(row.id);
  const total = pick(row, "total_kobo", "totalKobo");
  if (!quoteId || total === undefined || total === null) return null;
  const minor = (value: unknown): string => {
    const text = String(value ?? "0");
    if (!/^\d+$/.test(text)) throw new Error("invalid minor-unit amount");
    return text;
  };
  try {
    const feePayerRaw = asString(pick(row, "fee_payer", "feePayer"));
    return {
      quoteId,
      baseKobo: minor(pick(row, "base_kobo", "baseKobo")),
      distanceKobo: minor(pick(row, "distance_kobo", "distanceKobo")),
      timeKobo: minor(pick(row, "time_kobo", "timeKobo")),
      demandKobo: minor(pick(row, "demand_kobo", "demandKobo")),
      taxesAndFeesKobo: minor(
        pick(row, "taxes_and_fees_kobo", "taxesAndFeesKobo"),
      ),
      totalKobo: minor(total),
      platformFeeKobo: minor(
        pick(row, "platform_fee_kobo", "platformFeeKobo") ?? "0",
      ),
      feePayer:
        feePayerRaw === "rider" || feePayerRaw === "driver"
          ? feePayerRaw
          : null,
      pricingModel: asString(pick(row, "pricing_model", "pricingModel")),
      quotedDistanceM: Number(pick(row, "quoted_distance_m", "quotedDistanceM") ?? 0),
      quotedDurationS: Number(pick(row, "quoted_duration_s", "quotedDurationS") ?? 0),
    };
  } catch {
    return null;
  }
}

export function normalizeRideTripDetail(raw: unknown): RideTripDetail | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const tripRaw = row.trip;
  if (typeof tripRaw !== "object" || tripRaw === null) return null;
  const tripRow = tripRaw as Record<string, unknown>;
  const trip = normalizeRideTripSummary(tripRow);
  if (!trip) return null;
  const eventsRaw = Array.isArray(row.events) ? row.events : [];
  const events: RideTripEvent[] = [];
  for (const eventRaw of eventsRaw) {
    if (typeof eventRaw !== "object" || eventRaw === null) continue;
    const event = eventRaw as Record<string, unknown>;
    const id = asString(event.id);
    if (!id) continue;
    events.push({
      id,
      sequenceNo: Number(pick(event, "sequence_no", "sequenceNo") ?? 0),
      eventType: asString(pick(event, "event_type", "eventType")) ?? "event",
      actorKind: asString(pick(event, "actor_kind", "actorKind")) ?? "system",
      previousState: asString(pick(event, "previous_state", "previousState")),
      nextState: asString(pick(event, "next_state", "nextState")),
      occurredAt: asString(pick(event, "occurred_at", "occurredAt")),
    });
  }
  return {
    trip: {
      ...trip,
      assignedDriverUserId:
        typeof pick(tripRow, "assigned_driver_user_id", "assignedDriverUserId") ===
        "number"
          ? (pick(
              tripRow,
              "assigned_driver_user_id",
              "assignedDriverUserId",
            ) as number)
          : null,
      cancellationActor: asString(
        pick(tripRow, "cancellation_actor", "cancellationActor"),
      ),
      cancellationCode: asString(
        pick(tripRow, "cancellation_code", "cancellationCode"),
      ),
    },
    quote: normalizeRideQuote(row.quote),
    events,
    paymentReference: asString(pick(row, "payment_reference", "paymentReference")),
  };
}

export function formatRideFare(koboMinor: string): string {
  return formatNairaMinor(koboMinor);
}

const RIDE_KEY_MAX = 128;
const RIDE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function rideRandomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback (same pattern as consumerWire).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Retry-stable per-trip action keys: ride-{scope}-{segments}-{uuid}.
 * Regex-conformant (^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$), UUID tail always
 * preserved as the uniqueness anchor.
 */
export function generateRideActionKey(
  scope: "request" | "cancel" | "complete" | "rate",
  ...segments: Array<string | number>
): string {
  const uuid = rideRandomUuid();
  const parts = [`ride-${scope}`, ...segments, uuid].map((part) =>
    String(part).replace(/[^A-Za-z0-9._:-]+/g, "-"),
  );
  let key = parts.join("-");
  if (key.length > RIDE_KEY_MAX) {
    const head = key.slice(0, RIDE_KEY_MAX - uuid.length - 1);
    key = `${head.replace(/[^A-Za-z0-9]+$/, "")}-${uuid}`;
  }
  if (!RIDE_KEY_RE.test(key)) {
    throw new Error("ride_idempotency_key_generation_failed");
  }
  return key;
}
