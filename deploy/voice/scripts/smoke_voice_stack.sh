#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=${1:-/opt/switchos/DeliveryPlatform}
ENV_FILE=${2:-/etc/switchos/longcat-voice.env}
SPEECH_DIR="$ROOT_DIR/services/python/speech-runtime"
TOKEN=$(grep '^INTERNAL_SERVICE_TOKEN=' "$ENV_FILE" | cut -d= -f2-)

if [[ -z "$TOKEN" ]]; then
  echo "Could not read INTERNAL_SERVICE_TOKEN from $ENV_FILE" >&2
  exit 1
fi

cd "$SPEECH_DIR"
ffmpeg -y -f lavfi -i "flite=text='switchos longcat customer wants noodles and tea':voice=slt" -t 4 sample_flite.wav >/tmp/switchos_flite.log 2>&1
python3 smoke_stt_runtime.py sample_flite.wav | tee /tmp/switchos_stt_smoke.json
curl -sSf http://127.0.0.1:8104/health | tee /tmp/switchos_voice_gateway_health.json >/dev/null
curl -sSf http://127.0.0.1:8105/health | tee /tmp/switchos_speech_runtime_health.json >/dev/null
curl -sSf \
  -H "Content-Type: application/json" \
  -H "X-Internal-Service-Token: $TOKEN" \
  -d '{"sessionId":"smoke-session","externalCallId":"smoke-call-1","telephonyProvider":"asterisk","transport":"audiosocket","speaker":"customer","transcript":"customer wants noodles and tea","finalSegment":true}' \
  http://127.0.0.1:8104/sessions/transcript | tee /tmp/switchos_gateway_transcript.json >/dev/null

echo "LongCat voice stack smoke validation completed."
