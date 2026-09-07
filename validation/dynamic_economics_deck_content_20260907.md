# Win/Win Driver-Platform Economic Methodology

## Slide 1: Title
- **Title:** Win/Win Driver-Platform Economic Methodology
- **Subtitle:** Dynamic Pricing Framework and Equilibrium Model

## Slide 2: The Core Conflict
- **Focus:** Why static commissions fail.
- **Content:**
  - Opaque, fixed percentage commissions ignore driver operating costs (fuel, maintenance, time).
  - Drivers are forced to subsidize uneconomic pickups by declining or accepting at a loss.
  - Platforms struggle to maintain margins while offering unpredictable rider discounts.
- **Solution:** A dynamic equilibrium that treats the platform fee as a residual, not an entitlement.

## Slide 3: Dynamic Commission Calculation Flow
- **Focus:** The step-by-step math.
- **Content:** Show the rendered flowchart (`dynamic_commission_flow.png`).

## Slide 4: Win/Win Equilibrium State Machine
- **Focus:** The fail-closed decision boundary.
- **Content:** Show the rendered state machine (`dynamic_economics_state_machine.png`).

## Slide 5: The Two Hard Floors
- **Focus:** The non-negotiable boundaries.
- **Driver Floor (`D_min`):** Expected proceeds must cover published active-time, distance, and indexed fuel/maintenance costs.
- **Platform Floor (`P_target`):** Contribution after driver proceeds, explicit subsidy, and verified variable cost must be positive.
- **Guardrail:** The commission cap (e.g., 15.00%) remains a hard ceiling.

## Slide 6: Real-Time Inputs vs. Governed Policy
- **Focus:** What changes when.
- **Real-time (Per Quote):** Route distance, ETA, and gross fare.
- **Governed (Weekly/Monthly):** Fuel cost index, maintenance index, variable platform cost, and contribution target.
- **Why:** Prevents real-time "surge pricing" from silently cutting driver share or hiding opaque penalties.

## Slide 7: Implementation and Evidence Boundary
- **Focus:** What is built vs. what is required.
- **Implemented Locally:** Authoritative PostgreSQL schema (`0052`), bounded API routes, and isolated database validation.
- **Not Production Evidence:** Real fuel data feeds, regulatory approval, live payment reconciliation, and market viability.
