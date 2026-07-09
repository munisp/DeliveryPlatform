# Logistics gap UI and mobile audit — 2026-07-09

## Current surface inventory

The current repository exposes logistics and supply-chain functionality across these main layers:

| Layer | Current surface |
| --- | --- |
| TypeScript orchestration | `server/_core/localCommerceSuperGateway.ts`, `server/_core/dispatchOptimizer.ts`, `server/_core/longcat.ts`, `server/_core/longcatVoice.ts`, `server/_core/longcatActions.ts` |
| Go services | `services/go/local-commerce-gateway/main.go`, `services/go/notification-dispatcher/main.go`, `services/go/voice-gateway/main.go` |
| Rust services | `services/rust/dispatch-optimizer/src/main.rs` |
| Python services | `services/python/retail-forecast/main.py`, speech runtime |
| Middleware and deploy assets | Dapr, Kafka-compatible, Fluvio, Temporal-style hooks; systemd and env assets in `deploy/voice/` |
| Web UI | `client/src/App.tsx` plus pages for Analytics, DriverMobility, MerchantChannels, PhoneOrderingStudio, ServiceRecovery, TablesideCommerce, and WhiteLabelApps |
| PWA | `public/manifest.webmanifest`, offline shell tests in `tests/pwa-shell.test.ts` |
| Mobile-specific repo | No dedicated Expo or React Native app directory is currently present |

## Key findings

| Finding | Implication |
| --- | --- |
| The backend now contains retail forecasting, warehouse allocation, and local-commerce concierge services. | The logistics engine is stronger than the current UI reveals. |
| The main client app routes do not currently expose a dedicated supply-chain or logistics control workspace. | A new operator-facing workspace is needed. |
| The Driver Mobility page exposes dispatch intelligence, but not warehouse allocation, inventory pressure, or forecast-backed fulfillment readiness. | Existing logistics UI should be expanded, not only supplemented. |
| The Merchant Channels page exposes LongCat merchant insights, but not operational retail forecast or warehouse allocation outputs. | Merchant-facing supply intelligence should be surfaced there as well. |
| The PWA shell exists, but the route inventory and shortcuts appear focused on current operator workspaces rather than new logistics-specific workflows. | Manifest, landing, and mobile-friendly navigation should be updated. |
| No standalone mobile application tree is present. | “Mobile” should be interpreted as responsive web/PWA and mobile-friendly workflow surfaces unless a new mobile app is created later. |

## Highest-value implementation targets

| Priority | Target |
| --- | --- |
| 1 | Add a dedicated logistics and supply-chain operator workspace in the web UI. |
| 2 | Expose the TypeScript local-commerce super-gateway and related logistics summaries through router procedures that the client can call directly. |
| 3 | Extend Driver Mobility with supply-chain-aware dispatch, warehouse, and readiness signals. |
| 4 | Extend Merchant Channels with forecast-backed inventory and fulfillment risk views. |
| 5 | Add PWA shortcuts and mobile-friendly entry points for logistics control workflows. |
| 6 | Add integrated middleware-aware logistics planning surfaces that show gateway, forecast, and allocation outputs together. |

## Honest constraint

There is currently **no separate mobile app project** in the repository. The appropriate implementation path for this request is therefore to update the **existing web client and PWA shell** so they behave well on mobile form factors and expose the new logistics capabilities through responsive operator flows.
