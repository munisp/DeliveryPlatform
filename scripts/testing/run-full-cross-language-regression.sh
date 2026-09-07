#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$root/validation/full_cross_language_regression_20260903"
rm -rf "$out"; mkdir -p "$out"
run() { local name="$1"; shift; printf '\n== %s ==\n' "$name" | tee -a "$out/summary.txt"; "$@" 2>&1 | tee "$out/${name}.log"; }
cd "$root"
run typescript_check pnpm check
run typescript_tests pnpm test
run typescript_build pnpm build
for module in services/go/*; do [[ -f "$module/go.mod" ]] || continue; run "go_race_$(basename "$module")" bash -lc "cd '$root/$module' && go test -race ./..."; done
for module in services/rust/*; do [[ -f "$module/Cargo.toml" ]] || continue; run "rust_$(basename "$module")" bash -lc "cd '$root/$module' && cargo test"; done
python_sources=( $(find services/python -type f -name '*.py' -not -path '*/__pycache__/*' | sort) )
run python_compile python3 -m py_compile "${python_sources[@]}"
run payment_webhook_integration scripts/testing/run-payment-webhook-integration.sh
run matching_worker_integration scripts/testing/run-ride-matching-worker-integration.sh
run route_planning_integration scripts/testing/run-logistics-route-plan-integration.sh
run compliance_review_integration scripts/testing/run-lagos-compliance-workflow-integration.sh
run surge_pricing_integration scripts/testing/run-surge-pricing-commission-integration.sh
run telematics_integrity_integration scripts/testing/run-telematics-device-integrity-integration.sh
# Financial operations runs under a fresh least-privilege PostgreSQL principal.
db="financial_operations_regression"; role="financial_operations_regression"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" >/dev/null
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${role}" >/dev/null
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role} LOGIN PASSWORD '${role}_password'" >/dev/null
sudo -u postgres createdb -O "$role" "$db"
sudo -u postgres psql -d "$db" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION postgis; CREATE EXTENSION pgcrypto; CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users(id) VALUES (44);" >/dev/null
for migration in 0028_logistics_operations.sql 0037_financial_operations_extensions.sql; do cp "$root/drizzle/$migration" "/tmp/$migration"; chmod 644 "/tmp/$migration"; sudo -u postgres psql -d "$db" -v ON_ERROR_STOP=1 -f "/tmp/$migration" >/dev/null; done
sudo -u postgres psql -d "$db" -v ON_ERROR_STOP=1 -c "GRANT USAGE ON SCHEMA billing, operations TO ${role}; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA billing, operations TO ${role};" >/dev/null
run financial_operations_integration env TEST_DATABASE_URL="postgres://${role}:${role}_password@127.0.0.1:5432/${db}?sslmode=disable" pnpm exec tsx scripts/testing/test-financial-operations-store.ts
run kubernetes_manifest_validation python3 scripts/testing/validate-kubernetes-manifests.py
run kubernetes_security_validation python3 scripts/testing/validate-kubernetes-security.py
run kubernetes_cicd_validation python3 scripts/testing/validate-kubernetes-cicd.py
run production_static_gate scripts/testing/audit-production-readiness.sh
run diff_integrity git diff --check
printf '\nRESULT=PASS\n' | tee -a "$out/summary.txt"
