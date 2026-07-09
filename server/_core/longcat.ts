import { ENV } from "./env";
import { optimizeDispatch } from "./dispatchOptimizer";

type ProviderStatus = {
  provider: "ollama" | "heuristic";
  model: string;
  available: boolean;
  reason?: string;
};

type ConsumerWorkspaceInput = {
  staffed_lines: number;
  active_calls: number;
  substitution_cases: number;
  call_flows: string[];
  recommended_action: string;
};

type MerchantWorkspaceInput = {
  activated_channels: number;
  branded_storefronts: number;
  partner_channels: number;
  channel_mix: string[];
  recommended_action: string;
};

type DispatchWorkspaceInput = {
  online_drivers: number;
  trip_radar_candidates: number;
  airport_ready_drivers: number;
  avg_weekly_earnings: number;
  recommended_action: string;
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
};

export type LongCatMerchantConsultant = {
  source: ProviderStatus;
  consultant_name: string;
  market_brief: string;
  demand_forecast: string;
  menu_actions: string[];
  channel_actions: string[];
  financial_watchouts: string[];
};

export type LongCatDispatchIntelligence = {
  source: ProviderStatus;
  dispatch_brief: string;
  batching_strategy: string;
  rider_guidance: string[];
  risk_flags: string[];
  ranked_candidates: Array<{ id: number | null; driver: string; score: number; zone: string }>;
};

type OllamaGenerateResponse = {
  response?: string;
};

function providerStatus(provider: ProviderStatus["provider"], available: boolean, reason?: string): ProviderStatus {
  return {
    provider,
    model: ENV.ollamaModel,
    available,
    reason,
  };
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

async function generateStructured<T>(prompt: string): Promise<{ data: T | null; reason?: string }> {
  if (!ENV.ollamaUrl || !ENV.ollamaModel) {
    return { data: null, reason: "Local Ollama runtime is not configured." };
  }

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
      signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS ?? 60_000)),
    });

    if (!response.ok) {
      return { data: null, reason: `Ollama returned HTTP ${response.status}.` };
    }

    const payload = (await response.json()) as OllamaGenerateResponse;
    const parsed = parseJsonObject<T>(payload.response ?? "");
    if (!parsed) {
      return { data: null, reason: "Ollama returned an unparseable JSON payload." };
    }

    return { data: parsed };
  } catch (error) {
    return {
      data: null,
      reason: error instanceof Error ? error.message : "Unknown Ollama runtime failure.",
    };
  }
}

function fallbackConsumerAssistant(input: ConsumerWorkspaceInput, reason?: string): LongCatConsumerAssistant {
  const pressure = input.substitution_cases > 0 ? "substitution recovery" : input.active_calls > input.staffed_lines ? "call overflow containment" : "kitchen handoff consistency";
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
  };
}

function fallbackMerchantConsultant(input: MerchantWorkspaceInput, reason?: string): LongCatMerchantConsultant {
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
  };
}

function toText(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  if (Array.isArray(value)) {
    const joined = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" ");
    return joined.length > 0 ? joined : fallback;
  }

  return fallback;
}

function toTextList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 3);
  return normalized.length > 0 ? normalized : fallback;
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
      input.online_drivers < input.trip_radar_candidates ? "Trip-radar eligible capacity exceeds active online supply; watch acceptance latency." : "Online driver pool is currently supporting trip-radar exposure.",
      input.airport_ready_drivers < 2 ? "Airport reserve is thin; avoid overcommitting transfer-ready drivers." : "Airport reserve remains serviceable but should be monitored during peaks.",
    ],
    ranked_candidates: input.supply_queue.slice(0, 4).map((entry, index) => ({
      id: ranked.rankedCandidates[index]?.id ?? null,
      driver: entry.driver,
      score: byId.get(ranked.rankedCandidates[index]?.id ?? -1)?.score ?? 0,
      zone: entry.zone,
    })),
  };
}

