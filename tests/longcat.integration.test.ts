import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildConsumerAssistant,
  buildDispatchIntelligence,
  buildMerchantConsultant,
} from "../server/_core/longcat";
import { shouldAllowAutomaticCallbackDispatch } from "../server/_core/longcatVoice";

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
    });

    expect(result.source.provider).toBe("heuristic");
    expect(result.source.available).toBe(false);
    expect(result.source.reason).toMatch(/ollama offline/i);
    expect(result.assistant_name).toBe("LongCat Concierge");
    expect(result.personalized_recommendations.length).toBeGreaterThanOrEqual(3);
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
    });

    expect(result.source.provider).toBe("ollama");
    expect(result.source.available).toBe(true);
    expect(result.market_brief).toMatch(/Lunch demand/i);
    expect(result.menu_actions).toContain("Feature fast-prep bowls during lunch.");
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
});
