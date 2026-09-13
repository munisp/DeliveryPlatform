#!/usr/bin/env bash
# Static production gates. Each mandatory section must produce zero matches in
# production source; any finding fails the gate. Test files are excluded: they
# legitimately use mocks, fakes, and console output. The durable-client
# inventory is informational only: a service with no datastore client (for
# example the fixed-scope Kubernetes ConfigMap patch receiver) is classified,
# not failed.
#
# Report is written to .audit-static-report.txt at the repository root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

REPORT="$ROOT/.audit-static-report.txt"
: > "$REPORT"

TS_GLOBS=(--include='*.ts' --include='*.tsx')
ALL_GLOBS=(--include='*.ts' --include='*.tsx' --include='*.go' --include='*.py' --include='*.rs')
TEST_EXCLUDES=(-not -name '*.test.ts' -not -name '*.test.tsx' -not -name '*_test.go' -not -name 'test_*.py' -not -path '*/tests/*')

failures=0

record_section() {
  # record_section <name> <description> <matches>
  local name="$1"
  local description="$2"
  local matches="$3"
  {
    printf '== %s ==\n' "$name"
    printf '%s\n' "$description"
    if [[ -n "$matches" ]]; then
      printf '%s\n' "$matches"
    else
      printf '0 matches\n'
    fi
    printf '\n'
  } >> "$REPORT"
  if [[ -n "$matches" ]]; then
    printf 'static production gate FAILED (%s); see %s\n' "$name" "$REPORT" >&2
    failures=$((failures + 1))
  fi
}

# prod_files <include-glob> [<include-glob>...] : lists production source files,
# excluding tests, under the given directories on stdin scope.
prod_files() {
  local dirs=("$@")
  find "${dirs[@]}" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.go' -o -name '*.py' -o -name '*.rs' \) \
    "${TEST_EXCLUDES[@]}" 2>/dev/null | sort
}

# gate <name> <description> <pattern> <glob>... -- <dir>...
# Mandatory zero-match gate: any match is recorded in the report and fails the run.
gate() {
  local name="$1"
  local description="$2"
  local pattern="$3"
  shift 3
  local includes=()
  while [[ "$1" != "--" ]]; do
    includes+=("$1")
    shift
  done
  shift
  local matches=""
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    local hits
    hits="$(grep -nE "$pattern" "$file" 2>/dev/null || true)"
    if [[ -n "$hits" ]]; then
      matches+="$file"$'\n'"$hits"$'\n'
    fi
  done <<< "$(prod_files "$@")"
  record_section "$name" "$description" "${matches%$'\n'}"
}

# Insecure randomness must never appear in authentication, token, session,
# secret, or credential-handling code paths (matched by file path).
insecure_matches=""
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  hits="$(grep -nE 'Math\.random|math/rand' "$file" 2>/dev/null || true)"
  if [[ -n "$hits" ]]; then
    insecure_matches+="$file"$'\n'"$hits"$'\n'
  fi
done <<< "$(prod_files client/src server services shared | grep -Ei 'auth|token|session|secret|credential|password|crypto' || true)"
record_section "insecure-random-apis" \
  "Math.random / math/rand in security-sensitive source files" \
  "${insecure_matches%$'\n'}"

gate "todo-fixme-markers" \
  "TODO/FIXME markers in production source" \
  '\b(TODO|FIXME)\b' -- client/src server services shared

gate "frontend-console-logging" \
  "console.* calls in the frontend bundle source" \
  'console\.(log|warn|error|info|debug)\(' -- client/src

gate "rust-stdout-logging" \
  "println!/eprintln! in Rust services (use structured tracing)" \
  '(println!|eprintln!)' -- services/rust

# Batch ML CLI entrypoints whose stdout JSON result is the program output
# contract, not unstructured service logging.
PYTHON_STDOUT_EXCEPTIONS=(
  services/python/lakehouse/ml_pipeline/train_mobility_risk_model.py
  services/python/lakehouse/offline_rl_policy_evaluator.py
)
python_stdout_matches=""
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  case " ${PYTHON_STDOUT_EXCEPTIONS[*]} " in
    *" $file "*) continue ;;
  esac
  hits="$(grep -nE '^[[:space:]]*print\(' "$file" 2>/dev/null || true)"
  if [[ -n "$hits" ]]; then
    python_stdout_matches+="$file"$'\n'"$hits"$'\n'
  fi
done <<< "$(prod_files services/python)"
record_section "python-stdout-logging" \
  "print() in Python service runtime modules (use structured logging)" \
  "${python_stdout_matches%$'\n'}"

gate "mock-stub-markers" \
  "mock/stub/fake implementation markers in production source" \
  '\b(mock|stub|fake)[a-z]*\b' -- client/src server services shared

gate "likely-empty-handlers" \
  "empty arrow-function handlers in TypeScript source" \
  '=>\s*\{\s*\}' -- client/src server

# Durable-client indicator inventory (informational; never fails the gate).
{
  printf '== durable-client-inventory ==\n'
  printf 'Services and their datastore/broker client indicators (informational)\n'
  for service in services/go/*/ services/python/*/ services/rust/*/; do
    service="${service%/}"
    [[ -d "$service" ]] || continue
    durable_clients="$(grep -rIlE 'sql\.Open|pgx|database/sql|redis\.|kafka|sarama|psycopg|asyncpg|sqlx|sqlalchemy|tigerbeetle' "$service" 2>/dev/null || true)"
    printf '%s: ' "$service"
    if [[ -n "$durable_clients" ]]; then
      printf '%s' "$durable_clients" | tr '\n' ' '
      printf '\n'
    elif [[ "$service" == "services/go/resilience-circuit-breaker-alert-receiver" ]]; then
      printf 'intentional fixed-scope Kubernetes ConfigMap patch receiver (no datastore client)\n'
    else
      printf 'no durable-client indicator found\n'
    fi
  done
  printf '\n'
} >> "$REPORT"

if [[ "$failures" -gt 0 ]]; then
  printf 'static production gates FAILED: %d section(s) with findings; see %s\n' "$failures" "$REPORT" >&2
  exit 1
fi

printf 'static production gates passed; report=%s\n' "$REPORT"
