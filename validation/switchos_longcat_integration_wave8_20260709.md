# SwitchOS LongCat Integration Report — Wave 8

**Author:** Manus AI  
**Date:** 2026-07-09

## Executive Summary

This wave implemented a **LongCat-style AI layer** inside the existing SwitchOS food-delivery platform, using a **local Ollama runtime with `qwen2.5:3b`** instead of GPT-5.5 as requested. The implementation translated the user-provided Meituan use case into three production-relevant platform surfaces: a **consumer ordering assistant** for the phone-ordering workspace, a **merchant copilot** for the merchant-channel workspace, and a **dispatch intelligence layer** for the driver-mobility workspace [1].

The integration is honest about runtime behavior. When the local model is available, the platform now synthesizes workspace-aware AI guidance through a real Ollama-backed flow. When the model is unavailable, slow, or returns malformed output, the system degrades to **deterministic heuristic guidance** rather than pretending that AI output was produced. That fallback behavior is validated and intentionally visible in the returned metadata.

## Use-Case Mapping from Meituan LongCat to SwitchOS

The attached Meituan brief describes LongCat as a shared cognitive core spanning consumer ordering, merchant decision support, and delivery logistics [1]. I mapped those principles onto the already-existing SwitchOS operator surfaces instead of creating disconnected demo code.

| Meituan use case | SwitchOS implementation target | Implemented in this wave | Honest status |
| --- | --- | --- | --- |
| **Xiaomei** conversational assistant for ordering, recommendations, and accessibility | `PhoneOrderingStudio` and `getPhoneOrderingWorkspace()` | Added **LongCat Concierge** with conversation goal, personalized recommendations, operator script, accessibility note, and next actions | **Implemented and validated** |
| **Daimao Consultant** for market analysis, menu decisions, and financial planning | `MerchantChannels` and `getMerchantChannelWorkspace()` | Added **LongCat Merchant Copilot** with market brief, demand forecast, menu actions, channel actions, and financial watchouts | **Implemented and validated** |
| LongCat logistics intelligence for dispatch optimization and efficiency | `DriverMobility`, `dispatchOptimizer`, and `getDriverMobilityWorkspace()` | Added **LongCat Dispatch Intelligence** with dispatch brief, batching strategy, rider guidance, risk flags, and ranked candidates | **Implemented and validated** |
| Mixture-of-experts style efficient execution | Shared LongCat backend orchestration | Implemented a practical equivalent through **two-tier execution**: local Ollama first, deterministic heuristics second | **Partially implemented** |
| Restaurant booking and full conversational action-taking | End-user transactional agent flows | Not implemented in this wave | **Still pending** |

## What Was Implemented

### Backend AI Orchestration

A new server-side module, `server/_core/longcat.ts`, now acts as the LongCat orchestration layer. It sends structured prompts to the local Ollama endpoint, normalizes returned JSON into UI-safe fields, and exposes three focused builders for consumer, merchant, and dispatch workflows.

The runtime contract is deliberately defensive. The integration records whether output came from **`ollama`** or **`heuristic`**, preserves the active model name, and includes a failure reason when it falls back. This means the platform can surface AI-generated operating guidance without hiding runtime degradation.

### Consumer Ordering Assistant

The phone-ordering workspace now returns a `longcat` block that reflects the Meituan **Xiaomei** pattern in a SwitchOS-friendly form. It focuses on voice-first assisted ordering, substitution handling, customer preference capture, and accessibility-sensitive operator guidance [1].

On the frontend, `PhoneOrderingStudio.tsx` now renders a dedicated LongCat panel containing the conversational goal, operator script, accessibility guidance, recommendation list, and next actions. This turns the existing phone-ordering page into a credible assisted-ordering copilot instead of a static KPI surface.

### Merchant Decision Copilot

The merchant-channels workspace now returns a `longcat` consultant payload aligned with the **Daimao Consultant** use case described in the attachment [1]. The assistant synthesizes market posture, demand outlook, menu actions, channel actions, and financial watchouts from the platform’s current merchant-channel summary.

On the frontend, `MerchantChannels.tsx` now exposes this analysis as a merchant-copilot panel rather than leaving those AI use-case claims unimplemented.

### Dispatch Intelligence Layer

The driver-mobility workspace now includes a `longcat` dispatch payload that combines local-model guidance with the pre-existing ranking engine in `dispatchOptimizer`. The model supplies narrative dispatch guidance, while deterministic ranked candidates remain anchored in platform logic. That is an appropriate compromise between LLM reasoning and operational determinism.

