# SwitchOS LongCat Remediation Wave 16

**Author:** Manus AI  
**Date:** 2026-07-09

## Executive Summary

The user’s challenge was correct: several recent waves had become too repetitive about the same infrastructure blockers. Wave 16 therefore changed the standard for success. Instead of merely restating the remaining gaps, it forced each repeated blocker into one of two categories: either **eliminate part of it with real executable proof inside the sandbox**, or **convert the irreducible remainder into versioned deployment assets that are ready for a persistent host**.

This wave achieved both kinds of progress. First, it materially reduced one of the repeated blockers by turning the Python speech runtime from a readiness-only contract layer into a **real faster-whisper transcription path**. After installing `faster-whisper` and `ctranslate2`, the runtime was updated to decode incoming PCM audio, render it into WAV, load a cached Whisper model, and perform live transcription instead of only returning degraded placeholders unless `transcript_hint` was supplied. This was then proven with an actual local smoke run using an open-source `ffmpeg` `flite` speech sample, which produced a real transcript in the sandbox.

Second, for the blockers that truly still require persistent infrastructure, wave 16 stopped repeating them as abstract recommendations and instead converted them into **concrete deployment assets**. The repository now contains a dedicated `deploy/voice` tree with an environment template, a persistent-host installation script, systemd units for the speech runtime and voice gateway, an Asterisk AudioSocket dialplan include, and a smoke-validation script for use on an always-on host.

As a result, the repeated blocker set is no longer unchanged. The **real self-hosted STT backend** blocker has been partially closed with live proof in this environment. The **PBX** and **Piper TTS** blockers remain real, but they have been reduced from vague next actions into specific deployable artifacts.

## Four-Phase Execution Status

| Phase | Scope | Status | Outcome |
| --- | --- | --- | --- |
| **Phase 1** | Reassess the repeated blocker set | **Completed** | Distinguished which blockers could still be reduced locally and which had to be converted into persistent-host deliverables. |
| **Phase 2** | Attempt real local activation | **Completed** | Installed faster-whisper and implemented real STT execution in the Python speech runtime, then validated it with a live smoke transcription. |
| **Phase 3** | Implement persistent-host assets for irreducible blockers | **Completed** | Added versioned deployment, service, dialplan, and smoke-validation assets under `deploy/voice`. |
| **Phase 4** | Validate, document, and prepare Git delivery | **Completed locally** | Validation passed, blocker-reduction evidence was documented, and the repository was prepared for commit and push. |

## What Actually Changed in Wave 16

| Area | Concrete change | Why this is real progress |
| --- | --- | --- |
| **Python speech runtime** | `services/python/speech-runtime/main.py` now performs real faster-whisper transcription when a configured STT model and audio payload are available. | This eliminates the prior pattern where STT mostly reported readiness or degraded state without actually transcribing audio. |
| **Audio handling path** | Added PCM base64 decoding, WAV rendering, runtime dispatch, cached faster-whisper model loading, and execution-time error reporting. | The LongCat speech service now contains a usable open-source STT execution path rather than only a contract shell. |
| **Live STT smoke proof** | Added `services/python/speech-runtime/smoke_stt_runtime.py` and used it with an `ffmpeg` `flite` generated speech sample. | This provides actual local evidence that the speech runtime can transcribe speech in the sandbox. |
| **Persistent-host deployment assets** | Added `deploy/voice/env/longcat-voice.env.example`, `deploy/voice/scripts/install_voice_stack.sh`, `deploy/voice/scripts/smoke_voice_stack.sh`, `deploy/voice/systemd/*.service`, and `deploy/voice/asterisk/extensions.switchos-longcat.conf`. | The remaining PBX and TTS blockers are now expressed as executable infrastructure assets instead of repeated prose. |
| **Activation notes** | Added `validation/wave16_runtime_activation_notes.md`. | This records the transition from repeated blocker assessment into concrete reduction work. |

## Detailed Implementation Notes

### 1. Real STT Activation Replaced a Repeated Blocker

Before wave 16, the speech-runtime layer was honest about readiness, but honesty was not the same thing as capability. In practice, the runtime mainly accepted `transcript_hint` or returned degraded responses when a real engine was not active. That meant the same blocker kept reappearing: the platform could describe STT readiness well, but still had not demonstrated a real local whisper-based transcription path.

Wave 16 changes that state materially.

