#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${FINANCIAL_REHEARSAL_RUNTIME_DIR:-${repo_root}/.financial-rehearsal}"
env_file="${runtime_dir}/rehearsal.env"

if [[ -e "${env_file}" || -e "${runtime_dir}/tigerbeetle-data/0_0.tigerbeetle" ]]; then
  echo "Refusing to overwrite existing financial-rehearsal state at ${runtime_dir}." >&2
  exit 2
fi

umask 077
mkdir -p "${runtime_dir}/tigerbeetle-data"
random_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

cat >"${env_file}" <<EOF
FINANCIAL_REHEARSAL_DATA_DIR=${runtime_dir}/tigerbeetle-data
FINANCIAL_TEST_POSTGRES_PASSWORD=$(random_hex)
FINANCIAL_TEST_INTERNAL_SERVICE_TOKEN=$(random_hex)
FINANCIAL_TEST_CLUSTER_ID=1
FINANCIAL_TEST_ACCOUNT_MAP_JSON={"test-issuer":"00000000000000000000000000000001","test-payer":"00000000000000000000000000000002","test-payee":"00000000000000000000000000000003"}
EOF
chmod 600 "${env_file}"
printf 'Prepared isolated financial rehearsal configuration at %s\n' "${env_file}"
