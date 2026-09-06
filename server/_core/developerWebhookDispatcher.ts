import { createHmac } from "crypto";
import { Pool } from "pg";
import { ENV } from "./env";

type ClaimedDelivery = {
  delivery_id: string;
  endpoint_url: string;
  signing_secret_ref: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
};

let pool: Pool | null = null;
let dispatchInFlight = false;

function database() {
  if (!ENV.databaseUrl)
    throw new Error("developer_webhook_database_unconfigured");
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      max: 4,
    });
  }
  return pool;
}

function signingSecrets() {
  if (!ENV.developerWebhookSecretRefsJson) return new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(ENV.developerWebhookSecretRefsJson);
  } catch {
    throw new Error("developer_webhook_secret_refs_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("developer_webhook_secret_refs_invalid");
  const entries = Object.entries(parsed as Record<string, unknown>);
  const result = new Map<string, string>();
  for (const [reference, secret] of entries) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(reference) ||
      typeof secret !== "string" ||
      secret.length < 32 ||
      secret.length > 4096
    ) {
      throw new Error("developer_webhook_secret_refs_invalid");
    }
    result.set(reference, secret);
  }
  return result;
}

function isSuccessfulStatus(status: number) {
  return status >= 200 && status < 300;
}

async function resolveDelivery(
  delivery: ClaimedDelivery,
  secrets: Map<string, string>,
) {
  const secret = secrets.get(delivery.signing_secret_ref);
  if (!secret)
    return {
      success: false,
      status: 599,
      error: "signing_secret_reference_unavailable",
    };
  const body = JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    created_at: new Date().toISOString(),
    data: delivery.payload,
  });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  try {
    const response = await fetch(delivery.endpoint_url, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "DeliveryPlatform-Webhook/1.0",
        "X-Delivery-Id": delivery.delivery_id,
        "X-Event-Id": delivery.event_id,
        "X-Webhook-Signature-256": `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return isSuccessfulStatus(response.status)
      ? { success: true, status: response.status, error: null }
      : {
          success: false,
          status: response.status,
          error: `endpoint_http_${response.status}`,
        };
  } catch (error) {
    return {
      success: false,
      status: 599,
      error: error instanceof Error ? error.name : "network_failure",
    };
  }
}

export async function dispatchDeveloperWebhooks(limit = 25) {
  if (!ENV.developerWebhookDispatchEnabled || dispatchInFlight)
    return { published: 0, claimed: 0, delivered: 0, retried: 0 };
  dispatchInFlight = true;
  try {
    const secrets = signingSecrets();
    const db = database();
    const published = await db.query<{ published: number }>(
      `SELECT developer.publish_field_service_outbox($1) AS published`,
      [Math.min(100, Math.max(1, limit))],
    );
    const claimed = await db.query<ClaimedDelivery>(
      `SELECT * FROM developer.claim_webhook_deliveries($1)`,
      [Math.min(100, Math.max(1, limit))],
    );
    let delivered = 0;
    let retried = 0;
    for (const delivery of claimed.rows) {
      const result = await resolveDelivery(delivery, secrets);
      await db.query(
        `SELECT developer.complete_webhook_delivery($1::uuid,$2,$3,$4)`,
        [delivery.delivery_id, result.success, result.status, result.error],
      );
      if (result.success) delivered += 1;
      else retried += 1;
    }
    return {
      published: Number(published.rows[0]?.published ?? 0),
      claimed: claimed.rowCount ?? 0,
      delivered,
      retried,
    };
  } finally {
    dispatchInFlight = false;
  }
}

export function startDeveloperWebhookDispatcher() {
  if (!ENV.developerWebhookDispatchEnabled) return () => undefined;
  const timer = setInterval(() => {
    void dispatchDeveloperWebhooks().catch((error) =>
      console.error("[SwitchOS] Developer webhook dispatch failed", error),
    );
  }, 5_000);
  void dispatchDeveloperWebhooks().catch((error) =>
    console.error("[SwitchOS] Developer webhook dispatch failed", error),
  );
  return () => clearInterval(timer);
}
