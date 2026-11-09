import * as Linking from "expo-linking";

/**
 * OpenRide app-to-app integration — Contract C1 (job launch deep link) and the
 * switchos://job-complete return link.
 *
 * See lib/OPENRIDE_INTEGRATION.md for the full flow and the native manifest
 * requirements on both apps. Contract field names are frozen in
 * routeplanner/INTEGRATION_SPEC.md — do not rename.
 */

/** Deep-link scheme registered by the OpenRide app. */
export const OPENRIDE_SCHEME = "openride";

/**
 * Default return link OpenRide navigates to when a job finishes. Built from
 * the same configurable app scheme used by the OAuth redirect (see
 * constants/oauth.ts), defaulting to "switchos://job-complete".
 */
const DEEP_LINK_SCHEME = process.env.EXPO_PUBLIC_SWITCHOS_URL_SCHEME ?? "switchos";
export const DEFAULT_JOB_COMPLETE_CALLBACK = `${DEEP_LINK_SCHEME}://job-complete`;

/** Contract C1 schema identifier. */
export const OPENRIDE_JOB_SCHEMA = "openride.job.v1" as const;

export type OpenRideJobKind = "ride" | "delivery";

/**
 * OpenRide routing profile names (e.g. "fastbike" | "trekking" | "carFast").
 * Typed as string because the profile catalogue is owned by OpenRide and grows
 * independently of this app.
 */
export type OpenRideProfile = string;

export type OpenRideJobPoint = {
  lat: number;
  lon: number;
  address?: string;
};

/** Contract C1 payload, serialized as base64url(JSON) on the deep link. */
export type OpenRideJobPayload = {
  schema: typeof OPENRIDE_JOB_SCHEMA;
  /** ride_trip.id or delivery order id (uuid). */
  jobId: string;
  kind: OpenRideJobKind;
  profile: OpenRideProfile;
  pickup: OpenRideJobPoint;
  dropoff: OpenRideJobPoint;
  /** Optional via-points between pickup and dropoff. */
  stops?: OpenRideJobPoint[];
  /** Which offline bundle OpenRide must activate, e.g. "lagos". */
  bundleCity: string;
  /** C2 upload target: DeliveryPlatform tRPC endpoint + driver session bearer. */
  upload: {
    url: string;
    token: string;
  };
  /** Return link OpenRide opens when the job completes, e.g. "switchos://job-complete". */
  callbackScheme: string;
};

/** Parsed result of the switchos://job-complete return link. */
export type OpenRideJobCompletion = {
  jobId: string;
  status: string;
};

// ---------------------------------------------------------------------------
// base64url encoding (no native deps; Hermes-safe)
// ---------------------------------------------------------------------------

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode a JS string as UTF-8 bytes without relying on Buffer. */
function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** base64url (RFC 4648 §5): base64 with +/ mapped to -_ and padding stripped. */
export function encodeBase64Url(value: string): string {
  const bytes = utf8Bytes(value);
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    output += BASE64_ALPHABET[b0 >> 2];
    output += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    output +=
      b1 === undefined
        ? "="
        : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    output += b2 === undefined ? "=" : BASE64_ALPHABET[b2 & 0x3f];
  }
  return output.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Contract C1 — job launch
// ---------------------------------------------------------------------------

function assertPoint(point: OpenRideJobPoint, label: string): void {
  if (
    typeof point.lat !== "number" ||
    typeof point.lon !== "number" ||
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lon) ||
    Math.abs(point.lat) > 90 ||
    Math.abs(point.lon) > 180
  ) {
    throw new Error(`OpenRide job payload: ${label} has invalid coordinates`);
  }
}

function validatePayload(payload: OpenRideJobPayload): void {
  if (payload.schema !== OPENRIDE_JOB_SCHEMA) {
    throw new Error(`OpenRide job payload: schema must be "${OPENRIDE_JOB_SCHEMA}"`);
  }
  if (!payload.jobId) {
    throw new Error("OpenRide job payload: jobId is required");
  }
  if (payload.kind !== "ride" && payload.kind !== "delivery") {
    throw new Error(`OpenRide job payload: unsupported kind "${payload.kind}"`);
  }
  if (!payload.profile) {
    throw new Error("OpenRide job payload: profile is required");
  }
  if (!payload.bundleCity) {
    throw new Error("OpenRide job payload: bundleCity is required");
  }
  if (!payload.upload.url || !payload.upload.token) {
    throw new Error("OpenRide job payload: upload.url and upload.token are required");
  }
  if (!payload.callbackScheme) {
    throw new Error("OpenRide job payload: callbackScheme is required");
  }
  assertPoint(payload.pickup, "pickup");
  assertPoint(payload.dropoff, "dropoff");
  payload.stops?.forEach((stop, index) => assertPoint(stop, `stops[${index}]`));
}

/**
 * Build the Contract C1 deep link:
 *   openride://job?payload=<base64url(JSON)>
 */
export function buildJobDeepLink(payload: OpenRideJobPayload): string {
  validatePayload(payload);
  const encoded = encodeBase64Url(JSON.stringify(payload));
  return `${OPENRIDE_SCHEME}://job?payload=${encoded}`;
}

/**
 * Launch OpenRide with a job payload.
 *
 * Returns "not-installed" when no installed app can handle the openride://
 * scheme so the caller can show install guidance. Throws when the payload is
 * invalid or the OS rejects an otherwise openable link.
 */
export async function launchOpenRideNavigation(
  payload: OpenRideJobPayload,
): Promise<"opened" | "not-installed"> {
  const url = buildJobDeepLink(payload);
  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) {
    return "not-installed";
  }
  await Linking.openURL(url);
  return "opened";
}

// ---------------------------------------------------------------------------
// Return link — switchos://job-complete?jobId=<uuid>&status=<status>
// ---------------------------------------------------------------------------

/**
 * Parse an incoming return link from OpenRide. Returns null for any URL that
 * is not a well-formed job-complete callback for this app.
 *
 * Query parsing is regex-based (same approach as app/oauth/callback.tsx) to
 * avoid relying on the Hermes URL implementation.
 */
export function parseJobCompleteCallback(
  url: string,
  expectedCallback: string = DEFAULT_JOB_COMPLETE_CALLBACK,
): OpenRideJobCompletion | null {
  if (!url) return null;
  const expected = expectedCallback.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?]+)/i);
  const incoming = url.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?]+)/i);
  if (!expected || !incoming) return null;
  if (
    incoming[1].toLowerCase() !== expected[1].toLowerCase() ||
    incoming[2].toLowerCase() !== expected[2].toLowerCase()
  ) {
    return null;
  }

  let jobId: string | null = null;
  let status: string | null = null;
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return null;
  for (const pair of url.slice(queryStart + 1).split("&")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const key = pair.slice(0, separator);
    const value = decodeURIComponent(pair.slice(separator + 1));
    if (key === "jobId") jobId = value;
    if (key === "status") status = value;
  }
  if (!jobId || !status) return null;
  return { jobId, status };
}
