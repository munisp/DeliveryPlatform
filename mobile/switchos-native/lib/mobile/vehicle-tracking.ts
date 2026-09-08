import * as Auth from "@/lib/_core/auth";

export type DurableVehiclePosition = {
  workOrderId: string;
  externalReference: string;
  subjectUserId: number | null;
  observedAt: string;
  longitude: number;
  latitude: number;
  accuracyM: number | null;
  integrityScore: number;
  source: string;
};

type OperationsSnapshotResponse = {
  positions?: unknown;
};

const maximumVehiclePositions = 250;

function normalizePlatformBaseUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidPosition(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;

  const position = value as Record<string, unknown>;
  return (
    typeof position.work_order_id === "string" &&
    position.work_order_id.length > 0 &&
    typeof position.external_reference === "string" &&
    position.external_reference.length > 0 &&
    typeof position.observed_at === "string" &&
    Number.isFinite(Date.parse(position.observed_at)) &&
    isFiniteNumber(position.longitude) &&
    position.longitude >= -180 &&
    position.longitude <= 180 &&
    isFiniteNumber(position.latitude) &&
    position.latitude >= -90 &&
    position.latitude <= 90 &&
    isFiniteNumber(position.integrity_score) &&
    position.integrity_score >= 0 &&
    position.integrity_score <= 100 &&
    typeof position.source === "string" &&
    position.source.length > 0
  );
}

function parsePosition(value: Record<string, unknown>): DurableVehiclePosition {
  return {
    workOrderId: value.work_order_id as string,
    externalReference: value.external_reference as string,
    subjectUserId: isFiniteNumber(value.subject_user_id)
      ? value.subject_user_id
      : null,
    observedAt: value.observed_at as string,
    longitude: value.longitude as number,
    latitude: value.latitude as number,
    accuracyM: isFiniteNumber(value.accuracy_m) ? value.accuracy_m : null,
    integrityScore: value.integrity_score as number,
    source: value.source as string,
  };
}

function responseDetail(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return fallback;
}

export async function loadDurableVehiclePositions(platformBaseUrl: string) {
  const baseUrl = normalizePlatformBaseUrl(platformBaseUrl);
  if (!baseUrl) {
    throw new Error(
      "Configure the authenticated central Platform API URL before opening vehicle tracking.",
    );
  }

  const sessionToken = await Auth.getSessionToken();
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-request-id": `mobile-tracking-${Date.now()}`,
  };
  if (sessionToken) {
    headers.authorization = `Bearer ${sessionToken}`;
  }

  const response = await fetch(`${baseUrl}/api/operations/snapshot`, {
    headers,
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("The central operations snapshot returned invalid JSON.");
    }
  }

  if (!response.ok) {
    throw new Error(
      responseDetail(
        payload,
        `Central operations snapshot returned HTTP ${response.status}.`,
      ),
    );
  }

  const positions = (payload as OperationsSnapshotResponse | null)?.positions;
  if (!Array.isArray(positions)) {
    throw new Error(
      "The central operations snapshot has no positions collection.",
    );
  }

  return positions
    .filter(isValidPosition)
    .slice(0, maximumVehiclePositions)
    .map(parsePosition);
}

export function calculateVehicleBounds(positions: DurableVehiclePosition[]) {
  if (positions.length === 0) return null;

  let west = positions[0].longitude;
  let east = positions[0].longitude;
  let south = positions[0].latitude;
  let north = positions[0].latitude;

  for (const position of positions.slice(1)) {
    west = Math.min(west, position.longitude);
    east = Math.max(east, position.longitude);
    south = Math.min(south, position.latitude);
    north = Math.max(north, position.latitude);
  }

  if (west === east) {
    west -= 0.004;
    east += 0.004;
  }
  if (south === north) {
    south -= 0.004;
    north += 0.004;
  }

  return [west, south, east, north] as [number, number, number, number];
}

export function vehicleIntegrityTone(integrityScore: number) {
  if (integrityScore >= 80) return "#22C55E";
  if (integrityScore >= 50) return "#F59E0B";
  return "#EF4444";
}
