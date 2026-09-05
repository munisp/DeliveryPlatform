#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULT_DIR="${1:-$ROOT/.integration-cross-language-load}"
OUTPUT_FILE="${2:-$RESULT_DIR/latency_percentiles.csv}"

if [ ! -d "$RESULT_DIR" ]; then
  echo "Load-test result directory does not exist: $RESULT_DIR" >&2
  exit 2
fi

printf 'service,requests,min_seconds,p50_seconds,p90_seconds,p95_seconds,p99_seconds,max_seconds,mean_seconds,stddev_seconds\n' > "$OUTPUT_FILE"
for service in retail procurement inventory pricing dispatch gateway contention; do
  mapfile -t files < <(find "$RESULT_DIR" -maxdepth 1 -type f -name "${service}-*.status" | sort)
  if [ "${#files[@]}" -eq 0 ]; then
    echo "No status files found for ${service}" >&2
    exit 1
  fi

  awk '{print $2}' "${files[@]}" | sort -n | awk -v service="$service" '
    {
      values[NR] = $1
      sum += $1
      sumsq += $1 * $1
    }
    function ceil_index(percent) {
      return int((NR * percent + 99) / 100)
    }
    END {
      count = NR
      mean = sum / count
      variance = (sumsq / count) - (mean * mean)
      if (variance < 0) variance = 0
      printf "%s,%d,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f\n", service, count, values[1], values[ceil_index(50)], values[ceil_index(90)], values[ceil_index(95)], values[ceil_index(99)], values[count], mean, sqrt(variance)
    }
  ' >> "$OUTPUT_FILE"
done

cat "$OUTPUT_FILE"
