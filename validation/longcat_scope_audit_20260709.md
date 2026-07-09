# LongCat Scope Audit

The recent full-closure work **did not cover every recommendation across the broader SwitchOS AI roadmap**. It closed the **LongCat voice-stack execution path** and the repeated runtime blockers around live speech, gateway ingress, persistence, and lakehouse ingestion. That means the latest pass fully addressed the recommendation to connect LongCat Concierge to the live phone flow, at least for the locally validated sandbox path.

## What the latest closure actually completed

| Recommendation area | Status | Notes |
| --- | --- | --- |
| Connect LongCat Concierge to live phone flow | **Implemented locally** | End-to-end AudioSocket -> STT -> LongCat core -> TTS -> persistence -> lakehouse was validated locally. |
| Real self-hosted speech stack | **Implemented locally** | Faster-whisper STT and Piper TTS are running and validated. |
| Telephony ingress lifecycle hardening | **Implemented locally** | Session bootstrap, transcript persistence, close handling, and operator probes were completed for the local path. |
| Lakehouse side-path for LongCat voice events | **Implemented locally** | Local port 8007 service was brought up and voice events now ingest locally. |

## Recommendations that are still broader than the completed voice work

These items were identified earlier and were **not fully implemented** by the final LongCat voice closure.

| Remaining recommendation | Current status | Why it is still open |
| --- | --- | --- |
| Durable customer preference memory and order-history grounding | **Partially implemented only** | LongCat has session/memory structures, but the broader recommendation was to make personalization deeply grounded in real historical customer order behavior across the platform. That was not completed end to end. |
| Dispatch prompts fed by live prep-time, traffic, and event telemetry | **Still open** | The voice stack was completed, but Meituan-style real-time logistics intelligence was not built out. |
| Merchant benchmarking and forecasting datasets | **Still open** | Merchant intelligence remains outside the completed voice remediation scope. |
| Booking or fully agentic transactional actioning across third-party services | **Still open** | The assistant can now operate in voice flow, but not yet as a fully agentic multi-system booking and action engine. |
| Production packaging of the broader AI/runtime estate | **Still partly open** | Voice deployment assets exist and local services run, but broader persistent-host, stage, and production packaging for all AI surfaces was not fully completed end to end. |
| Live external merchant intelligence feeds | **Still open** | This was part of the earlier residual gap set and was not addressed by the voice-stack closure. |
| Live telemetry-backed dispatch features | **Still open** | Traffic, weather, kitchen prep forecasting, elevator status, and dynamic rider pricing integrations were not implemented. |

## Bottom line

The last completion should be understood as **full closure of the LongCat voice recommendation cluster**, not full closure of **all** previously suggested SwitchOS recommendations. So your concern is correct: there are still non-voice recommendations left, and they need a separate implementation pass instead of being implied as already done.
