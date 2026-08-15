#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${FINANCIAL_REHEARSAL_RUNTIME_DIR:-${repo_root}/.financial-rehearsal}"
env_file="${runtime_dir}/rehearsal.env"
[[ -f "${env_file}" ]] || { echo "Run scripts/prepare-financial-rehearsal.sh first." >&2; exit 2; }
# shellcheck source=/dev/null
source "${env_file}"
data_dir="${FINANCIAL_REHEARSAL_DATA_DIR}"
if find "${data_dir}" -maxdepth 1 -type f -name '*.tigerbeetle' -print -quit | grep -q .; then
  echo "Refusing to reformat existing TigerBeetle files in ${data_dir}." >&2
  exit 2
fi
for replica in 0 1 2; do
  docker run --rm --security-opt seccomp=unconfined -v "${data_dir}:/data" \
    ghcr.io/tigerbeetle/tigerbeetle:0.17.9 \
    format --cluster="${FINANCIAL_TEST_CLUSTER_ID}" --replica="${replica}" --replica-count=3 "/data/0_${replica}.tigerbeetle"
done
printf 'Formatted three isolated TigerBeetle replica files in %s\n' "${data_dir}"