On the frontend, `DriverMobility.tsx` now renders LongCat dispatch brief sections, risk flags, and ranked-candidate views. This directly reflects the Meituan logistics-intelligence principle while staying honest about what is and is not yet connected to live traffic, weather, and restaurant-prep telemetry [1].

## Validation Evidence

The LongCat wave was validated at three levels: automated tests, production build, and live local-model execution.

| Validation layer | Evidence | Result |
| --- | --- | --- |
| Automated integration tests | `npm test -- tests/longcat.integration.test.ts tests/platform.scenarios.test.ts` | **Passed** |
| Production build | `npm run build` | **Passed** |
| Live local model runtime | Installed Ollama, pulled `qwen2.5:3b`, verified `/api/generate`, then ran `tmp/validate_longcat_runtime.ts` against the live runtime | **Passed** |

The live runtime validation is important because it proves the integration is not just mocked. The platform successfully produced consumer, merchant, and dispatch LongCat outputs through a real local Qwen model after increasing the timeout budget and normalizing variable response shapes.

## Readiness Impact for Affected Components

These scores reflect the **affected components only**, not a full replacement for the broader platform scorecard already documented in Wave 7.

| Component | Prior posture | Current posture | Score / 10 | Rationale |
| --- | --- | --- | --- | --- |
| Phone-ordering AI assistance | Existing workspace without real AI copilot | Real LongCat-style assistant with live local-model path and honest fallback | **7.4** | The feature is now real and validated, but it still lacks full caller memory, booking actions, and omnichannel voice infrastructure. |
| Merchant AI copilot | Static merchant workspace without embedded consultant intelligence | Real merchant-consulting layer with validated local-model integration and honest fallback | **7.1** | Strongly improved, though still limited by absence of live competitor feeds, location-intelligence tooling, and richer financial modeling. |
| Dispatch AI intelligence | Deterministic dispatch optimizer only | Hybrid LLM-plus-deterministic dispatch guidance with ranked candidate retention | **7.6** | Better operational explainability and planning, but still not connected to live traffic, weather, prep-time, or broker-driven event streams. |
| Local AI runtime integration | No local Ollama-backed business copilot path | Installed and validated Ollama with Qwen model and production-safe fallback contract | **7.0** | Real local inference now exists, but operational hardening remains incomplete around model lifecycle, caching, queuing, concurrency, and infra packaging. |
| Overall food-delivery intelligence layer | Claimed AI potential without a mapped cognitive-core implementation | Credible first LongCat-style vertical slice across consumer, merchant, and dispatch domains | **7.3** | This is now a real platform capability, but not yet a full Meituan-equivalent cognitive operating system. |

## Residual Blockers and Honest Gaps

The attached Meituan use case goes beyond what this wave implemented. Several important capabilities are still incomplete.

| Gap | Why it still matters |
| --- | --- |
| No real voice pipeline or speech interface | The current consumer assistant is rendered in the operator workspace, but it is not yet wired to live telephony speech recognition or spoken response. |
| No booking or fully agentic transactional actioning | The assistant does not yet create restaurant reservations or execute multi-step customer intents across third-party services. |
| No live personalization memory from historical order profiles | Recommendations are workspace-aware, but not yet grounded in durable user preference or order-history memory. |
| No live external merchant intelligence feeds | Merchant advice remains internally synthesized rather than benchmarked against real local competitor or footfall data. |
| No live telemetry-backed dispatch features | Traffic, weather, elevator status, kitchen prep-time forecasting, and dynamic rider pricing remain future integrations. |
| No production packaging for Ollama | The local runtime works in this sandbox, but a stage or production deployment path for model hosting, concurrency control, and observability is still required. |

## Recommended Next Actions

The next highest-value move is to turn this AI slice from a workspace copilot into a **live operational subsystem**.

| Priority | Next action | Why it matters |
| --- | --- | --- |
| 1 | Connect LongCat Concierge to the live phone and messaging flows | This converts the current operator-facing assistant into real customer-service automation. |
| 2 | Add durable customer preference memory and order-history grounding | This is required for the “hyper-personalized” experience described in the use case [1]. |
| 3 | Feed dispatch prompts with live prep-time, traffic, and event telemetry | This is the biggest step toward Meituan-style real-time logistics intelligence [1]. |
| 4 | Add merchant benchmarking and forecasting datasets | This makes the merchant copilot materially useful for real business planning rather than static advisory text. |
| 5 | Package the Ollama runtime for a persistent stage host | This is necessary before claiming reliable production AI inference. |

## References

[1]: /home/ubuntu/upload/pasted_content.txt "User-provided Meituan LongCat use-case attachment"