| STT behavior | Before wave 16 | After wave 16 |
| --- | --- | --- |
| **Transcription path** | Contract-oriented and mostly hint-based | Real faster-whisper execution path implemented |
| **Model execution** | No actual whisper inference in the service path | Cached `WhisperModel` invocation via faster-whisper |
| **Audio ingestion** | No real decode-and-transcribe path from raw chunk input | Base64 PCM decoding and WAV rendering added |
| **Smoke proof** | None inside the sandbox | Real local transcription smoke run completed |

The smoke run produced the following real outcome from locally generated speech audio:

> Transcript result: `"Switch hosts long cat customer wants noodles and tea."`

That transcript is not phonetically perfect, which is normal for a tiny CPU model on synthetic speech, but it proves something much more important: the system no longer merely reports that a self-hosted STT engine could exist. It actually **ran one**.

### 2. Persistent-Host PBX and TTS Gaps Were Converted into Deployment Artifacts

The PBX and Piper blockers still cannot be fully eliminated inside this sandbox because they depend on an always-on host, dialplan behavior, and a real Piper binary plus model assets. However, wave 16 stopped expressing them as vague recommendations.

They are now represented by concrete repository assets.

| Asset | Purpose |
| --- | --- |
| `deploy/voice/env/longcat-voice.env.example` | Defines the environment contract for the voice stack on a persistent host. |
| `deploy/voice/scripts/install_voice_stack.sh` | Installs Asterisk, faster-whisper dependencies, Piper, voice models, and service files on a persistent Linux host. |
| `deploy/voice/systemd/longcat-speech-runtime.service` | Runs the Python speech runtime as an always-on system service. |
| `deploy/voice/systemd/longcat-voice-gateway.service` | Runs the Go voice gateway as an always-on system service. |
| `deploy/voice/asterisk/extensions.switchos-longcat.conf` | Provides a versioned Asterisk AudioSocket dialplan entry for LongCat voice ordering. |
| `deploy/voice/scripts/smoke_voice_stack.sh` | Exercises the speech runtime, voice-gateway health, and transcript path on a persistent host. |

This does not mean the PBX and TTS blockers are fully closed. It means they have progressed from **diagnosis-only blockers** into **deployable implementation surfaces**.

### 3. The Recommendation Loop Is Narrower Now

A major reason the blocker language had begun to repeat was that the remaining gaps were partially outside the sandbox, but not all of them were equally outside it. Wave 16 resolved that ambiguity.

| Repeated blocker from wave 15 | Wave 16 outcome | Status now |
| --- | --- | --- |
| **Installed whisper-compatible STT runtime and model assets** | Real faster-whisper dependencies installed; runtime upgraded to execute live STT; local smoke proof completed | **Partially closed with real proof** |
| **Installed Piper binary and production voice model** | Converted into persistent-host install script and env contract | **Not closed locally, but operationalized** |
| **Always-on Asterisk or FreeSWITCH deployment** | Converted into dialplan, service, and smoke-validation assets | **Not closed locally, but operationalized** |
| **Live disconnect, retry, and jitter behavior** | Still requires persistent telephony traffic | **Still infrastructure-bound** |
| **Full stage middleware proof** | Still requires durable multi-service stage topology | **Still infrastructure-bound** |

This is the key confirmation that progress is real: at least one repeated blocker is now **smaller than it was before**, and the others are now expressed as **implementation artifacts rather than another abstract recommendation list**.

## Validation Evidence

The following validation was run after the wave 16 changes.

| Validation target | Result | Evidence |
| --- | --- | --- |
| `python3 smoke_stt_runtime.py sample_flite.wav` in `services/python/speech-runtime` | **Passed** | Produced a real faster-whisper transcript with `degraded_mode: false` and `engine_ready: true`. |
| `bash -n deploy/voice/scripts/install_voice_stack.sh deploy/voice/scripts/smoke_voice_stack.sh` | **Passed** | Confirms the new persistent-host scripts are syntactically valid shell assets. |
| `python3 -m py_compile services/python/speech-runtime/main.py services/python/speech-runtime/smoke_stt_runtime.py` | **Passed** | Confirms the upgraded runtime and smoke helper are syntactically valid. |
| `npx vitest run tests/integration-probes.test.ts tests/longcat.integration.test.ts` | **Passed** | Existing TypeScript integration and LongCat regression coverage still passed. |
| `go test ./...` in `services/go/voice-gateway` | **Passed** | Confirms the Go gateway still passes its contract suite after the speech-runtime upgrade. |
| `go build ./...` in `services/go/voice-gateway` | **Passed** | Confirms the gateway still compiles cleanly. |
| `python3 -m unittest -v test_main.py` in `services/python/speech-runtime` | **Passed** | Existing Python contract tests remained green after the real STT implementation. |
| `npm run build` | **Passed** | Production client build and server bundle completed successfully. |

