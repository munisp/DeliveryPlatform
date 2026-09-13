# Offline Policy Log Contract

`offline_policy_log_schema_fixture_NOT_HISTORICAL.jsonl` is a parser fixture only. Its values are illustrative and **must not** be used for business decisions, policy approval, or uplift reporting.

A real evaluation file must be an immutable, identifier-safe JSONL export from the authoritative dispatch decision log. Each line must contain `decision_id`, one allowlisted `domain`, `logged_action`, the actual selection `logged_propensity`, a normalized realized `reward` in `[-1, 1]`, and the candidate action set presented at the time of the decision.

The export must carry its source time range, schema version, retention approval, and a digest recorded in the audit system. It must not include direct customer, driver, vehicle, merchant, payment, safety, inventory, or lifecycle identifiers. The evaluator fails closed for non-allowlisted or financial/safety domains.

The evaluator requires `--audit-log` and `--evaluation-id`. The audit record is append-only JSONL with a SHA-256 predecessor chain; an evaluation result can only recommend a policy for shadow evaluation and remains subject to manual governance approval.

Example structural invocation, **not an uplift evaluation**:

```bash
python3 services/python/lakehouse/offline_rl_policy_evaluator.py \
  --input services/python/lakehouse/examples/offline_policy_log_schema_fixture_NOT_HISTORICAL.jsonl \
  --action-priority rank_nearest,rank_best_eta \
  --minimum-records 1000 \
  --minimum-uplift 0.01 \
  --audit-log /secure/audit/offline-policy.jsonl \
  --evaluation-id schema-fixture-only
```

This intentionally fails the minimum-sample gate and must not be reported as historical uplift evidence.
