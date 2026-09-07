#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_KUBECTL_STATE_DIR:?FAKE_KUBECTL_STATE_DIR is required}"
mkdir -p "$FAKE_KUBECTL_STATE_DIR"
printf '%q ' "$@" >>"$FAKE_KUBECTL_STATE_DIR/curl-commands.log"
printf '\n' >>"$FAKE_KUBECTL_STATE_DIR/curl-commands.log"
printf '%s\n' '{}'