export async function buildConsumerAssistant(input: ConsumerWorkspaceInput): Promise<LongCatConsumerAssistant> {
  const fallback = fallbackConsumerAssistant(input);
  const { data, reason } = await generateStructured<{
    conversation_goal: string;
    personalized_recommendations: string[];
    operator_script: string;
    accessibility_note: string;
    next_actions: string[];
  }>([
    "You are LongCat Concierge for a food delivery platform.",
    "Return JSON only with keys conversation_goal, personalized_recommendations, operator_script, accessibility_note, next_actions.",
    "Each list must contain 3 concise items.",
    `Workspace snapshot: staffed_lines=${input.staffed_lines}, active_calls=${input.active_calls}, substitution_cases=${input.substitution_cases}.`,
    `Call flows: ${input.call_flows.join(" | ")}.`,
    `Current recommended action: ${input.recommended_action}.`,
    "Optimize for voice ordering, personalization, accessibility, and conversion without inventing unavailable system capabilities.",
  ].join("\n"));

  if (!data) return fallbackConsumerAssistant(input, reason);

  return {
    source: providerStatus("ollama", true),
    assistant_name: "LongCat Concierge",
    conversation_goal: toText(data.conversation_goal, fallback.conversation_goal),
    personalized_recommendations: toTextList(data.personalized_recommendations, fallback.personalized_recommendations),
    operator_script: toText(data.operator_script, fallback.operator_script),
    accessibility_note: toText(data.accessibility_note, fallback.accessibility_note),
    next_actions: toTextList(data.next_actions, fallback.next_actions),
  };
}

export async function buildMerchantConsultant(input: MerchantWorkspaceInput): Promise<LongCatMerchantConsultant> {
  const fallback = fallbackMerchantConsultant(input);
  const { data, reason } = await generateStructured<{
    market_brief: string;
    demand_forecast: string;
    menu_actions: string[];
    channel_actions: string[];
    financial_watchouts: string[];
  }>([
    "You are LongCat Merchant Copilot for a restaurant and merchant growth workspace.",
    "Return JSON only with keys market_brief, demand_forecast, menu_actions, channel_actions, financial_watchouts.",
    "Each list must contain 3 concise items.",
    `Workspace snapshot: activated_channels=${input.activated_channels}, branded_storefronts=${input.branded_storefronts}, partner_channels=${input.partner_channels}.`,
    `Channel mix: ${input.channel_mix.join(" | ")}.`,
    `Current recommended action: ${input.recommended_action}.`,
    "Focus on market analysis, menu optimization, channel mix, and merchant financial planning. Avoid claiming unavailable external data.",
  ].join("\n"));

  if (!data) return fallbackMerchantConsultant(input, reason);

  return {
    source: providerStatus("ollama", true),
    consultant_name: "LongCat Merchant Copilot",
    market_brief: toText(data.market_brief, fallback.market_brief),
    demand_forecast: toText(data.demand_forecast, fallback.demand_forecast),
    menu_actions: toTextList(data.menu_actions, fallback.menu_actions),
    channel_actions: toTextList(data.channel_actions, fallback.channel_actions),
    financial_watchouts: toTextList(data.financial_watchouts, fallback.financial_watchouts),
  };
}

export async function buildDispatchIntelligence(input: DispatchWorkspaceInput): Promise<LongCatDispatchIntelligence> {
  const fallback = fallbackDispatchIntelligence(input);
  const { data, reason } = await generateStructured<{
    dispatch_brief: string;
    batching_strategy: string;
    rider_guidance: string[];
    risk_flags: string[];
  }>([
    "You are LongCat Dispatch Intelligence for a high-volume delivery marketplace.",
    "Return JSON only with keys dispatch_brief, batching_strategy, rider_guidance, risk_flags.",
    "Each list must contain 3 concise items.",
    `Workspace snapshot: online_drivers=${input.online_drivers}, trip_radar_candidates=${input.trip_radar_candidates}, airport_ready_drivers=${input.airport_ready_drivers}, avg_weekly_earnings=${input.avg_weekly_earnings}.`,
    `Supply queue: ${input.supply_queue.map((entry) => `${entry.driver}/${entry.zone}/${entry.status}/${entry.next_action}`).join(" | ")}.`,
    `Current recommended action: ${input.recommended_action}.`,
    "Optimize for real-time dispatch, batching, supply balancing, and operational explainability.",
  ].join("\n"));

  if (!data) return fallbackDispatchIntelligence(input, reason);

  return {
    ...fallback,
    source: providerStatus("ollama", true),
    dispatch_brief: toText(data.dispatch_brief, fallback.dispatch_brief),
    batching_strategy: toText(data.batching_strategy, fallback.batching_strategy),
    rider_guidance: toTextList(data.rider_guidance, fallback.rider_guidance),
    risk_flags: toTextList(data.risk_flags, fallback.risk_flags),
  };
}
