# Real Historical Dispatch-Log Acceptance Contract

This evaluator may calculate an **estimated offline policy value** only from an immutable, provenance-controlled extract of actual past operational dispatch decisions. Synthetic fixtures, generated records, replayed examples, and aggregate counters are useful for parser tests only and must never be represented as historical evidence or used in a rollout decision.

## Required record contract

Each JSONL record must include the evaluator's required fields and immutable provenance metadata:

| Field | Requirement |
|---|---|
| `decision_id` | Stable, unique opaque identifier; no driver/customer PII. |
| `domain` | One allowlisted non-authoritative domain, such as `dispatch_offer_ranking`. |
| `logged_action` | Action actually selected by the historical logged policy. |
| `logged_propensity` | Selection probability recorded at decision time, in `(0, 1]`. |
| `reward` | Predefined normalized realized outcome in `[-1, 1]`, computed before evaluation. |
| `candidate_actions` | Full action set available at decision time. |
| `event_time` | UTC decision timestamp for retention and leakage review. |
| `source_export_digest` | SHA-256 digest of the canonical source export; it must match every record and the detached manifest. |
| `schema_version` | Versioned logger schema identifier. |

## Canonical provenance protocol

The producer must compute `source_export_digest` without a self-referential checksum. For each record, remove `source_export_digest`, serialize the remaining object using `json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`, append exactly one newline byte, and SHA-256 the concatenation in immutable input order. Place the resulting lowercase hexadecimal digest in each delivered record and in a detached JSON manifest. The manifest must attest append-only source logging, decision-time propensity capture, removal of direct identifiers, and removal of location traces. The parser rejects blank lines, non-object JSON, missing provenance fields, digest disagreement, unapproved schemas, malformed or non-UTC event times, duplicate decisions, mixed domains, forbidden identifier/location field names, and evaluator-level policy violations.

## Data acceptance gates

The data owner must attest that the extract came from append-only decision logging, that propensities were not backfilled, and that reward construction is documented. Remove direct identifiers and location traces before export. The evaluator must reject mixed domains, duplicate decisions, unknown propensities, invalid action sets, and forbidden domains.

An approval review must confirm adequate sample size, action overlap, time-split evaluation, reward leakage checks, cohort fairness analysis, and statistically bounded uncertainty. A positive offline estimate grants eligibility only for shadow evaluation; it never authorizes execution or changes payment, safety, inventory, lifecycle, or vehicle-control behavior.

## Minimum command shape

```bash
python3 services/python/lakehouse/offline_rl_policy_evaluator.py \
  --input /secure/export/redacted_dispatch_decisions.jsonl \
  --provenance-manifest /secure/export/redacted_dispatch_decisions.manifest.json \
  --action-priority rank_best_eta,rank_nearest \
  --minimum-records 1000 \
  --minimum-uplift 0.01 \
  --audit-log /secure/audit/offline_policy_evaluations.jsonl \
  --evaluation-id dispatch-policy-2026-09-10
```

The export path and audit path must be access-controlled. Audit outputs are governance evidence, not a command to apply a recommendation.
