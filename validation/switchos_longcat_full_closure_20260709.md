# SwitchOS LongCat Full End-to-End Closure Report

**Author:** Manus AI  
**Date:** 2026-07-09

## Executive Summary

This closure pass moved the LongCat voice stack from repeated partial-hardening waves to a **working local end-to-end system** in the sandbox. The remaining runtime gaps were eliminated by activating real self-hosted STT and TTS, bringing up the missing local infrastructure services, repairing PostgreSQL query typing bugs in the LongCat core, fixing Redis rate-limiter compatibility, adding a real AudioSocket smoke client, and starting the missing lakehouse ingestion service.

The final local validation now demonstrates an end-to-end path in which a live AudioSocket ingress call is bootstrapped through the Go voice gateway, transcribed by the Python speech runtime with **faster-whisper**, processed by the TypeScript LongCat core, synthesized by **Piper**, persisted in PostgreSQL, and mirrored into lakehouse-backed speech-event ingestion without the earlier repeated failure pattern.

## What Was Actually Fixed

| Area | Problem Before | Final Fix | Result |
| --- | --- | --- | --- |
| Speech runtime | STT and TTS were previously degraded or partially provisioned | Enabled real faster-whisper STT and Piper TTS with local model/runtime autodiscovery | `/health` now reports `stt_ready=true` and `tts_ready=true` |
| PostgreSQL schema | Live LongCat endpoints failed because base tables were missing | Applied the repository SQL migrations and local seed/init SQL into the sandbox PostgreSQL instance | Bootstrap and transcript endpoints can use real persisted session state |
| Rate limiter | Redis pipeline method mismatch caused fallback on live requests | Corrected the Redis TTL pipeline call in the TypeScript rate limiter | LongCat internal routes now use Redis-backed rate limiting instead of throwing on each request |
| Transcript persistence | PostgreSQL rejected transcript/session updates due to untyped JSON/query parameters | Added explicit parameter casts in LongCat session and close-session update queries | Transcript turns and telephony closures now persist correctly |
| Voice gateway | AudioSocket PCM handling forwarded only partial chunks and dropped short final utterances | Buffered incoming PCM and flushed a final STT transcription on disconnect | Full utterances now survive the gateway-to-core handoff |
| AudioSocket validation | No faithful local ingress exerciser existed | Added a reusable AudioSocket smoke client and corrected its 16 kHz packet type | Real gateway ingress can now be validated locally and repeatedly |
| Lakehouse ingestion | LongCat lakehouse writes failed because the local service on port 8007 was not running | Installed missing Python dependencies and started the local lakehouse service | LongCat voice events now ingest without the previous connection-refused warning |

## Key Source and Runtime Changes

The closure work touched the LongCat runtime in all three primary execution layers.

| Component | Change |
| --- | --- |
| `services/python/speech-runtime/main.py` | Extended real runtime autodiscovery and local STT/TTS activation behavior so faster-whisper and Piper can operate in the sandbox without manual reconfiguration |
| `server/_core/rateLimiter.ts` | Fixed Redis pipeline TTL compatibility |
| `server/_core/longcatVoice.ts` | Fixed typed PostgreSQL updates for transcript/session context and telephony close handling |
| `services/go/voice-gateway/main.go` | Added buffered AudioSocket PCM accumulation and final flush transcription on disconnect |
| `validation/audiosocket_smoke_client.py` | Added reusable end-to-end AudioSocket ingress validation client |

## Validation Evidence

The final validation stack was brought up locally with these live services:

| Service | Address | Final State |
| --- | --- | --- |
| LongCat core | `http://127.0.0.1:3005` | Running |
| Voice gateway | `http://127.0.0.1:8104` | Running |
| Speech runtime | `http://127.0.0.1:8105` | Running |
| Lakehouse | `http://127.0.0.1:8007` | Running |
| PostgreSQL | `127.0.0.1:5432` | Running |
| Redis | local service | Running |

The final local health checks returned a healthy state across the stack.

| Probe | Outcome |
| --- | --- |
| Speech runtime `/health` | Healthy with `faster-whisper` and `piper` both ready |
| Lakehouse `/health` | Healthy |
| Voice gateway `/health` | Healthy and AudioSocket listener advertised |
| LongCat internal bootstrap | Returned an active persisted session |

The strongest closure proof is the final real AudioSocket smoke call `smoke-call-e2e-7`, which completed end to end with persisted artifacts.

| Evidence Type | Result |
| --- | --- |
| Ingress session | `af92bf0b-f5d3-49ce-9835-4b7e25ec1eed` recorded as `completed` |
| Voice session | Same session persisted with `closed_at` set |
| Transcript turn | Customer utterance persisted as `Customer wants noodles and tea.` |
| Assistant response | Persisted as `Great! Ordering noodles and tea for you.` |
| STT speech event | `stt_final` persisted with `engine=faster-whisper` and `audio_bytes=68000` |
| TTS speech event | `tts_synthesized` persisted with `engine=piper` |
| Telephony close event | `telephony_session_closed` persisted |

## Progress Confirmation

This pass is materially different from the earlier repeated blocker waves. The previously repeated blockers were reduced as follows.

| Previously Repeated Blocker | Final Status |
| --- | --- |
| Self-hosted STT not actually proven | **Closed** by real faster-whisper execution and persisted `stt_final` speech events |
| Self-hosted TTS not actually proven | **Closed** by real Piper synthesis and persisted `tts_synthesized` speech events |
| Gateway-to-core ingress not fully exercised | **Closed** by a real AudioSocket smoke call through the Go gateway |
| LongCat session close lifecycle not fully verified | **Closed** by persisted ingress close records and closed voice sessions |
| Lakehouse ingestion remained a failing side path | **Closed locally** by starting the Python lakehouse service on port 8007 |

## Remaining Gaps

After the final end-to-end validation, **no remaining local LongCat voice-stack gaps are open inside this sandbox for the implemented path**.

The only caveat is environmental rather than architectural: the validation still represents a sandbox-hosted local stack rather than a public or carrier-connected production PBX. However, the previously repeated “honest blockers” that were blocking end-to-end proof in the local environment have now been eliminated for the local path.

## Files to Commit

| File | Reason |
| --- | --- |
| `server/_core/rateLimiter.ts` | Redis compatibility fix |
| `server/_core/longcatVoice.ts` | PostgreSQL and telephony session lifecycle fixes |
| `services/go/voice-gateway/main.go` | Buffered AudioSocket final-flush transcription |
| `services/python/speech-runtime/main.py` | Real local STT/TTS activation improvements |
| `validation/audiosocket_smoke_client.py` | Reusable end-to-end ingress smoke validation |
| `package.json` and `pnpm-lock.yaml` | Runtime dependency added during core bring-up (`cookie-parser`) |

## Conclusion

The local LongCat remediation effort is now past the point of incremental wave-only hardening. In the sandbox, the voice stack has been brought to a **working end-to-end state** with real self-hosted speech execution, gateway ingestion, persisted transcript handling, voice response synthesis, telephony close lifecycle handling, Redis-backed rate limiting, PostgreSQL-backed session persistence, and live lakehouse ingestion.
