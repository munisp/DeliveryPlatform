import fs from "node:fs/promises";
import path from "node:path";

import { planLocalCommerceConciergeIntent } from "../server/_core/localCommerceSuperGateway";
import { getLiveIntegrationStatus } from "../server/_core/integrationProbes";

async function main() {
  const result = await planLocalCommerceConciergeIntent({
    city: "Lagos",
    customerSegment: "switchos_one_member",
    categories: ["delivery", "retail", "travel", "mobility"],
    request: "Plan a same-day grocery and pharmacy basket, preserve my membership benefits, and keep the option to add an airport transfer for later tonight.",
    basket: [
      {
        sku: "milk-1l",
        label: "Milk 1L",
        category: "grocery",
        quantity: 6,
        onHandUnits: 4,
        reservedUnits: 1,
        inboundUnits: 2,
        leadTimeHours: 6,
        eventMultiplier: 1.2,
        weatherMultiplier: 1.0,
        substitutionGroup: "dairy_alt",
        coldChainRequired: true,
      },
      {
        sku: "pain-relief-24",
        label: "Pain Relief 24ct",
        category: "pharmacy",
        quantity: 3,
        onHandUnits: 1,
        reservedUnits: 0,
        inboundUnits: 4,
        leadTimeHours: 4,
        eventMultiplier: 1.1,
        weatherMultiplier: 1.0,
        substitutionGroup: "analgesic_alt",
        coldChainRequired: false,
      },
    ],
    warehouseCandidates: [
      {
        warehouseId: 701,
        label: "VI Dark Store",
        zoneKey: "Victoria Island",
        distanceKm: 3.2,
        pickPackMinutes: 9,
        coldChainReady: true,
        stockAccuracy: 0.97,
        inventory: [
          { sku: "milk-1l", availableUnits: 5, freshnessHours: 18 },
          { sku: "pain-relief-24", availableUnits: 2, freshnessHours: 240 },
        ],
      },
      {
        warehouseId: 702,
        label: "Lekki Retail Hub",
        zoneKey: "Lekki",
        distanceKm: 7.6,
        pickPackMinutes: 6,
        coldChainReady: false,
        stockAccuracy: 0.95,
        inventory: [
          { sku: "milk-1l", availableUnits: 8, freshnessHours: 30 },
          { sku: "pain-relief-24", availableUnits: 5, freshnessHours: 400 },
        ],
      },
      {
        warehouseId: 703,
        label: "Yaba Pharmacy Node",
        zoneKey: "Yaba",
        distanceKm: 5.1,
        pickPackMinutes: 8,
        coldChainReady: true,
        stockAccuracy: 0.91,
        inventory: [
          { sku: "milk-1l", availableUnits: 2, freshnessHours: 16 },
          { sku: "pain-relief-24", availableUnits: 8, freshnessHours: 320 },
        ],
      },
    ],
  });

  const integrationStatus = await getLiveIntegrationStatus();
  const output = {
    generated_at: new Date().toISOString(),
    decision_summary: result.decision_summary,
    workspace_summary: result.workspace.summary,
    forecast_summary: result.forecast?.summary ?? null,
    allocation_summary: result.allocation?.rationale ?? null,
    gateway_strategy: result.gatewayPlan?.strategy ?? null,
    gateway_event_id: result.gatewayPlan?.event_id ?? null,
    action_plan: result.gatewayPlan?.action_plan ?? [],
    integration_status: integrationStatus,
    raw: result,
  };

  const outputPath = path.join(process.cwd(), "validation", "meituan_competitive_upgrade_e2e_output.json");
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ ok: true, outputPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
