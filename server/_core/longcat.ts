import { ENV } from "./env";
import { optimizeDispatch } from "./dispatchOptimizer";
import { ENV } from "./env";

// ============================================================
// Tiered Model Fallback Router
// ============================================================

type ModelTier = "primary" | "fallback" | "cached" | "heuristic";

type RoutingDecision = {
  tier: ModelTier;
  model: string;
  timeoutMs: number;
  reason: string;
};

type CacheEntry = {
  result: any;
  timestamp: number;
  promptHash: string;
  tier: ModelTier;
};

// In-memory response cache for timeout fallback
const responseCache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 100;

// Circuit breaker state
let primaryFailureCount = 0;
let primaryLastFailure = 0;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 60_000; // 1 minute

function hashPrompt(prompt: string): string {
  // Simple hash for cache key — uses first 200 chars + length
  const prefix = prompt.slice(0, 200);
  return `${prefix.length}:${prefix.replace(/\d+/g, "N")}`;
}

function getCachedResponse(promptHash: string): CacheEntry | null {
  const entry = responseCache.get(promptHash);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ENV.ollamaCacheTtlMs) {
    responseCache.delete(promptHash);
    return null;
  }
  return entry;
}

function setCachedResponse(promptHash: string, result: any, tier: ModelTier): void {
  // Evict oldest entries if cache is full
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const oldest = [...responseCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) responseCache.delete(oldest[0]);
  }
  responseCache.set(promptHash, { result, timestamp: Date.now(), promptHash, tier });
}

function isPrimaryCircuitOpen(): boolean {
  if (primaryFailureCount < CIRCUIT_BREAKER_THRESHOLD) return false;
  if (Date.now() - primaryLastFailure > CIRCUIT_BREAKER_RESET_MS) {
    // Reset circuit breaker after cooldown
    primaryFailureCount = 0;
    return false;
  }
  return true;
}

function recordPrimaryFailure(): void {
  primaryFailureCount++;
  primaryLastFailure = Date.now();
}

function recordPrimarySuccess(): void {
  primaryFailureCount = 0;
}

function determineRoutingTier(promptHash: string): RoutingDecision {
  // Tier 1: Check cache first (instant response)
  const cached = getCachedResponse(promptHash);
  if (cached) {
    return { tier: "cached", model: ENV.ollamaModel, timeoutMs: 0, reason: "Valid cached response available." };
  }

  // Tier 2: If primary circuit is open, skip to fallback model
  if (isPrimaryCircuitOpen()) {
    return {
      tier: "fallback",
      model: ENV.ollamaFallbackModel,
      timeoutMs: ENV.ollamaFallbackTimeoutMs,
      reason: `Primary model circuit open (${primaryFailureCount} consecutive failures). Using lighter fallback model.`,
    };
  }

  // Tier 3: Try primary model with tight timeout
  return {
    tier: "primary",
    model: ENV.ollamaModel,
    timeoutMs: ENV.ollamaPrimaryTimeoutMs,
    reason: "Primary model available.",
  };
}