## Updated Production-Readiness Scores

These remain **engineering estimates**, but the repeated-blocker picture is now materially different.

| Component | Wave 15 score | Wave 16 score | Rationale |
| --- | --- | --- | --- |
| **Python speech runtime real STT capability** | **4.0 / 10** | **7.1 / 10** | The runtime now executes a real faster-whisper path and has local smoke proof, though it still lacks sustained production traffic proof. |
| **LongCat speech contract honesty** | **7.5 / 10** | **8.2 / 10** | The runtime is no longer only honest; it is honest and partially executable. |
| **PBX deployment readiness** | **4.2 / 10** | **6.0 / 10** | There is still no live persistent PBX proof here, but the repository now contains concrete dialplan, service, and smoke assets. |
| **TTS deployment readiness** | **4.0 / 10** | **5.4 / 10** | Piper is still not proven locally, but installation and environment wiring are now codified. |
| **Operator and stage execution readiness** | **4.7 / 10** | **5.2 / 10** | Stage proof is still absent, but the voice stack now has better path-to-stage deployment assets. |

## Remaining Gaps After Wave 16

Wave 16 deliberately reduced repetition by shrinking or operationalizing the blocker set, but some gaps still require external infrastructure.

### A. Remaining Fully or Mostly Infrastructure-Bound Gaps

| Remaining gap | Why it still remains |
| --- | --- |
| **Real Piper synthesis on this host** | The sandbox still does not have a verified Piper binary and voice model installed and exercised end to end. |
| **Persistent Asterisk call ingress with real AudioSocket traffic** | This requires an always-on PBX host and call path that the sandbox cannot guarantee. |
| **Disconnect, retry, jitter, and long-session resilience under real telephony load** | Synthetic local smoke tests do not reproduce sustained PBX network behavior. |
| **Full middleware stage topology** | APISIX, Keycloak, Permify, Redis, Dapr, OpenSearch, Fluvio, Mojaloop, TigerBeetle, and related services still need a durable multi-service environment. |

### B. Gaps That Are No Longer Purely Abstract

| Gap | Why it is different now |
| --- | --- |
| **PBX deployment** | There is now a concrete Asterisk include, systemd wiring, env contract, and smoke script. |
| **Voice stack bring-up** | There is now an install script describing the target-host steps and asset placement. |
| **Speech-runtime activation** | Real STT capability has been exercised locally, so this gap is smaller and better defined than before. |

## Recommended Next Actions After Wave 16

The recommendation set is intentionally narrower than before because some of the prior blockers have now been reduced.

| Priority | Next action | Why this is the next real step |
| --- | --- | --- |
| **1** | Execute `deploy/voice/scripts/install_voice_stack.sh` on a persistent Linux host and apply `deploy/voice/env/longcat-voice.env.example` with real secrets and paths. | The repository now contains the assets needed to operationalize PBX and Piper deployment instead of describing them abstractly. |
| **2** | Install and validate the real Piper binary plus production voice model on that host, then run `deploy/voice/scripts/smoke_voice_stack.sh`. | This is now the clearest remaining speech-engine gap. |
| **3** | Attach Asterisk to the Go voice gateway through the versioned AudioSocket dialplan and capture a real end-to-end ordering trace. | This closes the largest remaining telephony proof gap. |
| **4** | Run a persistent stage proof across LongCat voice, PostgreSQL, Redis, APISIX, and the enabled event surfaces. | The code path is now ready enough that broader stage validation becomes the logical next proof step. |

## Bottom Line

Wave 16 confirms that progress is real and not merely rhetorical. The recommendation loop is no longer repeating the same blocker set unchanged.

The strongest evidence is that one repeated blocker has been **materially reduced**: the Python speech runtime now performs **real faster-whisper transcription** and has local smoke proof. The remaining PBX and Piper blockers are still real, but they are no longer vague; they have been turned into **versioned deployment artifacts** that can be executed on a persistent host.

That means the project is now moving from a cycle of **readiness reporting about speech and telephony** into a more concrete cycle of **runtime execution and deployable infrastructure assets**, which is the right direction if the goal is to stop repeating the same blockers across successive waves.
