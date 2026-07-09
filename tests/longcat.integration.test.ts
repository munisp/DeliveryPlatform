import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildConsumerAssistant,
  buildDispatchIntelligence,
  buildMerchantConsultant,
} from "../server/_core/longcat";
import {
  isLongCatVoiceSessionTerminal,
  shouldAllowAutomaticCallbackDispatch,
} from "../server/_core/longcatVoice";

describe("LongCat local AI integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back honestly to heuristic consumer guidance when the local Ollama runtime fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ollama offline")));

    const result = await buildConsumerAssistant({
      staffed_lines: 4,
      active_calls: 9,
      substitution_cases: 3,
      call_flows: [
        "Assisted order capture: 12 active cases",
        "Substitution handling: 4 active cases",
      ],
      recommended_action: "Escalate substitution-heavy calls before they turn into cancellations.",
      memory_summary: "Repeat caller prefers family meals and voice confirmation before substitutions.",
      live_voice_enabled: true,
      messaging_channels: ["sms_ordering", "sms_follow_up"],
    });

    expect(result.source.provider).toBe("heuristic");
    expect(result.source.available).toBe(false);
    expect(result.source.reason).toMatch(/ollama offline/i);
    expect(result.assistant_name).toBe("LongCat Concierge");
    expect(result.personalized_recommendations.length).toBeGreaterThanOrEqual(3);
    expect(result.memory_grounding).toMatch(/family meals|customer memory|fresh assisted-ordering moment/i);
    expect(result.channel_actions.join(" ")).toMatch(/voice|sms/i);
    expect(result.next_actions[0]).toMatch(/Escalate substitution-heavy calls/i);
  });

  it("uses the local Ollama response for merchant consulting when structured JSON is returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            market_brief: "Lunch demand is strongest on owned surfaces where conversion is already warm.",
            demand_forecast: "Expect steady weekday lunch growth if partner syndication remains secondary to owned retention.",
            menu_actions: [
              "Feature fast-prep bowls during lunch.",
              "Bundle premium drinks with signature mains.",
              "Retire low-margin items with weak reorder rates.",
            ],
            channel_actions: [
              "Keep owned storefront banners aligned with push messages.",
              "Limit marketplace discounting to new-customer capture windows.",
              "Use tableside and phone channels for repeat-order recovery.",
            ],
            financial_watchouts: [
              "Track discount-led contribution margin decay.",
              "Avoid expanding channels before repeat rate stabilizes.",
              "Watch campaign volume that shifts rather than grows demand.",
            ],
            benchmark_summary: "Owned channels outperform partner channels on retention and push conversion.",
            benchmark_actions: [
              "Keep owned conversion benchmarks visible each week.",
              "Intervene when partner-led volume dilutes repeat rate.",
              "Use campaign cohorts to prioritize merchant coaching.",
            ],
          }),
        }),
      }),
    );

    const result = await buildMerchantConsultant({
      activated_channels: 6,
      branded_storefronts: 14,
      partner_channels: 3,
      channel_mix: ["Owned storefront", "Marketplace", "Phone ordering"],
      recommended_action: "Stabilize live channels before expanding syndication.",
      benchmark_summary: "Owned channels account for 62% of activated surfaces with stronger retention than partner channels.",
      forecast_inputs: ["6 active channel surfaces", "14 branded storefronts", "3 partner-led channels"],
    });

    expect(result.source.provider).toBe("ollama");
    expect(result.source.available).toBe(true);
    expect(result.market_brief).toMatch(/Lunch demand/i);
    expect(result.menu_actions).toContain("Feature fast-prep bowls during lunch.");
    expect(result.benchmark_summary).toMatch(/Owned channels outperform partner channels/i);
    expect(result.benchmark_actions).toHaveLength(3);
    expect(result.financial_watchouts).toHaveLength(3);
  });

  it("produces dispatch fallback guidance with ranked candidates when the local model is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const result = await buildDispatchIntelligence({
      online_drivers: 4,
      trip_radar_candidates: 3,
      airport_ready_drivers: 1,
      avg_weekly_earnings: 751,
      recommended_action: "Rebalance airport-ready supply before the next peak.",
      telemetry_summary: "Airport zone is critical with double-digit wait times while Victoria Island remains elevated.",
      telemetry_signals: [
        "Airport=critical pressure, wait 13.4m, 7 drivers available",
        "Victoria Island=elevated pressure, wait 9.1m, 8 drivers available",
      ],
      supply_queue: [
        {
          driver: "Amina Okafor",
          mode: "delivery",
          zone: "Airport",
          rating: 4.9,
          reliability: "97%",
          weekly_earnings: "$820",
          status: "online",
          next_action: "Eligible for trip radar and batch offers",
        },
        {
          driver: "Fatima Bello",
          mode: "delivery",
          zone: "Yaba",
          rating: 4.8,
          reliability: "95%",
          weekly_earnings: "$735",
          status: "online",
          next_action: "Eligible for trip radar and batch offers",
        },
      ],
    });

    expect(result.source.provider).toBe("heuristic");
    expect(result.dispatch_brief).toMatch(/Rebalance airport-ready supply/i);
    expect(result.ranked_candidates.length).toBeGreaterThan(0);
    expect(result.telemetry_summary).toMatch(/Airport zone is critical|Dispatch guidance is using live supply/i);
    expect(result.recommended_reallocations).toHaveLength(3);
    expect(result.risk_flags.join(" ")).toMatch(/Airport reserve|online driver/i);
  });

  it("requires explicit customer or operator confirmation before automatic callback dispatch", () => {
    expect(shouldAllowAutomaticCallbackDispatch({
      speaker: "customer",
      utterance: "The merchant should probably confirm this later",
      metadata: {},
    })).toBe(false);

    expect(shouldAllowAutomaticCallbackDispatch({
      speaker: "customer",
      utterance: "Please call me back when the item is available",
      metadata: {},
    })).toBe(true);

    expect(shouldAllowAutomaticCallbackDispatch({
      speaker: "agent",
      utterance: "Need follow-up",
      metadata: { allow_callback_dispatch: true },
    })).toBe(true);
  });

  it("treats completed, failed, abandoned, and closed LongCat sessions as terminal for new voice turns", () => {
    expect(isLongCatVoiceSessionTerminal("completed")).toBe(true);
    expect(isLongCatVoiceSessionTerminal("failed")).toBe(true);
    expect(isLongCatVoiceSessionTerminal("abandoned")).toBe(true);
    expect(isLongCatVoiceSessionTerminal("closed")).toBe(true);
    expect(isLongCatVoiceSessionTerminal("active")).toBe(false);
    expect(isLongCatVoiceSessionTerminal("open")).toBe(false);
  });
});
