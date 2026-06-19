# SwitchOS Top 10 Production Scenarios and Workflow Validation

## Scenario Matrix

| # | Stakeholder | Scenario | Primary Platform Surfaces | Current Validation Path |
| --- | --- | --- | --- | --- |
| 1 | Operator admin | Authenticate into the control plane with a managed session or external OIDC token | Portal, Node edge, signed session handling | Covered by auth configuration and router access validation |
| 2 | Dispatch operator | Review live driver mobility pressure and dispatch readiness | Driver Mobility workspace, dispatch optimizer, analytics summary | Covered by protected workspace access and analytics workflow tests |
| 3 | Merchant operations | Review merchant channel operational status and channel health | Merchant Channels workspace, PostgreSQL-backed operator signals | Covered by protected merchant workspace tests |
| 4 | Recovery operator | Triage a service recovery queue and review incidents | Service Recovery workspace, persisted operator signals | Covered by protected service recovery tests |
| 5 | Call-center operator | Review phone-ordering workload and order-assist backlog | Phone Ordering workspace, PostgreSQL-backed operator signals | Covered by protected phone-ordering tests |
| 6 | Hospitality operations | Review tableside order readiness and venue execution | Tableside Commerce workspace | Covered by protected tableside workflow tests |
| 7 | White-label tenant operations | Review white-label rollout and tenant app posture | White-Label Apps workspace | Covered by protected white-label workflow tests |
| 8 | Analytics operator | Load lakehouse-backed analytics summaries and hotspot views | Lakehouse sync bridge, analytics router | Covered by primary analytics-path tests |
| 9 | Platform operator during degradation | Continue analytics access when lakehouse synchronization fails | Analytics router fallback path, workspace analytics | Covered by fallback-path tests |
| 10 | Platform security reviewer | Confirm unauthorized or viewer-only identities cannot access operator workflows | tRPC authorization layer, route protection | Covered by unauthorized and forbidden-access tests |

## Validation Notes

The current automated validation suite exercises ten representative scenario outcomes through the active router contracts. These validations confirm that operator access control is enforced, authenticated workflows can reach the connected workspaces, the analytics path prefers the lakehouse-backed route, and the platform falls back to persisted workspace analytics when synchronization fails.

This scenario suite is meaningful for the currently connected operator shell, but it does **not** yet prove full production-scale behavior for every claimed middleware component, every mobile surface, or every external dependency. Those remaining gaps must be reflected honestly in the final production-readiness score.
