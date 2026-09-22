import { createHash, randomUUID } from "node:crypto";

import { Kafka, logLevel, type Producer } from "kafkajs";
import pg from "pg";

import { ENV } from "./env";

const { Pool } = pg;

type OperationalEventInput = {
  eventType: string;
  actorId?: string | null;
  actorRole?: string | null;
  tenantId?: string | null;
  route?: string | null;
  outcome?: string | null;
  payload?: Record<string, unknown> | null;
};

type OperationalEventRecord = {
  event_id: string;
  event_type: string;
  actor_id: string | null;
  actor_role: string | null;
  tenant_id: string;
  route: string | null;
  outcome: string;
  occurred_at: string;
  payload: Record<string, unknown>;
};

const KAFKA_CLIENT_ID = ENV.kafkaClientId;
const KAFKA_OPERATIONAL_EVENTS_TOPIC = ENV.kafkaOperationalEventsTopic;
const DAPR_PUBSUB_NAME = ENV.daprPubsubName;
const DAPR_OPERATIONAL_EVENTS_TOPIC = ENV.daprOperationalEventsTopic;
const OPENSEARCH_OPERATIONAL_EVENTS_INDEX = ENV.opensearchOperationalEventsIndex;

const pool = new Pool({
  connectionString: ENV.databaseUrl,
  max: 2,
  idleTimeoutMillis: 10000,
  options: "-c statement_timeout=15000",
});

let kafkaProducer: Producer | null = null;
let kafkaProducerConnectPromise: Promise<void> | null = null;

function getKafkaBrokers() {
  return ENV.kafkaBrokers
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean);
}

async function persistOperationalEvent(record: OperationalEventRecord) {
  if (!ENV.databaseUrl) {
    return false;
  }

  await pool.query(
    `INSERT INTO operational_event_bridge
      (event_id, event_type, actor_id, actor_role, tenant_id, route, outcome, occurred_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      record.event_id,
      record.event_type,
      record.actor_id,
      record.actor_role,
      record.tenant_id,
      record.route,
      record.outcome,
      record.occurred_at,
      JSON.stringify(record.payload),
    ],
  );

  return true;
}

async function getKafkaProducer() {
  const brokers = getKafkaBrokers();
  if (brokers.length === 0) {
    return null;
  }

  if (!kafkaProducer) {
    kafkaProducer = new Kafka({
      clientId: KAFKA_CLIENT_ID,
      brokers,
      logLevel: logLevel.NOTHING,
    }).producer();
    kafkaProducerConnectPromise = kafkaProducer.connect();
  }

  await kafkaProducerConnectPromise;
  return kafkaProducer;
}

function buildHeaders(record: OperationalEventRecord) {
  return {
    "event-id": record.event_id,
    "event-type": record.event_type,
    "tenant-id": record.tenant_id,
    outcome: record.outcome,
  };
}

async function publishKafka(record: OperationalEventRecord) {
  const producer = await getKafkaProducer();
  if (!producer) {
    return false;
  }

  await producer.send({
    topic: KAFKA_OPERATIONAL_EVENTS_TOPIC,
    messages: [
      {
        key: record.tenant_id,
        value: JSON.stringify(record),
        headers: buildHeaders(record),
      },
    ],
  });

  return true;
}

async function publishDapr(record: OperationalEventRecord) {
  if (!ENV.daprHttpPort) {
    return false;
  }

  const response = await fetch(
    `http://127.0.0.1:${ENV.daprHttpPort}/v1.0/publish/${DAPR_PUBSUB_NAME}/${DAPR_OPERATIONAL_EVENTS_TOPIC}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    },
  );

  if (!response.ok) {
    throw new Error(`Dapr publish failed with ${response.status}: ${await response.text()}`);
  }

  return true;
}

async function indexOpenSearch(record: OperationalEventRecord) {
  if (!ENV.opensearchUrl) {
    return false;
  }

  const auth =
    ENV.opensearchUsername && ENV.opensearchPassword
      ? `Basic ${Buffer.from(`${ENV.opensearchUsername}:${ENV.opensearchPassword}`).toString("base64")}`
      : null;

  const response = await fetch(
    `${ENV.opensearchUrl.replace(/\/$/, "")}/${OPENSEARCH_OPERATIONAL_EVENTS_INDEX}/_doc`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(record),
    },
  );

  if (!response.ok) {
    throw new Error(`OpenSearch indexing failed with ${response.status}: ${await response.text()}`);
  }

  return true;
}

// Perf finding 3: broker/search publishes must not block the request path.
// recordOperationalEvent returns after the durable persist; the fan-out legs
// run on a per-event queue tracked here so failures can never reject the
// caller (they settle warn-only) and shutdown/tests can await the queue.
const pendingPublishes = new Set<Promise<void>>();

function queuePublishLeg(run: () => Promise<boolean>, label: string) {
  const pending = Promise.resolve()
    .then(run)
    .then(() => undefined)
    .catch((error) => {
      console.warn(`[SwitchOS] ${label} publish failed; continuing`, error);
    })
    .finally(() => {
      pendingPublishes.delete(pending);
    });
  pendingPublishes.add(pending);
}

export async function drainOperationalEventPublishes() {
  while (pendingPublishes.size > 0) {
    await Promise.allSettled(Array.from(pendingPublishes));
  }
}

export async function recordOperationalEvent(input: OperationalEventInput) {
  const record: OperationalEventRecord = {
    event_id: createHash("sha256").update(randomUUID()).digest("hex"),
    event_type: input.eventType,
    actor_id: input.actorId ?? null,
    actor_role: input.actorRole ?? null,
    tenant_id: input.tenantId ?? "switchos-core",
    route: input.route ?? null,
    outcome: input.outcome ?? "success",
    occurred_at: new Date().toISOString(),
    payload: input.payload ?? {},
  };

  const [persisted, kafkaPublished, daprPublished, openSearchIndexed] = await Promise.all([
    persistOperationalEvent(record),
    Promise.resolve(
      queuePublishLeg(() => publishKafka(record), "Kafka operational event"),
      true,
    ),
    Promise.resolve(
      queuePublishLeg(() => publishDapr(record), "Dapr operational event"),
      true,
    ),
    Promise.resolve(
      queuePublishLeg(() => indexOpenSearch(record), "OpenSearch operational event"),
      true,
    ),
  ]);

  return {
    eventId: record.event_id,
    persisted,
    kafkaPublished,
    daprPublished,
    openSearchIndexed,
  };
}

export function getOperationalEventStatus() {
  return {
    postgresConfigured: Boolean(ENV.databaseUrl),
    kafkaConfigured: getKafkaBrokers().length > 0,
    kafkaClientId: KAFKA_CLIENT_ID,
    kafkaBrokers: getKafkaBrokers(),
    kafkaOperationalEventsTopic: KAFKA_OPERATIONAL_EVENTS_TOPIC,
    daprConfigured: Boolean(ENV.daprHttpPort),
    daprHttpPort: ENV.daprHttpPort,
    daprPubsubName: DAPR_PUBSUB_NAME,
    daprOperationalEventsTopic: DAPR_OPERATIONAL_EVENTS_TOPIC,
    openSearchConfigured: Boolean(ENV.opensearchUrl),
    openSearchOperationalEventsIndex: OPENSEARCH_OPERATIONAL_EVENTS_INDEX,
  };
}
