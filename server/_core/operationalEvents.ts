import { Kafka, logLevel, type Producer } from "kafkajs";
import { Pool } from "pg";
import { ENV } from "./env";

type OperationalEvent = {
  eventType: string;
  actorId?: string | null;
  actorRole?: string | null;
  tenantId?: string | null;
  route?: string | null;
  outcome: "success" | "failure" | "info";
  payload?: Record<string, unknown>;
};

let pool: Pool | null = null;
let tablesEnsured = false;
let kafkaProducer: Producer | null = null;
let kafkaProducerConnectPromise: Promise<Producer | null> | null = null;

function getPool() {
  if (!ENV.databaseUrl) {
    return null;
  }

  if (!pool) {
    const useSsl = ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable");
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  return pool;
}

function buildEventEnvelope(event: OperationalEvent) {
  return {
    source: "switchos-operator-dashboard",
    timestamp: new Date().toISOString(),
    ...event,
  };
}

function parseKafkaBrokers() {
  return ENV.kafkaBrokers
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function getKafkaProducer() {
  const brokers = parseKafkaBrokers();
  if (brokers.length === 0 || !ENV.kafkaOperationalEventsTopic.trim()) {
    return null;
  }

  if (kafkaProducer) {
    return kafkaProducer;
  }

  if (!kafkaProducerConnectPromise) {
    kafkaProducerConnectPromise = (async () => {
      const kafka = new Kafka({
        clientId: ENV.kafkaClientId,
        brokers,
        logLevel: logLevel.NOTHING,
      });
      const producer = kafka.producer();
      await producer.connect();
      kafkaProducer = producer;
      return producer;
    })().catch((error) => {
      kafkaProducerConnectPromise = null;
      throw error;
    });
  }

  return kafkaProducerConnectPromise;
}

async function ensureTables() {
  const db = getPool();
  if (!db || tablesEnsured) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS operational_events (
      id BIGSERIAL PRIMARY KEY,
      event_type VARCHAR(128) NOT NULL,
      actor_id VARCHAR(128),
      actor_role VARCHAR(64),
      tenant_id VARCHAR(128),
      route VARCHAR(255),
      outcome VARCHAR(32) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_operational_events_event_type
      ON operational_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_operational_events_created_at
      ON operational_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_operational_events_tenant_id
      ON operational_events(tenant_id);
  `);

  tablesEnsured = true;
}

async function persistEvent(event: OperationalEvent) {
  const db = getPool();
  if (!db) return { persisted: false };

  await ensureTables();
  await db.query(
    `
      INSERT INTO operational_events (
        event_type,
        actor_id,
        actor_role,
        tenant_id,
        route,
        outcome,
        payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      event.eventType,
      event.actorId ?? null,
      event.actorRole ?? null,
      event.tenantId ?? null,
      event.route ?? null,
      event.outcome,
      JSON.stringify(event.payload ?? {}),
    ],
  );

  return { persisted: true };
}

async function publishToKafka(event: OperationalEvent) {
  const producer = await getKafkaProducer();
  if (!producer) {
    return { attempted: false };
  }

  const envelope = buildEventEnvelope(event);
  const messageKey = event.tenantId ?? event.actorId ?? event.eventType;

  await producer.send({
    topic: ENV.kafkaOperationalEventsTopic,
    messages: [
      {
        key: messageKey,
        value: JSON.stringify(envelope),
        headers: {
          "event-type": event.eventType,
          outcome: event.outcome,
          source: "switchos-operator-dashboard",
        },
      },
    ],
  });

  return { attempted: true, published: true };
}

async function publishToDapr(event: OperationalEvent) {
  if (!ENV.daprHttpPort || !ENV.daprPubsubName || !ENV.daprOperationalEventsTopic) {
    return { attempted: false };
  }

  const response = await fetch(
    `http://127.0.0.1:${ENV.daprHttpPort}/v1.0/publish/${ENV.daprPubsubName}/${ENV.daprOperationalEventsTopic}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildEventEnvelope(event)),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Dapr publish failed: ${response.status} ${text}`.trim());
  }

  return { attempted: true, published: true };
}

async function indexInOpenSearch(event: OperationalEvent) {
  if (!ENV.opensearchUrl || !ENV.opensearchOperationalEventsIndex) {
    return { attempted: false };
  }

  const baseUrl = ENV.opensearchUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/${ENV.opensearchOperationalEventsIndex}/_doc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ENV.opensearchUsername && ENV.opensearchPassword
        ? {
            Authorization: `Basic ${Buffer.from(`${ENV.opensearchUsername}:${ENV.opensearchPassword}`).toString("base64")}`,
          }
        : {}),
    },
    body: JSON.stringify(buildEventEnvelope(event)),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenSearch index failed: ${response.status} ${text}`.trim());
  }

  return { attempted: true, indexed: true };
}

export async function recordOperationalEvent(event: OperationalEvent) {
  const result = {
    persisted: false,
    kafkaPublished: false,
    daprPublished: false,
    openSearchIndexed: false,
  };

  try {
    const persisted = await persistEvent(event);
    result.persisted = persisted.persisted;
  } catch (error) {
    console.warn("[SwitchOS] Failed to persist operational event", error);
  }

  try {
    const kafka = await publishToKafka(event);
    result.kafkaPublished = Boolean(kafka.attempted);
  } catch (error) {
    console.warn("[SwitchOS] Failed to publish operational event to Kafka", error);
  }

  try {
    const dapr = await publishToDapr(event);
    result.daprPublished = Boolean(dapr.attempted);
  } catch (error) {
    console.warn("[SwitchOS] Failed to publish operational event to Dapr", error);
  }

  try {
    const indexed = await indexInOpenSearch(event);
    result.openSearchIndexed = Boolean(indexed.attempted);
  } catch (error) {
    console.warn("[SwitchOS] Failed to index operational event in OpenSearch", error);
  }

  return result;
}

export function getOperationalEventStatus() {
  const kafkaConfigured = parseKafkaBrokers().length > 0 && Boolean(ENV.kafkaOperationalEventsTopic.trim());

  return {
    postgresConfigured: Boolean(ENV.databaseUrl),
    kafkaConfigured,
    daprConfigured: Boolean(ENV.daprHttpPort && ENV.daprPubsubName && ENV.daprOperationalEventsTopic),
    openSearchConfigured: Boolean(ENV.opensearchUrl && ENV.opensearchOperationalEventsIndex),
    kafkaClientId: kafkaConfigured ? ENV.kafkaClientId : null,
    kafkaBrokers: kafkaConfigured ? parseKafkaBrokers() : [],
    kafkaOperationalEventsTopic: kafkaConfigured ? ENV.kafkaOperationalEventsTopic : null,
    daprHttpPort: ENV.daprHttpPort || null,
    daprPubsubName: ENV.daprPubsubName || null,
    daprOperationalEventsTopic: ENV.daprOperationalEventsTopic || null,
    openSearchUrl: ENV.opensearchUrl || null,
    openSearchOperationalEventsIndex: ENV.opensearchOperationalEventsIndex || null,
  };
}
