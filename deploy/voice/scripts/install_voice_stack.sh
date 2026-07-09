#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root on the target persistent host." >&2
  exit 1
fi

ENV_FILE=${1:-/etc/switchos/longcat-voice.env}
SWITCHOS_ROOT=${2:-/opt/switchos/DeliveryPlatform}
VOICE_DIR=/etc/switchos
SYSTEMD_DIR=/etc/systemd/system
ASTERISK_EXTENSIONS=/etc/asterisk/extensions.conf
ASTERISK_AUDIOSOCKET_DIR=/etc/asterisk
PIPER_VERSION=${PIPER_VERSION:-1.3.0}
PIPER_MODEL_URL=${PIPER_MODEL_URL:-https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx}
PIPER_CONFIG_URL=${PIPER_CONFIG_URL:-https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json}

mkdir -p "$VOICE_DIR" /opt/piper "$SWITCHOS_ROOT"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Copy deploy/voice/env/longcat-voice.env.example to this path and adjust secrets first." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  asterisk \
  ffmpeg \
  git \
  curl \
  wget \
  python3-pip \
  python3-venv \
  nodejs \
  npm

if ! command -v go >/dev/null 2>&1; then
  echo "Go must be installed separately on the target host." >&2
  exit 1
fi

python3 -m pip install --break-system-packages faster-whisper ctranslate2 fastapi uvicorn requests python-dateutil

if [[ ! -x /usr/local/bin/piper ]]; then
  ARCHIVE=/tmp/piper_linux_x86_64.tar.gz
  curl -L --fail -o "$ARCHIVE" "https://github.com/rhasspy/piper/releases/download/$PIPER_VERSION/piper_linux_x86_64.tar.gz"
  tar -xzf "$ARCHIVE" -C /opt/piper --strip-components=1
  install -m 0755 /opt/piper/piper /usr/local/bin/piper
fi

if [[ ! -f /opt/piper/en_US-lessac-medium.onnx ]]; then
  curl -L --fail -o /opt/piper/en_US-lessac-medium.onnx "$PIPER_MODEL_URL"
fi
if [[ ! -f /opt/piper/en_US-lessac-medium.onnx.json ]]; then
  curl -L --fail -o /opt/piper/en_US-lessac-medium.onnx.json "$PIPER_CONFIG_URL"
fi

install -m 0644 "$SWITCHOS_ROOT/deploy/voice/systemd/longcat-speech-runtime.service" "$SYSTEMD_DIR/longcat-speech-runtime.service"
install -m 0644 "$SWITCHOS_ROOT/deploy/voice/systemd/longcat-voice-gateway.service" "$SYSTEMD_DIR/longcat-voice-gateway.service"
install -m 0644 "$SWITCHOS_ROOT/deploy/voice/systemd/longcat-notification-dispatcher.service" "$SYSTEMD_DIR/longcat-notification-dispatcher.service"
install -m 0644 "$SWITCHOS_ROOT/deploy/voice/systemd/longcat-benchmark-refresh.service" "$SYSTEMD_DIR/longcat-benchmark-refresh.service"
install -m 0644 "$SWITCHOS_ROOT/deploy/voice/systemd/longcat-benchmark-refresh.timer" "$SYSTEMD_DIR/longcat-benchmark-refresh.timer"
install -m 0644 "$SWITCHOS_ROOT/deploy/voice/asterisk/extensions.switchos-longcat.conf" "$ASTERISK_AUDIOSOCKET_DIR/extensions.switchos-longcat.conf"

if [[ -f "$ASTERISK_EXTENSIONS" ]] && ! grep -q "switchos-longcat" "$ASTERISK_EXTENSIONS"; then
  printf '\n#include "extensions.switchos-longcat.conf"\n' >> "$ASTERISK_EXTENSIONS"
fi

systemctl daemon-reload
systemctl enable longcat-speech-runtime.service
systemctl enable longcat-voice-gateway.service
systemctl enable longcat-notification-dispatcher.service
systemctl enable longcat-benchmark-refresh.timer

echo "LongCat voice and non-voice LongCat deployment assets applied. Start the services after verifying the env file, provider URLs, and repository paths."