async function generateWithFallbackRouting<T>(prompt: string): Promise<{ data: T | null; routing: RoutingDecision; reason?: string }> {
  const promptHash = hashPrompt(prompt);
  const routing = determineRoutingTier(promptHash);

  // Cached tier: return immediately
  if (routing.tier === "cached") {
    const cached = getCachedResponse(promptHash)!;
    return { data: cached.result as T, routing: { ...routing, reason: `Cache hit (age: ${Math.round((Date.now() - cached.timestamp) / 1000)}s).` } };
  }

  // Try the determined tier
  const result = await attemptGeneration<T>(prompt, routing.model, routing.timeoutMs);

  if (result.data) {
    // Success: cache the response and record health
    setCachedResponse(promptHash, result.data, routing.tier);
    if (routing.tier === "primary") recordPrimarySuccess();
    return { data: result.data, routing };
  }

  // Primary failed: try fallback model if we haven't already
  if (routing.tier === "primary") {
    recordPrimaryFailure();

    // Attempt fallback model with longer timeout
    const fallbackRouting: RoutingDecision = {
      tier: "fallback",
      model: ENV.ollamaFallbackModel,
      timeoutMs: ENV.ollamaFallbackTimeoutMs,
      reason: `Primary model timed out (${routing.timeoutMs}ms). Escalating to lighter fallback model.`,
    };

    const fallbackResult = await attemptGeneration<T>(prompt, fallbackRouting.model, fallbackRouting.timeoutMs);

    if (fallbackResult.data) {
      setCachedResponse(promptHash, fallbackResult.data, "fallback");
      return { data: fallbackResult.data, routing: fallbackRouting };
    }

    // Both models failed: check stale cache
    const staleEntry = responseCache.get(promptHash);
    if (staleEntry) {
      return {
        data: staleEntry.result as T,
        routing: { tier: "cached", model: ENV.ollamaModel, timeoutMs: 0, reason: "Both models failed. Serving stale cached response." },
      };
    }

    // Complete failure: fall through to heuristic
    return {
      data: null,
      routing: { tier: "heuristic", model: "none", timeoutMs: 0, reason: `All model tiers exhausted. Primary: ${result.reason}. Fallback: ${fallbackResult.reason}` },
      reason: fallbackResult.reason,
    };
  }

  // Fallback tier also failed
  return {
    data: null,
    routing: { tier: "heuristic", model: "none", timeoutMs: 0, reason: `Fallback model failed: ${result.reason}` },
    reason: result.reason,
  };
}

