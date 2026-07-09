# Wave 16 Runtime Activation Notes

## Real activation targets

1. Determine whether a real open-source STT engine can be installed and exercised in this sandbox.
2. Determine whether a real open-source TTS engine can be installed and exercised in this sandbox.
3. If a blocker cannot be eliminated here, convert it into deployment-ready persistent-host assets instead of repeating it narratively.

## Current assessment snapshot

| Component | Current state |
| --- | --- |
| Ollama | Installed at `/usr/bin/ollama` |
| faster-whisper | Not installed |
| ctranslate2 | Not installed |
| Piper | Not installed |
| whisper.cpp | Not installed |

## Immediate implementation direction

Prioritize real STT activation first, because the current speech runtime mainly exposes contract surfaces and readiness semantics but does not yet execute a real whisper backend. If that can be closed here, it becomes concrete blocker reduction rather than another reporting-only wave.
