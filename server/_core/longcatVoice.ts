import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { ENV } from "./env";
import { dispatchLongCatMessage } from "./notificationGateway";
import { recordOperationalEvent } from "./operationalEvents";

export type LongCatCustomerMemory = {
  profile_id: string;
  user_id: number | null;
  customer_phone: string | null;
  customer_name: string | null;
  lifetime_orders: number;
  average_order_value: number;
  last_ordered_at: string | null;
  favorite_provider_ids: string[];
  preference_tags: string[];
  accessibility_flags: string[];
  substitution_risk: "low" | "medium" | "high";
  memory_summary: string;
  last_refreshed_at: string;
  source: "postgres" | "redis-cache" | "heuristic";
};

export type LongCatVoicePriority = {
  band: "standard" | "priority" | "urgent";
  score: number;
  reason: string;
  source: "rust" | "heuristic";
};

export type LongCatVoiceSessionSnapshot = {
  session_id: string;
  status: string;
  customer_phone: string | null;
  customer_name: string | null;
  voice_channel: string;
  started_at: string;
  last_turn_at: string;
  conversation_goal: string;
  operator_prompt: string;
  priority: LongCatVoicePriority;
  memory: LongCatCustomerMemory;
  next_actions: string[];
};

export type LongCatVoiceTurnResult = {
  session_id: string;
  turn_id: number;
  assistant_message: string;
  detected_intent: string;
  next_actions: string[];
  callback_requested: boolean;
  callback_dispatch: {
    attempted: boolean;
    accepted: boolean;
    request_id: string | null;
    error: string | null;
  };
  updated_memory: LongCatCustomerMemory;
};

export type LongCatMessagingTurnResult = LongCatVoiceTurnResult & {
  message_dispatch: {
    attempted: boolean;
    accepted: boolean;
    request_id: string | null;
    error: string | null;
  };
};

export type LongCatTelephonySession = {
  ingress_id: string;
  session_id: string;
  external_call_id: string;
  telephony_provider: string;
  transport: string;
  sample_rate_hz: number;
  status: string;
  stream_started_at: string;
  stream_last_activity_at: string;
};

export type LongCatSpeechSynthesisResult = {
  requested: boolean;
  synthesized: boolean;
  engine: string;
  audio_format: string | null;
  audio_base64: string | null;
  playback_text: string;
  latency_ms: number | null;
  degraded_mode: boolean;
  engine_ready: boolean;
  degraded_reason: string | null;
  error: string | null;
};

export type LongCatTelephonyTurnResult = LongCatVoiceTurnResult & {
  telephony: {
    provider: string;
    transport: string;
    external_call_id: string;
  };
  speech: LongCatSpeechSynthesisResult;
};

export type LongCatTelephonyCloseResult = {
  session_id: string;
  external_call_id: string;
  status: string;
  closed_at: string;
  ingress_closed: boolean;
  close_reason: string;
};