async function attemptGeneration<T>(prompt: string, model: string, timeoutMs: number): Promise<{ data: T | null; reason?: string }> {
  if (!ENV.ollamaUrl || !model) {
    return { data: null, reason: "Ollama runtime is not configured." };
  }

  try {
    const response = await fetch(`${ENV.ollamaUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: "json" }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { data: null, reason: `Model ${model} returned HTTP ${response.status}.` };
    }

    const payload = (await response.json()) as OllamaGenerateResponse;
    const parsed = parseJsonObject<T>(payload.response ?? "");
    if (!parsed) {
      return { data: null, reason: `Model ${model} returned unparseable JSON.` };
    }

    return { data: parsed };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown failure.";
    return { data: null, reason: `Model ${model}: ${msg}` };
  }
}

// Export for testing
export function _resetFallbackState(): void {
  primaryFailureCount = 0;
  primaryLastFailure = 0;
  responseCache.clear();
}

export function _getFallbackMetrics(): { cacheSize: number; circuitOpen: boolean; failureCount: number } {
  return { cacheSize: responseCache.size, circuitOpen: isPrimaryCircuitOpen(), failureCount: primaryFailureCount };
}

type ProviderStatus = {
  provider: "ollama" | "heuristic";
  execution_mode: "llm" | "heuristic_fallback";
  model: string;
  available: boolean;
  reason?: string;
  routing_tier?: ModelTier;
};

type ConsumerWorkspaceInput = {
  staffed_lines: number;
  active_calls: number;
  substitution_cases: number;
  call_flows: string[];
  recommended_action: string;
  memory_summary?: string;
  live_voice_enabled?: boolean;
  messaging_channels?: string[];
};

type MerchantWorkspaceInput = {
  activated_channels: number;
  branded_storefronts: number;
  partner_channels: number;
  channel_mix: string[];
  recommended_action: string;
  benchmark_summary?: string;
  forecast_inputs?: string[];
};

type DispatchWorkspaceInput = {
  online_drivers: number;
  trip_radar_candidates: number | null;
  airport_ready_drivers: number | null;
  avg_weekly_earnings: number | null;
  recommended_action: string;
  telemetry_summary?: string;
  telemetry_signals?: string[];
  supply_queue: Array<{
    driver: string;
    mode: string;
    zone: string;
    rating: number;
    reliability: string;
    weekly_earnings: string;
    status: string;
    next_action: string;
  }>;
};

export type LongCatConsumerAssistant = {
  source: ProviderStatus;
  assistant_name: string;
  conversation_goal: string;
  personalized_recommendations: string[];
  operator_script: string;
  accessibility_note: string;
  next_actions: string[];
  memory_grounding: string;
  channel_actions: string[];
};

export type LongCatMerchantConsultant = {
  source: ProviderStatus;
  consultant_name: string;
  market_brief: string;
  demand_forecast: string;
  menu_actions: string[];
  channel_actions: string[];
  financial_watchouts: string[];
  benchmark_summary: string;
  benchmark_actions: string[];
};

export type LongCatDispatchIntelligence = {
  source: ProviderStatus;
  dispatch_brief: string;
  batching_strategy: string;
  rider_guidance: string[];
  risk_flags: string[];
  ranked_candidates: Array<{ id: number | null; driver: string; score: number; zone: string }>;
  telemetry_summary: string;
  recommended_reallocations: string[];
};

type OllamaGenerateResponse = {
  response?: string;
};

function providerStatus(provider: ProviderStatus["provider"], available: boolean, reason?: string, routingTier?: ModelTier): ProviderStatus {
  return {
    provider,
    execution_mode: provider === "ollama" ? "llm" : "heuristic_fallback",
    model: ENV.ollamaModel,
    available,
    reason,
    routing_tier: routingTier,
  };
}

/**
 * Sanitize model output strings to remove injection template markers,
 * credential patterns, and system-prompt leakage artifacts.
 */
/**
 * Detect and redact base64-encoded sensitive data in model output.
 * Looks for base64 strings that decode to known PII or credential patterns.
 */
function redactBase64Secrets(value: string): string {
  // Match potential base64 strings (16+ chars, valid base64 alphabet)
  return value.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (match) => {
    try {
      const decoded = Buffer.from(match, "base64").toString("utf-8");
      // Check if decoded content contains sensitive patterns
      if (/\d{3}-\d{2}-\d{4}/.test(decoded)) return "[REDACTED_ENCODED_SSN]";
      if (/\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}/.test(decoded)) return "[REDACTED_ENCODED_CARD]";
      if (/sk-[a-zA-Z0-9]{10,}/.test(decoded)) return "[REDACTED_ENCODED_KEY]";
      if (/postgres(ql)?:\/\//.test(decoded)) return "[REDACTED_ENCODED_DSN]";
      if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(decoded)) return "[REDACTED_ENCODED_EMAIL]";
    } catch {
      // Not valid base64, leave as-is
    }
    return match;
  });
}

/**
 * Normalize Unicode homoglyphs to ASCII equivalents for pattern matching.
 */
function normalizeHomoglyphs(value: string): string {
  // Cyrillic → Latin lookalike map
  const homoglyphMap: Record<string, string> = {
    "\u0430": "a", // Cyrillic а
    "\u0435": "e", // Cyrillic е
    "\u043E": "o", // Cyrillic о
    "\u0440": "p", // Cyrillic р
    "\u0441": "c", // Cyrillic с
    "\u0443": "y", // Cyrillic у
    "\u0445": "x", // Cyrillic х
    "\u0456": "i", // Cyrillic і
  };
  let normalized = value;
  for (const [homoglyph, ascii] of Object.entries(homoglyphMap)) {
    normalized = normalized.replaceAll(homoglyph, ascii);
  }
  // Normalize Unicode hyphens/dashes to ASCII hyphen for PII detection
  normalized = normalized.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2043\uFE58\uFE63\uFF0D]/g, "-");
  return normalized;
}

function sanitizeOutput(value: string): string {
  // First pass: redact base64-encoded secrets
  let result = redactBase64Secrets(value);
  // Second pass: normalize homoglyphs then apply keyword/pattern sanitization
  const normalized = normalizeHomoglyphs(result);
  // If normalization reveals a sensitive pattern, redact in the original
  if (/api[_-]?key/i.test(normalized) && !/api[_-]?key/i.test(result)) {
    result = result.replace(/[^\s]{3,}api[^\s]*/gi, "[REDACTED_HOMOGLYPH]")
      .replace(new RegExp(value.match(/\S*\u0430\S*pi[_-]?\S*\u0435\S*y\S*/gi)?.[0] || "(?!)", "g"), "[REDACTED_HOMOGLYPH]");
    // Fallback: if Cyrillic chars are present near 'pi' or 'key', redact the phrase
    result = result.replace(/[\u0400-\u04FF]\S*(?:pi|key|env|admin)\S*/gi, "[REDACTED_HOMOGLYPH]");
  }
  if (/process\.env/i.test(normalized) && !/process\.env/i.test(result)) {
    result = result.replace(/[\u0400-\u04FF]\S*(?:cess|env)\S*/gi, "[REDACTED_HOMOGLYPH]");
  }
  if (/admin\s*credentials?/i.test(normalized) && !/admin\s*credentials?/i.test(result)) {
    result = result.replace(/[\u0400-\u04FF]\S*(?:dmin|cred)\S*/gi, "[REDACTED_HOMOGLYPH]");
  }
  // Apply standard patterns on the (possibly already partially redacted) result
  return result
    .replace(/\{\{[^}]*\}\}/g, "[REDACTED_TEMPLATE]")
    .replace(/process\.env\b/gi, "[REDACTED]")
    .replace(/api[_-]?key/gi, "[REDACTED]")
    .replace(/database\s*password/gi, "[REDACTED]")
    .replace(/admin\s*credentials?/gi, "[REDACTED]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]")
    .replace(/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, "[REDACTED_CARD]")
    .replace(/<\|im_start\|>.*?<\|im_end\|>/gs, "[REDACTED_INJECTION]")
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, "[REDACTED_KEY]");
}

function sanitizeText(value: string): string {
  return sanitizeOutput(value);
}

function sanitizeList(values: string[]): string[] {
  return values.map(sanitizeOutput);
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

async function generateStructured<T>(prompt: string): Promise<{ data: T | null; reason?: string; routing?: RoutingDecision }> {
  return generateWithFallbackRouting<T>(prompt);
}

function fallbackConsumerAssistant(input: ConsumerWorkspaceInput, reason?: string): LongCatConsumerAssistant {
  const pressure = input.substitution_cases > 0 ? "substitution recovery" : input.active_calls > input.staffed_lines ? "call overflow containment" : "kitchen handoff consistency";
  const messagingChannels = input.messaging_channels?.length ? input.messaging_channels.join(", ") : "sms follow-up";
  const memoryGrounding = input.memory_summary?.trim() || "No durable customer memory has been summarized yet, so treat every interaction as a fresh assisted-ordering moment.";
  return {
    source: providerStatus("heuristic", false, reason ?? "Falling back to deterministic consumer-assistant guidance."),
    assistant_name: "LongCat Concierge",
    conversation_goal: `Prioritize ${pressure} while keeping the phone-order journey accessible and low-friction.`,
    personalized_recommendations: [
      input.substitution_cases > 0 ? "Offer closest menu substitutes before escalating to merchant callback." : "Promote saved favorites and fast-repeat items for returning callers.",
      input.active_calls > input.staffed_lines ? "Route simple reorder requests into a short script with payment and address confirmation." : "Use a one-pass confirmation flow for address, payment, and ETA promise.",
      "Present bundle or family-meal suggestions only after the core order is confirmed.",
    ],
    operator_script: input.substitution_cases > 0
      ? "I can confirm the closest available replacement, keep the same delivery timing, and note any dietary restriction before I finalize the order."
      : "I can help place the order in one pass, confirm the best ETA, and recommend the quickest match based on the caller's past ordering pattern.",
    accessibility_note: "Keep the conversation voice-first, repeat critical order details aloud, and avoid forcing callers through complex menu navigation.",
    next_actions: [
      input.recommended_action,
      "Capture unavailable-item intent explicitly so the merchant can learn recurring substitution demand.",
      "Escalate elderly or accessibility-sensitive callers to the shortest confirmation script.",
    ],
    memory_grounding: memoryGrounding,
    channel_actions: [
      input.live_voice_enabled ? "Keep voice ordering live for high-friction cases and overflow recovery." : "Bring assisted voice ordering online for overflow and substitution-sensitive cases.",
      `Use ${messagingChannels} for confirmations, reorder nudges, and callback consent capture.`,
      "Unify the caller profile across assisted ordering, recovery, and follow-up channels so preferences persist beyond a single contact.",
    ],
  };
}

function fallbackMerchantConsultant(input: MerchantWorkspaceInput, reason?: string): LongCatMerchantConsultant {
  const benchmarkSummary = input.benchmark_summary?.trim() || "Peer benchmarking is currently limited to internal channel and campaign signals, so use internal cohort comparisons until external market feeds are attached.";
  return {
    source: providerStatus("heuristic", false, reason ?? "Falling back to deterministic merchant-consultant guidance."),
    consultant_name: "LongCat Merchant Copilot",
    market_brief: input.partner_channels > 0
      ? "Owned and partner channels are both active, so the next growth gain comes from tighter message consistency and campaign follow-through instead of adding new surfaces."
      : "The business is still channel-concentrated, so owned storefront conversion and repeat-order capture should lead expansion before syndication grows.",
    demand_forecast: input.activated_channels >= 5
      ? "Demand should stay healthy across multiple acquisition surfaces, but message fragmentation risk rises as more channels go live."
      : "Demand growth is still structurally constrained by channel coverage, so storefront activation cadence matters more than broad campaign volume.",
    menu_actions: [
      "Promote high-margin bundles on owned storefronts before discounting commodity single-item orders.",
      "Use substitution and cancellation reasons to identify dishes that need recipe, availability, or prep-time redesign.",
      "Align featured dishes with the channels that can support fastest promise times.",
    ],
    channel_actions: [
      input.recommended_action,
      "Sequence lifecycle messaging so push, storefront banners, and marketplace promotions reinforce the same weekly commercial objective.",
      "Treat partner channels as demand amplifiers, not the primary place to learn retention behavior.",
    ],
    financial_watchouts: [
      "Watch contribution margin on channels that require heavy promotion to sustain volume.",
      "Avoid opening new merchant surfaces until post-click conversion and repeat-order retention stabilize.",
      "Track whether push-delivery volume is producing incremental orders or only shifting existing demand between channels.",
    ],
    benchmark_summary: benchmarkSummary,
    benchmark_actions: [
      "Compare owned-channel conversion against peer storefront cohorts before increasing paid partner spend.",
      "Track whether push and campaign delivery volume produces repeat orders, not just short-lived traffic.",
      "Use weekly benchmark deltas to decide which merchants need menu, pricing, or lifecycle-message intervention first.",
    ],
  };
}

function toText(value: unknown, fallback: string, sanitize = true): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const result = trimmed.length > 0 ? trimmed : fallback;
    return sanitize ? sanitizeText(result) : result;
  }

  if (Array.isArray(value)) {
    const joined = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" ");
    const result = joined.length > 0 ? joined : fallback;
    return sanitize ? sanitizeText(result) : result;
  }

  return fallback;
}

function toTextList(value: unknown, fallback: string[], sanitize = true): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 3);
  const result = normalized.length > 0 ? normalized : fallback;
  return sanitize ? sanitizeList(result) : result;
}

function fallbackDispatchIntelligence(input: DispatchWorkspaceInput, reason?: string): LongCatDispatchIntelligence {
  const ranked = optimizeDispatch(
    input.supply_queue.map((entry, index) => ({
      id: index + 1,
      rating: Number(entry.rating ?? 0),
      acceptanceRate: Number.parseFloat(entry.reliability) || 0,
      completionRate: Number.parseFloat(entry.reliability) || 0,
      distanceKm: entry.zone.toLowerCase().includes("airport") ? 4 : 2,
      etaMinutes: entry.status === "online" ? 8 : 18,
      earningsPerHour: Number.parseFloat(entry.weekly_earnings.replace(/[^\d.]/g, "")) / 10 || 0,
    })),
  );

  const byId = new Map(ranked.rankedCandidates.map((candidate) => [candidate.id, candidate]));

  return {
    source: providerStatus("heuristic", false, reason ?? "Falling back to deterministic dispatch guidance."),
    dispatch_brief: input.recommended_action,
    batching_strategy: ranked.batchingEligible
      ? "Keep batch windows open for closely clustered orders because at least two drivers remain above the confidence threshold."
      : "Use direct assignment for the next cycle because the available supply confidence is too uneven for safe batching.",
    rider_guidance: [
      "Favor reliable online couriers for high-friction restaurant pickups and delay-sensitive trips.",
      "Rebalance airport-ready supply only when courier-demand pressure remains elevated after the current queue clears.",
      "Explain dispatch decisions in operational language so ops teams can override them safely when ground truth changes.",
    ],
    risk_flags: [
      input.trip_radar_candidates == null
        ? "Trip-radar eligibility data is unavailable; no capacity conclusion is being inferred."
        : input.online_drivers < input.trip_radar_candidates
          ? "Trip-radar eligible capacity exceeds active online supply; watch acceptance latency."
          : "Online driver pool is currently supporting trip-radar exposure.",
      input.airport_ready_drivers == null
        ? "Airport-readiness data is unavailable; no reserve-supply conclusion is being inferred."
        : input.airport_ready_drivers < 2
          ? "Airport reserve is thin; avoid overcommitting transfer-ready drivers."
          : "Airport reserve remains serviceable but should be monitored during peaks.",
    ],
    ranked_candidates: input.supply_queue.slice(0, 4).map((entry, index) => ({
      id: ranked.rankedCandidates[index]?.id ?? null,
      driver: entry.driver,
      score: byId.get(ranked.rankedCandidates[index]?.id ?? -1)?.score ?? 0,
      zone: entry.zone,
    })),
    telemetry_summary: input.telemetry_summary?.trim() || "Dispatch guidance is using live supply and order pressure, but richer telemetry should remain attached whenever weather, traffic, or prep-delay signals are available.",
    recommended_reallocations: [
      "Shift the highest-confidence online drivers into the most backlogged zones first.",
      "Use telemetry-backed batch windows only when queue density and courier confidence align.",
      "Preserve a small airport-ready reserve until peak-transfer demand visibly drops.",
    ],
  };
}

export async function buildConsumerAssistant(input: ConsumerWorkspaceInput): Promise<LongCatConsumerAssistant> {
  const fallback = fallbackConsumerAssistant(input);
  const { data, reason, routing } = await generateStructured<{
    conversation_goal: string;
    personalized_recommendations: string[];
    operator_script: string;
    accessibility_note: string;
    next_actions: string[];
    memory_grounding: string;
    channel_actions: string[];
  }>([
    "You are LongCat Concierge for a food delivery platform.",
    "Return JSON only with keys conversation_goal, personalized_recommendations, operator_script, accessibility_note, next_actions, memory_grounding, channel_actions.",
    "Each list must contain 3 concise items.",
    `Workspace snapshot: staffed_lines=${input.staffed_lines}, active_calls=${input.active_calls}, substitution_cases=${input.substitution_cases}.`,
    `Call flows: ${input.call_flows.join(" | ")}.`,
    `Customer memory: ${input.memory_summary?.trim() || "No durable customer memory summary available."}`,
    `Live voice enabled: ${input.live_voice_enabled ? "yes" : "no"}.`,
    `Messaging channels: ${(input.messaging_channels?.length ? input.messaging_channels.join(", ") : "sms")}.`,
    `Current recommended action: ${input.recommended_action}.`,
    "Optimize for voice ordering, messaging follow-up, personalization, accessibility, and conversion without inventing unavailable system capabilities.",
  ].join("\n"));

  if (!data) return fallbackConsumerAssistant(input, reason);

  return {
    source: providerStatus("ollama", true, undefined, routing?.tier),
    assistant_name: "LongCat Concierge",
    conversation_goal: toText(data.conversation_goal, fallback.conversation_goal),
    personalized_recommendations: toTextList(data.personalized_recommendations, fallback.personalized_recommendations),
    operator_script: toText(data.operator_script, fallback.operator_script),
    accessibility_note: toText(data.accessibility_note, fallback.accessibility_note),
    next_actions: toTextList(data.next_actions, fallback.next_actions),
    memory_grounding: toText(data.memory_grounding, fallback.memory_grounding),
    channel_actions: toTextList(data.channel_actions, fallback.channel_actions),
  };
}

export async function buildMerchantConsultant(input: MerchantWorkspaceInput): Promise<LongCatMerchantConsultant> {
  const fallback = fallbackMerchantConsultant(input);
  const { data, reason, routing } = await generateStructured<{
    market_brief: string;
    demand_forecast: string;
    menu_actions: string[];
    channel_actions: string[];
    financial_watchouts: string[];
    benchmark_summary: string;
    benchmark_actions: string[];
  }>([
    "You are LongCat Merchant Copilot for a restaurant and merchant growth workspace.",
    "Return JSON only with keys market_brief, demand_forecast, menu_actions, channel_actions, financial_watchouts, benchmark_summary, benchmark_actions.",
    "Each list must contain 3 concise items.",
    `Workspace snapshot: activated_channels=${input.activated_channels}, branded_storefronts=${input.branded_storefronts}, partner_channels=${input.partner_channels}.`,
    `Channel mix: ${input.channel_mix.join(" | ")}.`,
    `Benchmark summary: ${input.benchmark_summary?.trim() || "Only internal merchant benchmark signals are currently attached."}`,
    `Forecast inputs: ${(input.forecast_inputs?.length ? input.forecast_inputs.join(" | ") : "internal channel, campaign, and storefront health signals only")}.`,
    `Current recommended action: ${input.recommended_action}.`,
    "Focus on market analysis, menu optimization, channel mix, merchant benchmarking, and merchant financial planning. Avoid claiming unavailable external data.",
  ].join("\n"));

  if (!data) return fallbackMerchantConsultant(input, reason);

  return {
    source: providerStatus("ollama", true, undefined, routing?.tier),
    consultant_name: "LongCat Merchant Copilot",
    market_brief: toText(data.market_brief, fallback.market_brief),
    demand_forecast: toText(data.demand_forecast, fallback.demand_forecast),
    menu_actions: toTextList(data.menu_actions, fallback.menu_actions),
    channel_actions: toTextList(data.channel_actions, fallback.channel_actions),
    financial_watchouts: toTextList(data.financial_watchouts, fallback.financial_watchouts),
    benchmark_summary: toText(data.benchmark_summary, fallback.benchmark_summary),
    benchmark_actions: toTextList(data.benchmark_actions, fallback.benchmark_actions),
  };
}

export async function buildDispatchIntelligence(input: DispatchWorkspaceInput): Promise<LongCatDispatchIntelligence> {
  const fallback = fallbackDispatchIntelligence(input);
  const { data, reason, routing } = await generateStructured<{
    dispatch_brief: string;
    batching_strategy: string;
    rider_guidance: string[];
    risk_flags: string[];
    telemetry_summary: string;
    recommended_reallocations: string[];
  }>([
    "You are LongCat Dispatch Intelligence for a high-volume delivery marketplace.",
    "Return JSON only with keys dispatch_brief, batching_strategy, rider_guidance, risk_flags, telemetry_summary, recommended_reallocations.",
    "Each list must contain 3 concise items.",
    `Workspace snapshot: online_drivers=${input.online_drivers}, trip_radar_candidates=${input.trip_radar_candidates}, airport_ready_drivers=${input.airport_ready_drivers}, avg_weekly_earnings=${input.avg_weekly_earnings}.`,
    `Supply queue: ${input.supply_queue.map((entry) => `${entry.driver}/${entry.zone}/${entry.status}/${entry.next_action}`).join(" | ")}.`,
    `Telemetry summary: ${input.telemetry_summary?.trim() || "No enriched telemetry summary attached."}`,
    `Telemetry signals: ${(input.telemetry_signals?.length ? input.telemetry_signals.join(" | ") : "supply and queue metrics only")}.`,
    `Current recommended action: ${input.recommended_action}.`,
    "Optimize for real-time dispatch, batching, supply balancing, telemetry-backed explainability, and safe operational overrides.",
  ].join("\n"));

  if (!data) return fallbackDispatchIntelligence(input, reason);

  return {
    ...fallback,
    source: providerStatus("ollama", true, undefined, routing?.tier),
    dispatch_brief: toText(data.dispatch_brief, fallback.dispatch_brief),
    batching_strategy: toText(data.batching_strategy, fallback.batching_strategy),
    rider_guidance: toTextList(data.rider_guidance, fallback.rider_guidance),
    risk_flags: toTextList(data.risk_flags, fallback.risk_flags),
    telemetry_summary: toText(data.telemetry_summary, fallback.telemetry_summary),
    recommended_reallocations: toTextList(data.recommended_reallocations, fallback.recommended_reallocations),
  };
}