type RedisCacheClient = {
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

type VoiceTurnInput = {
  sessionId: string;
  speaker: "customer" | "agent" | "system";
  utterance: string;
  channel?: string;
  metadata?: Record<string, unknown>;
};

type StartVoiceSessionInput = {
  userId?: number | null;
  customerPhone?: string | null;
  customerName?: string | null;
  voiceChannel?: string | null;
  accessibilityFlags?: string[];
  idempotencyKey?: string | null;
  triggerReason?: string | null;
};

export type StartTelephonyIngressInput = StartVoiceSessionInput & {
  externalCallId: string;
  telephonyProvider?: string | null;
  transport?: string | null;
  sampleRateHz?: number | null;
};

export type AppendTelephonyTranscriptInput = {
  sessionId: string;
  externalCallId: string;
  telephonyProvider?: string | null;
  transport?: string | null;
  speaker: "customer" | "agent" | "system";
  transcript: string;
  finalSegment?: boolean;
  metadata?: Record<string, unknown>;
};

type OllamaVoiceResponse = {
  conversation_goal?: string;
  operator_prompt?: string;
  assistant_message?: string;
  next_actions?: string[];
  detected_intent?: string;
  preference_tags?: string[];
  accessibility_flags?: string[];
  callback_requested?: boolean;
};

let pool: Pool | null = null;
let schemaEnsured = false;
let redisClientPromise: Promise<RedisCacheClient | null> | null = null;

function getPool() {
  if (!pool) {
    const useSsl = ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable");
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

async function ensureSchema() {
  if (schemaEnsured) return;
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS longcat_customer_memory_profiles (
      profile_id UUID PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      customer_phone VARCHAR(64),
      customer_name VARCHAR(255),
      lifetime_orders INTEGER NOT NULL DEFAULT 0,
      average_order_value NUMERIC(12,2) NOT NULL DEFAULT 0,
      last_ordered_at TIMESTAMPTZ,
      favorite_provider_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      preference_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      accessibility_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
      substitution_risk VARCHAR(16) NOT NULL DEFAULT 'low',
      memory_summary TEXT NOT NULL DEFAULT '',
      source VARCHAR(32) NOT NULL DEFAULT 'postgres',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id),
      UNIQUE (customer_phone)
    );

    CREATE INDEX IF NOT EXISTS idx_longcat_customer_memory_updated_at
      ON longcat_customer_memory_profiles(updated_at DESC);

    CREATE TABLE IF NOT EXISTS longcat_voice_sessions (
      session_id UUID PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      customer_phone VARCHAR(64),
      customer_name VARCHAR(255),
      voice_channel VARCHAR(64) NOT NULL DEFAULT 'phone_ordering',
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      idempotency_key VARCHAR(255),
      trigger_reason TEXT,
      conversation_goal TEXT NOT NULL DEFAULT '',
      operator_prompt TEXT NOT NULL DEFAULT '',
      current_context JSONB NOT NULL DEFAULT '{}'::jsonb,
      memory_profile_id UUID REFERENCES longcat_customer_memory_profiles(profile_id) ON DELETE SET NULL,
      priority_band VARCHAR(16) NOT NULL DEFAULT 'standard',
      priority_score NUMERIC(10,2) NOT NULL DEFAULT 0,
      priority_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_turn_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      UNIQUE (idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_longcat_voice_sessions_status
      ON longcat_voice_sessions(status, last_turn_at DESC);

    CREATE TABLE IF NOT EXISTS longcat_voice_turns (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES longcat_voice_sessions(session_id) ON DELETE CASCADE,
      speaker VARCHAR(16) NOT NULL,
      utterance TEXT NOT NULL,
      detected_intent VARCHAR(128),
      assistant_message TEXT,
      next_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      callback_requested BOOLEAN NOT NULL DEFAULT false,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_longcat_voice_turns_session_id
      ON longcat_voice_turns(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS longcat_voice_ingress_sessions (
      ingress_id UUID PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES longcat_voice_sessions(session_id) ON DELETE CASCADE,
      external_call_id VARCHAR(255) NOT NULL,
      telephony_provider VARCHAR(64) NOT NULL DEFAULT 'asterisk',
      transport VARCHAR(64) NOT NULL DEFAULT 'audiosocket',
      sample_rate_hz INTEGER NOT NULL DEFAULT 16000,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      stream_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stream_last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (external_call_id)
    );

    CREATE INDEX IF NOT EXISTS idx_longcat_voice_ingress_session_id
      ON longcat_voice_ingress_sessions(session_id, stream_last_activity_at DESC);

    CREATE TABLE IF NOT EXISTS longcat_voice_speech_events (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES longcat_voice_sessions(session_id) ON DELETE CASCADE,
      direction VARCHAR(16) NOT NULL,
      engine VARCHAR(64) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      transcript TEXT,
      playback_text TEXT,
      audio_format VARCHAR(32),
      degraded_mode BOOLEAN NOT NULL DEFAULT FALSE,
      latency_ms INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_longcat_voice_speech_events_session_id
      ON longcat_voice_speech_events(session_id, created_at DESC);
  `);
  schemaEnsured = true;
}

function normalizePhone(phone?: string | null) {
  const normalized = `${phone ?? ""}`.replace(/[^\d+]/g, "").trim();
  return normalized.length > 0 ? normalized : null;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "ready"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "not_ready"].includes(normalized)) return false;
  }
  return fallback;
}

function buildCacheKey(input: { userId?: number | null; customerPhone?: string | null }) {
  return `switchos:longcat:memory:${input.userId ?? "anon"}:${normalizePhone(input.customerPhone) ?? "no-phone"}`;
}

async function getRedisClient(): Promise<RedisCacheClient | null> {
  if (!ENV.redisUrl?.trim()) {
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      try {
        const { createClient } = await import("redis");
        const client = createClient({ url: ENV.redisUrl });
        await client.connect();
        return client as unknown as RedisCacheClient;
      } catch (error) {
        console.warn("[SwitchOS] Failed to initialize LongCat Redis cache", error);
        redisClientPromise = null;
        return null;
      }
    })();
  }

  return redisClientPromise;
}

async function readCachedMemory(input: { userId?: number | null; customerPhone?: string | null }) {
  const client = await getRedisClient();
  if (!client) return null;

  try {
    const cached = await client.get(buildCacheKey(input));
    if (!cached) return null;
    const parsed = JSON.parse(cached) as LongCatCustomerMemory;
    return { ...parsed, source: "redis-cache" as const };
  } catch (error) {
    console.warn("[SwitchOS] Failed to read LongCat memory cache", error);
    return null;
  }
}

async function writeCachedMemory(input: { userId?: number | null; customerPhone?: string | null }, memory: LongCatCustomerMemory) {
  const client = await getRedisClient();
  if (!client) return;

  try {
    await client.set(buildCacheKey(input), JSON.stringify(memory), {
      EX: ENV.longcatMemoryCacheTtlSeconds,
    });
  } catch (error) {
    console.warn("[SwitchOS] Failed to write LongCat memory cache", error);
  }
}

function providerIdsFromOrders(rows: Array<Record<string, unknown>>) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const providerId = `${row.provider_id ?? ""}`.trim();
    if (!providerId) continue;
    counts.set(providerId, (counts.get(providerId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([providerId]) => providerId);
}

function derivePreferenceTags(rows: Array<Record<string, unknown>>, requestedAccessibility: string[] = []) {
  const tags = new Set<string>();
  for (const row of rows) {
    const notes = `${row.notes ?? ""}`.toLowerCase();
    if (notes.includes("spicy")) tags.add("spicy-lover");
    if (notes.includes("vegan") || notes.includes("vegetarian")) tags.add("plant-forward");
    if (notes.includes("allergy") || notes.includes("gluten") || notes.includes("halal")) tags.add("diet-sensitive");
    if (notes.includes("substitut") || notes.includes("unavailable")) tags.add("substitution-prone");
    if (notes.includes("call") || notes.includes("confirm")) tags.add("confirmation-heavy");
  }
  for (const flag of requestedAccessibility) {
    if (flag.trim()) tags.add(flag.trim());
  }
  return [...tags].slice(0, 6);
}

function deriveSubstitutionRisk(rows: Array<Record<string, unknown>>): LongCatCustomerMemory["substitution_risk"] {
  const notesBlob = rows.map((row) => `${row.notes ?? ""}`.toLowerCase()).join(" ");
  const count = (notesBlob.match(/substitut|unavailable|out of stock/g) ?? []).length;
  if (count >= 4) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function buildMemorySummary(memory: Omit<LongCatCustomerMemory, "source">) {
  const merchantHint = memory.favorite_provider_ids.length > 0
    ? `Frequent merchant IDs: ${memory.favorite_provider_ids.join(", ")}.`
    : "No stable merchant preference has been learned yet.";
  const preferenceHint = memory.preference_tags.length > 0
    ? `Preference tags: ${memory.preference_tags.join(", ")}.`
    : "Preference tags are still sparse, so keep questions explicit and short.";
  const accessHint = memory.accessibility_flags.length > 0
    ? `Accessibility flags: ${memory.accessibility_flags.join(", ")}.`
    : "No accessibility flags are currently stored.";
  return `Customer memory shows ${memory.lifetime_orders} recent tracked orders with an average value of ${memory.average_order_value.toFixed(2)}. ${merchantHint} ${preferenceHint} ${accessHint} Substitution risk is ${memory.substitution_risk}.`;
}

async function loadRecentOrders(userId?: number | null) {
  if (!userId) return [] as Array<Record<string, unknown>>;
  const db = getPool();
  try {
    const result = await db.query(
      `SELECT id, provider_id, total_amount, status, notes, COALESCE(updated_at, created_at) AS activity_at
       FROM orders
       WHERE user_id = $1
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT 25`,
      [userId],
    );
    return result.rows as Array<Record<string, unknown>>;
  } catch (error) {
    console.warn("[SwitchOS] Failed to load LongCat recent orders", error);
    return [];
  }
}

async function persistMemory(memory: LongCatCustomerMemory) {
  const db = getPool();

  if (memory.customer_phone) {
    await db.query(
      `INSERT INTO longcat_customer_memory_profiles (
         profile_id,
         user_id,
         customer_phone,
         customer_name,
         lifetime_orders,
         average_order_value,
         last_ordered_at,
         favorite_provider_ids,
         preference_tags,
         accessibility_flags,
         substitution_risk,
         memory_summary,
         source,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, NOW())
       ON CONFLICT (customer_phone) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         customer_name = EXCLUDED.customer_name,
         lifetime_orders = EXCLUDED.lifetime_orders,
         average_order_value = EXCLUDED.average_order_value,
         last_ordered_at = EXCLUDED.last_ordered_at,
         favorite_provider_ids = EXCLUDED.favorite_provider_ids,
         preference_tags = EXCLUDED.preference_tags,
         accessibility_flags = EXCLUDED.accessibility_flags,
         substitution_risk = EXCLUDED.substitution_risk,
         memory_summary = EXCLUDED.memory_summary,
         source = EXCLUDED.source,
         updated_at = NOW()`,
      [
        memory.profile_id,
        memory.user_id,
        memory.customer_phone,
        memory.customer_name,
        memory.lifetime_orders,
        memory.average_order_value,
        memory.last_ordered_at,
        JSON.stringify(memory.favorite_provider_ids),
        JSON.stringify(memory.preference_tags),
        JSON.stringify(memory.accessibility_flags),
        memory.substitution_risk,
        memory.memory_summary,
        memory.source,
      ],
    );
    return;
  }

  await db.query(
    `INSERT INTO longcat_customer_memory_profiles (
       profile_id,
       user_id,
       customer_phone,
       customer_name,
       lifetime_orders,
       average_order_value,
       last_ordered_at,
       favorite_provider_ids,
       preference_tags,
       accessibility_flags,
       substitution_risk,
       memory_summary,
       source,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, NOW())
     ON CONFLICT (profile_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       customer_phone = EXCLUDED.customer_phone,
       customer_name = EXCLUDED.customer_name,
       lifetime_orders = EXCLUDED.lifetime_orders,
       average_order_value = EXCLUDED.average_order_value,
       last_ordered_at = EXCLUDED.last_ordered_at,
       favorite_provider_ids = EXCLUDED.favorite_provider_ids,
       preference_tags = EXCLUDED.preference_tags,
       accessibility_flags = EXCLUDED.accessibility_flags,
       substitution_risk = EXCLUDED.substitution_risk,
       memory_summary = EXCLUDED.memory_summary,
       source = EXCLUDED.source,
       updated_at = NOW()`,
    [
      memory.profile_id,
      memory.user_id,
      memory.customer_phone,
      memory.customer_name,
      memory.lifetime_orders,
      memory.average_order_value,
      memory.last_ordered_at,
      JSON.stringify(memory.favorite_provider_ids),
      JSON.stringify(memory.preference_tags),
      JSON.stringify(memory.accessibility_flags),
      memory.substitution_risk,
      memory.memory_summary,
      memory.source,
    ],
  );
}

async function ingestLakehouse(tableName: string, rows: Array<Record<string, unknown>>) {
  if (!ENV.lakehouseServiceUrl || rows.length === 0) return;
  try {
    await fetch(`${ENV.lakehouseServiceUrl}/ingest/${tableName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Token": ENV.internalServiceToken,
      },
      body: JSON.stringify({ rows }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.warn("[SwitchOS] Failed to ingest LongCat rows into lakehouse", error);
  }
}

function parseJsonObject<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function generateVoiceResponse(prompt: string): Promise<OllamaVoiceResponse | null> {
  if (!ENV.ollamaUrl || !ENV.ollamaModel) return null;

  try {
    const response = await fetch(`${ENV.ollamaUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ENV.ollamaModel,
        prompt,
        stream: false,
        format: "json",
      }),
      signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS ?? 90_000)),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { response?: string };
    return parseJsonObject<OllamaVoiceResponse>(payload.response ?? "");
  } catch {
    return null;
  }
}

async function scoreVoicePriority(input: {
  activeCalls: number;
  staffedLines: number;
  substitutionCases: number;
  lifetimeOrders: number;
  substitutionRisk: LongCatCustomerMemory["substitution_risk"];
}) : Promise<LongCatVoicePriority> {
  try {
    const response = await fetch(`${ENV.dispatchOptimizerUrl.replace(/\/$/, "")}/voice-priority`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Token": ENV.internalServiceToken,
      },
      body: JSON.stringify({
        active_calls: input.activeCalls,
        staffed_lines: input.staffedLines,
        substitution_cases: input.substitutionCases,
        lifetime_orders: input.lifetimeOrders,
        substitution_risk: input.substitutionRisk,
      }),
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) {
      throw new Error(`dispatch optimizer returned HTTP ${response.status}`);
    }
    const payload = await response.json() as { band?: string; score?: number; reason?: string };
    const band = payload.band === "urgent" || payload.band === "priority" ? payload.band : "standard";
    return {
      band,
      score: Math.max(0, Math.min(100, toNumber(payload.score))),
      reason: `${payload.reason ?? "Voice priority scored by Rust dispatch optimizer."}`,
      source: "rust",
    };
  } catch {
    const congestion = input.staffedLines > 0 ? input.activeCalls / input.staffedLines : input.activeCalls;
    let band: LongCatVoicePriority["band"] = "standard";
    let score = 42;
    if (congestion > 1.2 || input.substitutionCases >= 3 || input.substitutionRisk === "high") {
      band = "priority";
      score = 71;
    }
    if (congestion > 1.75 || input.substitutionCases >= 5) {
      band = "urgent";
      score = 88;
    }
    return {
      band,
      score,
      reason: "Voice priority scored heuristically from queue pressure and substitution risk.",
      source: "heuristic",
    };
  }
}

export async function getLongCatCustomerMemory(input: {
  userId?: number | null;
  customerPhone?: string | null;
  customerName?: string | null;
  accessibilityFlags?: string[];
}): Promise<LongCatCustomerMemory> {
  await ensureSchema();
  const normalizedPhone = normalizePhone(input.customerPhone);
  const cached = await readCachedMemory({ userId: input.userId, customerPhone: normalizedPhone });
  if (cached) return cached;

  const db = getPool();
  const existingProfile = normalizedPhone
    ? await db.query<{ profile_id: string }>(
        `SELECT profile_id
         FROM longcat_customer_memory_profiles
         WHERE customer_phone = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [normalizedPhone],
      ).then((result) => result.rows[0] ?? null)
    : null;

  const orders = await loadRecentOrders(input.userId);
  const lifetimeOrders = orders.length;
  const averageOrderValue = lifetimeOrders > 0
    ? orders.reduce((sum, row) => sum + toNumber(row.total_amount), 0) / lifetimeOrders
    : 0;
  const lastOrderedAt = orders.length > 0
    ? new Date(`${orders[0].activity_at ?? new Date().toISOString()}`).toISOString()
    : null;
  const favoriteProviderIds = providerIdsFromOrders(orders);
  const preferenceTags = derivePreferenceTags(orders, input.accessibilityFlags ?? []);
  const substitutionRisk = deriveSubstitutionRisk(orders);

  const memoryBase = {
    profile_id: existingProfile?.profile_id ?? randomUUID(),
    user_id: input.userId ?? null,
    customer_phone: normalizedPhone,
    customer_name: input.customerName?.trim() || null,
    lifetime_orders: lifetimeOrders,
    average_order_value: Number(averageOrderValue.toFixed(2)),
    last_ordered_at: lastOrderedAt,
    favorite_provider_ids: favoriteProviderIds,
    preference_tags: preferenceTags,
    accessibility_flags: (input.accessibilityFlags ?? []).map((value) => value.trim()).filter(Boolean),
    substitution_risk: substitutionRisk,
    memory_summary: "",
    last_refreshed_at: new Date().toISOString(),
  } as Omit<LongCatCustomerMemory, "source">;

  const memory: LongCatCustomerMemory = {
    ...memoryBase,
    memory_summary: buildMemorySummary(memoryBase),
    source: "postgres",
  };

  await persistMemory(memory);
  await writeCachedMemory({ userId: input.userId, customerPhone: normalizedPhone }, memory);
  await ingestLakehouse("longcat_memory_events", [{
    profile_id: memory.profile_id,
    user_id: memory.user_id,
    customer_phone: memory.customer_phone,
    customer_name: memory.customer_name,
    lifetime_orders: memory.lifetime_orders,
    average_order_value: memory.average_order_value,
    substitution_risk: memory.substitution_risk,
    preference_tags: memory.preference_tags,
    accessibility_flags: memory.accessibility_flags,
    timestamp: memory.last_refreshed_at,
    created_at: memory.last_refreshed_at,
    date: memory.last_refreshed_at.slice(0, 10),
  }]);
  await recordOperationalEvent({
    eventType: "longcat.memory.refreshed",
    outcome: "info",
    payload: {
      userId: memory.user_id,
      customerPhone: memory.customer_phone,
      lifetimeOrders: memory.lifetime_orders,
      source: memory.source,
    },
  });

  return memory;
}

export async function startLongCatVoiceSession(input: StartVoiceSessionInput): Promise<LongCatVoiceSessionSnapshot> {
  await ensureSchema();

  const memory = await getLongCatCustomerMemory({
    userId: input.userId ?? null,
    customerPhone: input.customerPhone ?? null,
    customerName: input.customerName ?? null,
    accessibilityFlags: input.accessibilityFlags ?? [],
  });
  const priority = await scoreVoicePriority({
    activeCalls: 6,
    staffedLines: 4,
    substitutionCases: memory.substitution_risk === "high" ? 4 : memory.substitution_risk === "medium" ? 2 : 0,
    lifetimeOrders: memory.lifetime_orders,
    substitutionRisk: memory.substitution_risk,
  });

  const generated = await generateVoiceResponse([
    "You are LongCat Concierge operating a live voice-ordering assistant for a food-delivery platform.",
    "Return JSON only with keys conversation_goal, operator_prompt, next_actions.",
    `Customer memory: ${memory.memory_summary}`,
    `Priority: ${priority.band} with score ${priority.score}.`,
    `Trigger reason: ${input.triggerReason ?? "phone ordering assistance"}.`,
    "Keep the conversation short, accessible, and safe for human operator handoff."
  ].join("\n"));

  const conversationGoal = `${generated?.conversation_goal ?? `Convert the call quickly while respecting ${memory.substitution_risk} substitution risk and any accessibility needs.`}`.trim();
  const operatorPrompt = `${generated?.operator_prompt ?? "Confirm the core order first, then use stored preference hints only if they clearly reduce friction."}`.trim();
  const nextActions = toStringList(generated?.next_actions).slice(0, 4);
  if (nextActions.length === 0) {
    nextActions.push(
      "Confirm the customer address and payment method in one pass.",
      "Use stored preference hints only when they reduce call time or substitution friction.",
      "Escalate callback handling if the caller needs unavailable-item confirmation from the merchant.",
    );
  }

  const db = getPool();
  const sessionId = randomUUID();
  await db.query(
    `INSERT INTO longcat_voice_sessions (
       session_id,
       user_id,
       customer_phone,
       customer_name,
       voice_channel,
       status,
       idempotency_key,
       trigger_reason,
       conversation_goal,
       operator_prompt,
       current_context,
       memory_profile_id,
       priority_band,
       priority_score,
       priority_reason,
       last_turn_at
     ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, NOW())`,
    [
      sessionId,
      memory.user_id,
      memory.customer_phone,
      memory.customer_name,
      input.voiceChannel?.trim() || "phone_ordering",
      input.idempotencyKey?.trim() || null,
      input.triggerReason?.trim() || null,
      conversationGoal,
      operatorPrompt,
      JSON.stringify({ nextActions }),
      memory.profile_id,
      priority.band,
      priority.score,
      priority.reason,
    ],
  );

  await ingestLakehouse("longcat_voice_sessions", [{
    session_id: sessionId,
    user_id: memory.user_id,
    customer_phone: memory.customer_phone,
    customer_name: memory.customer_name,
    voice_channel: input.voiceChannel?.trim() || "phone_ordering",
    priority_band: priority.band,
    priority_score: priority.score,
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
  }]);

  await recordOperationalEvent({
    eventType: "longcat.voice.session_started",
    outcome: "success",
    payload: {
      sessionId,
      userId: memory.user_id,
      priorityBand: priority.band,
      prioritySource: priority.source,
      voiceChannel: input.voiceChannel?.trim() || "phone_ordering",
    },
  });

  return {
    session_id: sessionId,
    status: "active",
    customer_phone: memory.customer_phone,
    customer_name: memory.customer_name,
    voice_channel: input.voiceChannel?.trim() || "phone_ordering",
    started_at: new Date().toISOString(),
    last_turn_at: new Date().toISOString(),
    conversation_goal: conversationGoal,
    operator_prompt: operatorPrompt,
    priority,
    memory,
    next_actions: nextActions,
  };
}

export async function startLongCatMessagingSession(input: StartVoiceSessionInput): Promise<LongCatVoiceSessionSnapshot> {
  return startLongCatVoiceSession({
    ...input,
    voiceChannel: input.voiceChannel?.trim() || "sms_ordering",
    triggerReason: input.triggerReason?.trim() || "messaging assistance",
  });
}

async function requestVoiceCallback(sessionId: string, memory: LongCatCustomerMemory, reason: string) {
  if (!memory.customer_phone) {
    return { attempted: false, accepted: false, request_id: null, error: "customer phone not configured" };
  }

  try {
    const payload = await dispatchLongCatMessage({
      customerPhone: memory.customer_phone,
      customerName: memory.customer_name,
      sessionId,
      message: reason,
      channel: "voice",
      reason,
    });
    return {
      attempted: true,
      accepted: payload.accepted,
      request_id: payload.requestId,
      error: payload.accepted ? null : "callback_dispatch_rejected",
    };
  } catch (error) {
    return {
      attempted: true,
      accepted: false,
      request_id: null,
      error: error instanceof Error ? error.message : "callback_dispatch_failed",
    };
  }
}

async function recordSpeechEvent(input: {
  sessionId: string;
  direction: "ingress" | "egress";
  engine: string;
  eventType: string;
  transcript?: string | null;
  playbackText?: string | null;
  audioFormat?: string | null;
  degradedMode?: boolean;
  latencyMs?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const db = getPool();
  await db.query(
    `INSERT INTO longcat_voice_speech_events (
       session_id,
       direction,
       engine,
       event_type,
       transcript,
       playback_text,
       audio_format,
       degraded_mode,
       latency_ms,
       metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      input.sessionId,
      input.direction,
      input.engine,
      input.eventType,
      input.transcript ?? null,
      input.playbackText ?? null,
      input.audioFormat ?? null,
      Boolean(input.degradedMode),
      input.latencyMs ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function synthesizeLongCatSpeech(input: {
  sessionId: string;
  text: string;
  voice?: string | null;
  channel?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<LongCatSpeechSynthesisResult> {
  await ensureSchema();
  const playbackText = input.text.trim();
  if (!playbackText) {
    return {
      requested: false,
      synthesized: false,
      engine: ENV.longcatSpeechTtsEngine,
      audio_format: null,
      audio_base64: null,
      playback_text: "",
      latency_ms: null,
      degraded_mode: true,
      engine_ready: false,
      degraded_reason: "empty_playback_text",
      error: "empty_playback_text",
    };
  }

  const start = Date.now();
  try {
    const response = await fetch(`${ENV.longcatSpeechServiceUrl.replace(/\/$/, "")}/tts/synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Token": ENV.internalServiceToken,
      },
      body: JSON.stringify({
        session_id: input.sessionId,
        text: playbackText,
        voice: input.voice ?? "default",
        channel: input.channel ?? "phone_ordering",
        engine: ENV.longcatSpeechTtsEngine,
        metadata: input.metadata ?? {},
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const degradedMode = toBoolean(payload.degraded_mode, !response.ok);
    const degradedReason = payload.degraded_reason ? String(payload.degraded_reason) : (response.ok ? null : `${payload.error ?? `speech_service_http_${response.status}`}`);
    const result: LongCatSpeechSynthesisResult = {
      requested: true,
      synthesized: Boolean(payload.synthesized ?? response.ok),
      engine: `${payload.engine ?? ENV.longcatSpeechTtsEngine}`,
      audio_format: payload.audio_format ? String(payload.audio_format) : null,
      audio_base64: payload.audio_base64 ? String(payload.audio_base64) : null,
      playback_text: payload.playback_text ? String(payload.playback_text) : playbackText,
      latency_ms: toNumber(payload.latency_ms) || Date.now() - start,
      degraded_mode: degradedMode,
      engine_ready: toBoolean(payload.engine_ready, !degradedMode),
      degraded_reason: degradedReason,
      error: response.ok ? null : `${payload.error ?? `speech_service_http_${response.status}`}`,
    };
    await recordSpeechEvent({
      sessionId: input.sessionId,
      direction: "egress",
      engine: result.engine,
      eventType: "tts_synthesized",
      playbackText: result.playback_text,
      audioFormat: result.audio_format,
      degradedMode: result.degraded_mode,
      latencyMs: result.latency_ms,
      metadata: {
        ...(input.metadata ?? {}),
        engine_ready: result.engine_ready,
        degraded_reason: result.degraded_reason,
      },
    });
    return result;
  } catch (error) {
    const result: LongCatSpeechSynthesisResult = {
      requested: true,
      synthesized: false,
      engine: ENV.longcatSpeechTtsEngine,
      audio_format: null,
      audio_base64: null,
      playback_text: playbackText,
      latency_ms: Date.now() - start,
      degraded_mode: true,
      engine_ready: false,
      degraded_reason: error instanceof Error ? error.message : "speech_service_unavailable",
      error: error instanceof Error ? error.message : "speech_service_unavailable",
    };
    await recordSpeechEvent({
      sessionId: input.sessionId,
      direction: "egress",
      engine: result.engine,
      eventType: "tts_fallback",
      playbackText: result.playback_text,
      degradedMode: true,
      latencyMs: result.latency_ms,
      metadata: {
        ...(input.metadata ?? {}),
        error: result.error,
        engine_ready: result.engine_ready,
        degraded_reason: result.degraded_reason,
      },
    });
    return result;
  }
}

export async function startLongCatTelephonyIngressSession(input: StartTelephonyIngressInput): Promise<LongCatVoiceSessionSnapshot & { telephony: LongCatTelephonySession }> {
  await ensureSchema();
  const session = await startLongCatVoiceSession({
    userId: input.userId ?? null,
    customerPhone: input.customerPhone ?? null,
    customerName: input.customerName ?? null,
    voiceChannel: input.voiceChannel ?? input.transport ?? input.telephonyProvider ?? "phone_ordering",
    accessibilityFlags: input.accessibilityFlags ?? [],
    idempotencyKey: input.idempotencyKey ?? `telephony-${input.externalCallId}`,
    triggerReason: input.triggerReason ?? `telephony_ingress:${input.telephonyProvider ?? "asterisk"}`,
  });

  const ingressId = randomUUID();
  const telephony: LongCatTelephonySession = {
    ingress_id: ingressId,
    session_id: session.session_id,
    external_call_id: input.externalCallId.trim(),
    telephony_provider: (input.telephonyProvider?.trim() || "asterisk"),
    transport: (input.transport?.trim() || ENV.longcatTelephonyMode || "audiosocket"),
    sample_rate_hz: Math.max(8_000, Number(input.sampleRateHz ?? 16_000) || 16_000),
    status: "active",
    stream_started_at: new Date().toISOString(),
    stream_last_activity_at: new Date().toISOString(),
  };

  const db = getPool();
  await db.query(
    `INSERT INTO longcat_voice_ingress_sessions (
       ingress_id,
       session_id,
       external_call_id,
       telephony_provider,
       transport,
       sample_rate_hz,
       status,
       metadata,
       stream_started_at,
       stream_last_activity_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb, NOW(), NOW())
     ON CONFLICT (external_call_id) DO UPDATE SET
       session_id = EXCLUDED.session_id,
       telephony_provider = EXCLUDED.telephony_provider,
       transport = EXCLUDED.transport,
       sample_rate_hz = EXCLUDED.sample_rate_hz,
       status = 'active',
       metadata = EXCLUDED.metadata,
       stream_last_activity_at = NOW(),
       updated_at = NOW()`,
    [
      ingressId,
      session.session_id,
      telephony.external_call_id,
      telephony.telephony_provider,
      telephony.transport,
      telephony.sample_rate_hz,
      JSON.stringify({
        telephony_mode: ENV.longcatTelephonyMode,
        speech_stt_engine: ENV.longcatSpeechSttEngine,
        speech_tts_engine: ENV.longcatSpeechTtsEngine,
      }),
    ],
  );

  await recordOperationalEvent({
    eventType: "longcat.voice.telephony_ingress_started",
    outcome: "success",
    payload: {
      sessionId: session.session_id,
      externalCallId: telephony.external_call_id,
      provider: telephony.telephony_provider,
      transport: telephony.transport,
    },
  });

  return { ...session, telephony };
}

export async function appendLongCatTelephonyTranscript(input: AppendTelephonyTranscriptInput): Promise<LongCatTelephonyTurnResult> {
  await ensureSchema();
  const baseResult = await appendLongCatVoiceTurn({
    sessionId: input.sessionId,
    speaker: input.speaker,
    utterance: input.transcript,
    channel: input.transport ?? input.telephonyProvider ?? "telephony",
    metadata: {
      ...(input.metadata ?? {}),
      external_call_id: input.externalCallId,
      telephony_provider: input.telephonyProvider ?? "asterisk",
      transport: input.transport ?? ENV.longcatTelephonyMode,
      final_segment: Boolean(input.finalSegment),
    },
  });

  const db = getPool();
  await db.query(
    `UPDATE longcat_voice_ingress_sessions
     SET stream_last_activity_at = NOW(),
         updated_at = NOW()
     WHERE session_id = $1 AND external_call_id = $2`,
    [input.sessionId, input.externalCallId],
  );

  const sttEngine = typeof input.metadata?.stt_engine === "string" && input.metadata.stt_engine.trim()
    ? input.metadata.stt_engine.trim()
    : ENV.longcatSpeechSttEngine;
  const sttDegradedMode = toBoolean(input.metadata?.stt_degraded_mode ?? input.metadata?.stt_degraded, false);
  const sttEngineReady = toBoolean(input.metadata?.stt_engine_ready, !sttDegradedMode);
  const sttDegradedReason = typeof input.metadata?.stt_degraded_reason === "string" && input.metadata.stt_degraded_reason.trim()
    ? input.metadata.stt_degraded_reason.trim()
    : null;
  const sttLatencyMs = toNumber(input.metadata?.stt_latency_ms) || null;

  await recordSpeechEvent({
    sessionId: input.sessionId,
    direction: "ingress",
    engine: sttEngine,
    eventType: input.finalSegment ? "stt_final" : "stt_partial",
    transcript: input.transcript,
    degradedMode: sttDegradedMode,
    latencyMs: sttLatencyMs,
    metadata: {
      ...(input.metadata ?? {}),
      external_call_id: input.externalCallId,
      telephony_provider: input.telephonyProvider ?? "asterisk",
      engine_ready: sttEngineReady,
      degraded_reason: sttDegradedReason,
    },
  });

  const speech = await synthesizeLongCatSpeech({
    sessionId: input.sessionId,
    text: baseResult.assistant_message,
    channel: input.transport ?? input.telephonyProvider ?? "telephony",
    metadata: {
      external_call_id: input.externalCallId,
      telephony_provider: input.telephonyProvider ?? "asterisk",
      detected_intent: baseResult.detected_intent,
    },
  });

  await recordOperationalEvent({
    eventType: "longcat.voice.telephony_turn_processed",
    outcome: speech.degraded_mode || sttDegradedMode ? "info" : "success",
    payload: {
      sessionId: input.sessionId,
      externalCallId: input.externalCallId,
      provider: input.telephonyProvider ?? "asterisk",
      transport: input.transport ?? ENV.longcatTelephonyMode,
      finalSegment: Boolean(input.finalSegment),
      transcriptLength: input.transcript.trim().length,
      sttEngine,
      sttEngineReady,
      sttDegradedMode,
      sttDegradedReason,
      sttLatencyMs,
      ttsEngine: speech.engine,
      ttsEngineReady: speech.engine_ready,
      ttsDegradedMode: speech.degraded_mode,
      ttsDegradedReason: speech.degraded_reason,
      callbackRequested: baseResult.callback_requested,
      detectedIntent: baseResult.detected_intent,
    },
  });

  return {
    ...baseResult,
    telephony: {
      provider: input.telephonyProvider ?? "asterisk",
      transport: input.transport ?? ENV.longcatTelephonyMode,
      external_call_id: input.externalCallId,
    },
    speech,
  };
}

export async function closeLongCatTelephonyIngressSession(input: {
  sessionId: string;
  externalCallId: string;
  status?: "completed" | "failed" | "abandoned";
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<LongCatTelephonyCloseResult> {
  await ensureSchema();
  const db = getPool();
  const closeReason = input.reason?.trim() || "telephony_session_closed";
  const normalizedStatus = input.status === "failed" || input.status === "abandoned" ? input.status : "completed";

  const ingressResult = await db.query(
    `UPDATE longcat_voice_ingress_sessions
     SET status = $3,
         metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
         stream_last_activity_at = NOW(),
         updated_at = NOW()
     WHERE session_id = $1 AND external_call_id = $2
     RETURNING ingress_id`,
    [
      input.sessionId,
      input.externalCallId,
      normalizedStatus,
      JSON.stringify({
        ...(input.metadata ?? {}),
        close_reason: closeReason,
        closed_at: new Date().toISOString(),
      }),
    ],
  );

  await db.query(
    `UPDATE longcat_voice_sessions
     SET status = CASE WHEN status = 'closed' THEN status ELSE $2::text END,
         closed_at = COALESCE(closed_at, NOW()),
         last_turn_at = NOW(),
         current_context = COALESCE(current_context, '{}'::jsonb) || jsonb_build_object('close_reason', $3::text, 'closed_via', 'telephony_ingress')
     WHERE session_id = $1`,
    [input.sessionId, normalizedStatus, closeReason],
  );

  await recordSpeechEvent({
    sessionId: input.sessionId,
    direction: "ingress",
    engine: ENV.longcatSpeechSttEngine,
    eventType: "telephony_session_closed",
    degradedMode: false,
    metadata: {
      external_call_id: input.externalCallId,
      status: normalizedStatus,
      reason: closeReason,
      ...(input.metadata ?? {}),
    },
  });

  await ingestLakehouse("longcat_voice_ingress_lifecycle", [{
    session_id: input.sessionId,
    external_call_id: input.externalCallId,
    status: normalizedStatus,
    close_reason: closeReason,
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
  }]);

  await recordOperationalEvent({
    eventType: "longcat.voice.telephony_ingress_closed",
    outcome: normalizedStatus === "failed" ? "failure" : "success",
    payload: {
      sessionId: input.sessionId,
      externalCallId: input.externalCallId,
      status: normalizedStatus,
      reason: closeReason,
      ingressClosed: ingressResult.rowCount > 0,
    },
  });

  return {
    session_id: input.sessionId,
    external_call_id: input.externalCallId,
    status: normalizedStatus,
    closed_at: new Date().toISOString(),
    ingress_closed: ingressResult.rowCount > 0,
    close_reason: closeReason,
  };
}

export async function appendLongCatVoiceTurn(input: VoiceTurnInput): Promise<LongCatVoiceTurnResult> {
  await ensureSchema();
  const db = getPool();
  const sessionResult = await db.query(
    `SELECT s.session_id, s.status, s.user_id, s.customer_phone, s.customer_name, s.voice_channel,
            s.conversation_goal, s.operator_prompt, s.current_context, s.priority_band, s.priority_score,
            p.profile_id, p.preference_tags, p.accessibility_flags, p.substitution_risk, p.lifetime_orders,
            p.average_order_value, p.last_ordered_at, p.memory_summary
     FROM longcat_voice_sessions s
     LEFT JOIN longcat_customer_memory_profiles p ON p.profile_id = s.memory_profile_id
     WHERE s.session_id = $1`,
    [input.sessionId],
  );
  const session = sessionResult.rows[0] as Record<string, unknown> | undefined;
  if (!session) {
    throw new Error("LongCat voice session not found.");
  }
  if (isLongCatVoiceSessionTerminal(session.status)) {
    throw new Error(`LongCat voice session is already closed (${session.status ?? "closed"}).`);
  }

  const memory: LongCatCustomerMemory = {
    profile_id: `${session.profile_id ?? randomUUID()}`,
    user_id: session.user_id == null ? null : Number(session.user_id),
    customer_phone: session.customer_phone ? String(session.customer_phone) : null,
    customer_name: session.customer_name ? String(session.customer_name) : null,
    lifetime_orders: toNumber(session.lifetime_orders),
    average_order_value: toNumber(session.average_order_value),
    last_ordered_at: session.last_ordered_at ? new Date(String(session.last_ordered_at)).toISOString() : null,
    favorite_provider_ids: [],
    preference_tags: toStringList(session.preference_tags),
    accessibility_flags: toStringList(session.accessibility_flags),
    substitution_risk: `${session.substitution_risk ?? "low"}` === "high" ? "high" : `${session.substitution_risk ?? "low"}` === "medium" ? "medium" : "low",
    memory_summary: `${session.memory_summary ?? "No durable memory summary stored."}`,
    last_refreshed_at: new Date().toISOString(),
    source: "postgres",
  };

  const generated = input.speaker === "customer"
    ? await generateVoiceResponse([
        "You are LongCat Concierge assisting a human operator during a live food-ordering phone call.",
        "Return JSON only with keys assistant_message, detected_intent, next_actions, preference_tags, accessibility_flags, callback_requested.",
        `Customer memory: ${memory.memory_summary}`,
        `Session goal: ${session.conversation_goal ?? "Resolve the call efficiently."}`,
        `Current utterance: ${input.utterance}`,
        "Keep the response concise, voice-safe, and operationally grounded."
      ].join("\n"))
    : null;

  const detectedIntent = `${generated?.detected_intent ?? detectIntent(input.utterance)}`.trim();
  const assistantMessage = `${generated?.assistant_message ?? buildFallbackVoiceReply(input.utterance, memory)}`.trim();
  const nextActions = (() => {
    const candidate = toStringList(generated?.next_actions).slice(0, 4);
    if (candidate.length > 0) return candidate;
    return buildFallbackNextActions(detectedIntent, memory);
  })();

  const explicitCallbackRequest = /call me back|callback|call back|please ring|ring me|phone me/i.test(input.utterance);
  const callbackRequested = Boolean(generated?.callback_requested)
    || /call me back|callback|call back|merchant confirm/i.test(input.utterance);
  const callbackDispatchAllowed = shouldAllowAutomaticCallbackDispatch({
    speaker: input.speaker,
    utterance: input.utterance,
    metadata: input.metadata,
  });

  const mergedPreferenceTags = [...new Set([...memory.preference_tags, ...toStringList(generated?.preference_tags)])].slice(0, 8);
  const mergedAccessibilityFlags = [...new Set([...memory.accessibility_flags, ...toStringList(generated?.accessibility_flags)])].slice(0, 8);
  const updatedMemory: LongCatCustomerMemory = {
    ...memory,
    preference_tags: mergedPreferenceTags,
    accessibility_flags: mergedAccessibilityFlags,
    memory_summary: buildMemorySummary({
      ...memory,
      preference_tags: mergedPreferenceTags,
      accessibility_flags: mergedAccessibilityFlags,
      last_refreshed_at: new Date().toISOString(),
    }),
    last_refreshed_at: new Date().toISOString(),
  };

  await persistMemory(updatedMemory);
  await writeCachedMemory({ userId: updatedMemory.user_id, customerPhone: updatedMemory.customer_phone }, updatedMemory);

  const insertTurn = await db.query(
    `INSERT INTO longcat_voice_turns (
       session_id,
       speaker,
       utterance,
       detected_intent,
       assistant_message,
       next_actions,
       callback_requested,
       metadata
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
     RETURNING id`,
    [
      input.sessionId,
      input.speaker,
      input.utterance,
      detectedIntent,
      assistantMessage,
      JSON.stringify(nextActions),
      callbackRequested,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const turnId = Number(insertTurn.rows[0]?.id ?? 0);

  await db.query(
    `UPDATE longcat_voice_sessions
     SET last_turn_at = NOW(),
         current_context = jsonb_build_object('last_detected_intent', $2::text, 'next_actions', $3::jsonb)
     WHERE session_id = $1`,
    [input.sessionId, detectedIntent, JSON.stringify(nextActions)],
  );

  if (callbackRequested && !callbackDispatchAllowed && !nextActions.some((action) => /confirm callback/i.test(action))) {
    nextActions.unshift("Confirm callback consent explicitly before dispatching an outbound voice escalation.");
  }

  const callbackDispatch = callbackRequested && callbackDispatchAllowed
    ? await requestVoiceCallback(input.sessionId, updatedMemory, detectedIntent || "callback_requested")
    : {
        attempted: false,
        accepted: false,
        request_id: null,
        error: callbackRequested && !callbackDispatchAllowed ? "operator_confirmation_required" : null,
      };

  await ingestLakehouse("longcat_voice_turns", [{
    turn_id: turnId,
    session_id: input.sessionId,
    speaker: input.speaker,
    detected_intent: detectedIntent,
    callback_requested: callbackRequested,
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
  }]);

  await recordOperationalEvent({
    eventType: "longcat.voice.turn_recorded",
    outcome: "success",
    payload: {
      sessionId: input.sessionId,
      speaker: input.speaker,
      detectedIntent,
      callbackRequested,
      callbackAccepted: callbackDispatch.accepted,
    },
  });

  return {
    session_id: input.sessionId,
    turn_id: turnId,
    assistant_message: assistantMessage,
    detected_intent: detectedIntent,
    next_actions: nextActions,
    callback_requested: callbackRequested,
    callback_dispatch: callbackDispatch,
    updated_memory: updatedMemory,
  };
}

export async function appendLongCatMessagingTurn(input: VoiceTurnInput & { dispatchReply?: boolean }): Promise<LongCatMessagingTurnResult> {
  const result = await appendLongCatVoiceTurn({
    ...input,
    channel: input.channel?.trim() || "sms_ordering",
  });

  const dispatchReply = input.dispatchReply !== false;
  if (!dispatchReply || !result.updated_memory.customer_phone) {
    return {
      ...result,
      message_dispatch: {
        attempted: false,
        accepted: false,
        request_id: null,
        error: dispatchReply ? "customer_phone_unavailable" : null,
      },
    };
  }

  try {
    const dispatch = await dispatchLongCatMessage({
      customerPhone: result.updated_memory.customer_phone,
      customerName: result.updated_memory.customer_name,
      sessionId: result.session_id,
      message: result.assistant_message,
      channel: "sms",
      reason: result.detected_intent || "message_reply",
    });

    await recordOperationalEvent({
      eventType: "longcat.messaging.reply_dispatched",
      outcome: dispatch.accepted ? "success" : "failure",
      payload: {
        sessionId: result.session_id,
        requestId: dispatch.requestId,
        detectedIntent: result.detected_intent,
      },
    });

    return {
      ...result,
      message_dispatch: {
        attempted: true,
        accepted: dispatch.accepted,
        request_id: dispatch.requestId,
        error: dispatch.accepted ? null : "message_dispatch_rejected",
      },
    };
  } catch (error) {
    await recordOperationalEvent({
      eventType: "longcat.messaging.reply_dispatched",
      outcome: "failure",
      payload: {
        sessionId: result.session_id,
        detectedIntent: result.detected_intent,
        error: error instanceof Error ? error.message : "message_dispatch_failed",
      },
    });

    return {
      ...result,
      message_dispatch: {
        attempted: true,
        accepted: false,
        request_id: null,
        error: error instanceof Error ? error.message : "message_dispatch_failed",
      },
    };
  }
}

export function shouldAllowAutomaticCallbackDispatch(input: {
  speaker: VoiceTurnInput["speaker"];
  utterance: string;
  metadata?: Record<string, unknown>;
}) {
  return /call me back|callback|call back|please ring|ring me|phone me/i.test(input.utterance)
    || Boolean(input.metadata?.allow_callback_dispatch)
    || input.speaker === "system";
}

export function isLongCatVoiceSessionTerminal(status: unknown) {
  const normalized = `${status ?? ""}`.trim().toLowerCase();
  return normalized === "closed"
    || normalized === "completed"
    || normalized === "failed"
    || normalized === "abandoned";
}

function detectIntent(utterance: string) {
  const normalized = utterance.toLowerCase();
  if (/substitut|unavailable|out of stock/.test(normalized)) return "substitution_resolution";
  if (/repeat|same as last|usual|previous order|favorite/.test(normalized)) return "repeat_order";
  if (/address|delivery location|where to send/.test(normalized)) return "address_confirmation";
  if (/call me back|callback|call back/.test(normalized)) return "callback_request";
  return "general_ordering";
}

function buildFallbackVoiceReply(utterance: string, memory: LongCatCustomerMemory) {
  const intent = detectIntent(utterance);
  if (intent === "repeat_order") {
    return memory.lifetime_orders > 0
      ? "I can help repeat the most likely order pattern and confirm only the items, address, and ETA that need changing."
      : "I can guide the customer through a short repeat-order script, but there is not enough history to assume a favorite order yet.";
  }
  if (intent === "substitution_resolution") {
    return "I can offer the closest available substitute first, confirm any dietary or accessibility constraint aloud, and only escalate to the merchant if the replacement is unclear.";
  }
  if (intent === "callback_request") {
    return "I can capture the callback reason, preserve the current order context, and trigger a voice callback escalation so the customer does not need to repeat details.";
  }
  return "I can keep the call short by confirming the core order first, then using stored preference hints only when they clearly reduce friction or substitution risk.";
}

function buildFallbackNextActions(intent: string, memory: LongCatCustomerMemory) {
  if (intent === "repeat_order") {
    return [
      "Confirm the likely repeat order before offering add-ons.",
      "Verify address and payment in one pass.",
      memory.preference_tags.includes("diet-sensitive")
        ? "Repeat dietary constraints aloud before final confirmation."
        : "Keep the confirmation script short and voice-first.",
    ];
  }
  if (intent === "substitution_resolution") {
    return [
      "Offer the closest in-stock replacement before opening a broad menu search.",
      "Confirm price or portion differences aloud.",
      "Escalate to merchant callback only if the substitute remains ambiguous.",
    ];
  }
  return [
    "Capture the exact customer intent before proposing promotions.",
    "Use stored preferences only when they reduce call time.",
    "Escalate callback handling if the order depends on merchant confirmation.",
  ];
}
