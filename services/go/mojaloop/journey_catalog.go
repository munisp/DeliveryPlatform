package main

import (
	"fmt"
	"sort"
	"strings"
)

type JourneyVertical string

const (
	JourneyDelivery JourneyVertical = "delivery"
	JourneyRide     JourneyVertical = "ride_sharing"
	JourneyGig      JourneyVertical = "gig_workers"
)

type JourneyAction string

const (
	JourneyActionRidePresence             JourneyAction = "ride_presence"
	JourneyActionRideLocation             JourneyAction = "ride_location"
	JourneyActionRideMatch                JourneyAction = "ride_match"
	JourneyActionRideDecline              JourneyAction = "ride_decline"
	JourneyActionRideDisclosure           JourneyAction = "ride_disclosure"
	JourneyActionPricingRideQuote         JourneyAction = "pricing_ride_quote"
	JourneyActionPricingDeliveryQuote     JourneyAction = "pricing_delivery_quote"
	JourneyActionRouteOptimize            JourneyAction = "route_optimize"
	JourneyActionRoutePlan                JourneyAction = "route_plan"
	JourneyActionInventoryPosition        JourneyAction = "inventory_position"
	JourneyActionInventoryReplenish       JourneyAction = "inventory_replenish"
	JourneyActionInventoryReplenishCancel JourneyAction = "inventory_replenish_cancel"
	JourneyActionVerificationCheck        JourneyAction = "verification_eligibility"
	JourneyActionVerificationPolicy       JourneyAction = "verification_policy"
	JourneyActionPaymentReconcile         JourneyAction = "payment_reconcile"
	JourneyActionPayoutRelease            JourneyAction = "payout_release"
	JourneyActionPayoutReconcile          JourneyAction = "payout_reconcile"
	JourneyActionCommerceIngress          JourneyAction = "commerce_ingress"
)

type JourneyStep struct {
	Action       JourneyAction `json:"action"`
	InputKey     string        `json:"inputKey"`
	Required     bool          `json:"required"`
	Compensation JourneyAction `json:"compensation,omitempty"`
}

type JourneyDefinition struct {
	ID          string          `json:"id"`
	Vertical    JourneyVertical `json:"vertical"`
	Stakeholder string          `json:"stakeholder"`
	Title       string          `json:"title"`
	Steps       []JourneyStep   `json:"steps"`
}

func step(action JourneyAction) JourneyStep {
	return JourneyStep{Action: action, InputKey: string(action), Required: true}
}

func optional(action JourneyAction) JourneyStep {
	return JourneyStep{Action: action, InputKey: string(action), Required: false}
}

func stepWithCompensation(action JourneyAction, compensation JourneyAction) JourneyStep {
	return JourneyStep{Action: action, InputKey: string(action), Required: true, Compensation: compensation}
}

// JourneyCatalog is deliberately static: a requester can choose a journey and
// supply only its bounded action payloads, never an arbitrary workflow, queue,
// URL, HTTP method, or compensation destination.
func JourneyCatalog() []JourneyDefinition {
	catalog := []JourneyDefinition{
		// Delivery: customers, merchants, couriers, warehouse operators, and support.
		{"delivery.consumer_quote", JourneyDelivery, "consumer", "Quote a scheduled delivery", []JourneyStep{step(JourneyActionPricingDeliveryQuote), step(JourneyActionRouteOptimize)}},
		{"delivery.consumer_express_booking", JourneyDelivery, "consumer", "Book an express delivery", []JourneyStep{step(JourneyActionPricingDeliveryQuote), step(JourneyActionRouteOptimize), optional(JourneyActionInventoryPosition)}},
		{"delivery.consumer_multi_stop", JourneyDelivery, "consumer", "Coordinate a multi-stop delivery", []JourneyStep{step(JourneyActionRouteOptimize), step(JourneyActionRoutePlan)}},
		{"delivery.consumer_reschedule", JourneyDelivery, "consumer", "Replan a recipient reschedule", []JourneyStep{step(JourneyActionRouteOptimize), step(JourneyActionRoutePlan)}},
		{"delivery.consumer_address_correction", JourneyDelivery, "consumer", "Replan after an address correction", []JourneyStep{step(JourneyActionRouteOptimize), step(JourneyActionRoutePlan)}},
		{"delivery.consumer_return_pickup", JourneyDelivery, "consumer", "Plan a return collection", []JourneyStep{step(JourneyActionPricingDeliveryQuote), step(JourneyActionRoutePlan)}},
		{"delivery.consumer_tracking_check", JourneyDelivery, "consumer", "Check durable delivery tracking prerequisites", []JourneyStep{step(JourneyActionVerificationCheck), optional(JourneyActionRoutePlan)}},
		{"delivery.merchant_order_intake", JourneyDelivery, "merchant", "Validate merchant order intake and stock", []JourneyStep{step(JourneyActionInventoryPosition), step(JourneyActionPricingDeliveryQuote)}},
		{"delivery.merchant_inventory_reservation", JourneyDelivery, "merchant", "Project an inventory reservation snapshot", []JourneyStep{step(JourneyActionCommerceIngress), step(JourneyActionInventoryPosition)}},
		{"delivery.merchant_stockout", JourneyDelivery, "merchant", "Handle a stockout with replenishment planning", []JourneyStep{step(JourneyActionInventoryPosition), stepWithCompensation(JourneyActionInventoryReplenish, JourneyActionInventoryReplenishCancel)}},
		{"delivery.merchant_cold_chain", JourneyDelivery, "merchant", "Plan cold-chain delivery routing", []JourneyStep{step(JourneyActionInventoryPosition), step(JourneyActionRouteOptimize)}},
		{"delivery.warehouse_replenishment", JourneyDelivery, "warehouse_operator", "Request warehouse replenishment", []JourneyStep{stepWithCompensation(JourneyActionInventoryReplenish, JourneyActionInventoryReplenishCancel), step(JourneyActionRoutePlan)}},
		{"delivery.warehouse_inventory_reconciliation", JourneyDelivery, "warehouse_operator", "Reconcile inventory projection", []JourneyStep{step(JourneyActionCommerceIngress), step(JourneyActionInventoryPosition)}},
		{"delivery.courier_onboarding", JourneyDelivery, "courier", "Verify courier eligibility before dispatch", []JourneyStep{step(JourneyActionVerificationCheck), step(JourneyActionVerificationPolicy)}},
		{"delivery.courier_offer_disclosure", JourneyDelivery, "courier", "Present and review a courier offer", []JourneyStep{step(JourneyActionPricingDeliveryQuote), step(JourneyActionRideDisclosure)}},
		{"delivery.courier_offer_decline", JourneyDelivery, "courier", "Record a reason-coded delivery-offer decline", []JourneyStep{step(JourneyActionRideDecline), step(JourneyActionRouteOptimize)}},
		{"delivery.dispatch_bulk_route", JourneyDelivery, "dispatcher", "Optimize bulk delivery route allocation", []JourneyStep{step(JourneyActionRouteOptimize), step(JourneyActionRoutePlan)}},
		{"delivery.dispatch_capacity_check", JourneyDelivery, "dispatcher", "Verify courier eligibility and routing capacity", []JourneyStep{step(JourneyActionVerificationCheck), step(JourneyActionRouteOptimize)}},
		{"delivery.finance_settlement_reconcile", JourneyDelivery, "finance_operator", "Observe delivery settlement reconciliation", []JourneyStep{step(JourneyActionPaymentReconcile)}},
		{"delivery.support_exception_review", JourneyDelivery, "support_operator", "Review a delivery exception with route evidence", []JourneyStep{step(JourneyActionRoutePlan), optional(JourneyActionPaymentReconcile)}},

		// Ride sharing: riders, drivers, dispatch, safety, finance, and support.
		{"ride.rider_eligibility", JourneyRide, "rider", "Validate rider onboarding policy", []JourneyStep{step(JourneyActionVerificationPolicy)}},
		{"ride.driver_onboarding", JourneyRide, "driver", "Validate driver eligibility before availability", []JourneyStep{step(JourneyActionVerificationCheck), step(JourneyActionVerificationPolicy)}},
		{"ride.driver_presence", JourneyRide, "driver", "Publish consented driver availability", []JourneyStep{step(JourneyActionRidePresence)}},
		{"ride.driver_location_consent", JourneyRide, "driver", "Publish consented durable driver location", []JourneyStep{step(JourneyActionRideLocation)}},
		{"ride.rider_surge_quote", JourneyRide, "rider", "Generate a surge-aware rider quote", []JourneyStep{step(JourneyActionPricingRideQuote), step(JourneyActionRideDisclosure)}},
		{"ride.rider_booking_match", JourneyRide, "rider", "Attempt a rider-driver match", []JourneyStep{step(JourneyActionPricingRideQuote), step(JourneyActionRideMatch)}},
		{"ride.driver_offer_disclosure", JourneyRide, "driver", "Disclose driver offer economics before acceptance", []JourneyStep{step(JourneyActionRideDisclosure)}},
		{"ride.driver_reasoned_decline", JourneyRide, "driver", "Record a reason-coded offer decline", []JourneyStep{step(JourneyActionRideDecline)}},
		{"ride.dispatch_rematch", JourneyRide, "dispatcher", "Attempt safe rematch after a declined offer", []JourneyStep{step(JourneyActionRideDecline), step(JourneyActionRideMatch)}},
		{"ride.pickup_route_plan", JourneyRide, "driver", "Plan route for pickup", []JourneyStep{step(JourneyActionRouteOptimize), step(JourneyActionRoutePlan)}},
		{"ride.trip_live_location", JourneyRide, "driver", "Maintain consented location during a trip", []JourneyStep{step(JourneyActionRideLocation), optional(JourneyActionRoutePlan)}},
		{"ride.trip_completion_settlement", JourneyRide, "finance_operator", "Observe post-trip settlement reconciliation", []JourneyStep{step(JourneyActionPaymentReconcile)}},
		{"ride.driver_payout_release", JourneyRide, "finance_operator", "Review an approved driver payout before separately authorized release", []JourneyStep{step(JourneyActionPaymentReconcile)}},
		{"ride.rider_cancellation", JourneyRide, "rider", "Replan after a rider cancellation", []JourneyStep{step(JourneyActionRidePresence), step(JourneyActionRideMatch)}},
		{"ride.driver_cancellation", JourneyRide, "driver", "Reallocate after driver cancellation", []JourneyStep{step(JourneyActionRidePresence), step(JourneyActionRideMatch)}},
		{"ride.safety_hold", JourneyRide, "safety_operator", "Verify policy before a safety hold", []JourneyStep{step(JourneyActionVerificationPolicy), optional(JourneyActionRidePresence)}},
		{"ride.incident_support_review", JourneyRide, "support_operator", "Review incident evidence and route plan", []JourneyStep{step(JourneyActionRoutePlan), step(JourneyActionVerificationPolicy)}},
		{"ride.fraud_signal_review", JourneyRide, "risk_operator", "Evaluate driver/rider fraud policy", []JourneyStep{step(JourneyActionVerificationPolicy), optional(JourneyActionRideLocation)}},
		{"ride.city_supply_rebalance", JourneyRide, "operations_manager", "Optimize city supply coverage", []JourneyStep{step(JourneyActionRouteOptimize), step(JourneyActionRidePresence)}},
		{"ride.driver_recertification", JourneyRide, "driver", "Revalidate driver eligibility at recertification", []JourneyStep{step(JourneyActionVerificationCheck), step(JourneyActionVerificationPolicy)}},

		// Gig workers: worker, asset owner, customer, supervisor, compliance, and finance.
		{"gig.worker_onboarding", JourneyGig, "gig_worker", "Validate worker onboarding eligibility", []JourneyStep{step(JourneyActionVerificationCheck), step(JourneyActionVerificationPolicy)}},
		{"gig.worker_document_recertification", JourneyGig, "gig_worker", "Revalidate expiring worker documentation", []JourneyStep{step(JourneyActionVerificationCheck), step(JourneyActionVerificationPolicy)}},
		{"gig.worker_vehicle_qualification", JourneyGig, "gig_worker", "Validate vehicle and operator eligibility", []JourneyStep{step(JourneyActionVerificationPolicy), step(JourneyActionRidePresence)}},
		{"gig.worker_availability", JourneyGig, "gig_worker", "Publish worker availability", []JourneyStep{step(JourneyActionRidePresence)}},
		{"gig.worker_location_consent", JourneyGig, "gig_worker", "Publish consented worker location", []JourneyStep{step(JourneyActionRideLocation)}},
		{"gig.worker_job_offer", JourneyGig, "gig_worker", "Calculate and disclose a gig offer", []JourneyStep{step(JourneyActionPricingDeliveryQuote), step(JourneyActionRideDisclosure)}},
		{"gig.worker_job_decline", JourneyGig, "gig_worker", "Record a reason-coded gig-offer decline", []JourneyStep{step(JourneyActionRideDecline), step(JourneyActionRouteOptimize)}},
		{"gig.worker_job_acceptance", JourneyGig, "gig_worker", "Match an eligible worker to a job", []JourneyStep{step(JourneyActionRideMatch), step(JourneyActionRoutePlan)}},
		{"gig.worker_field_route", JourneyGig, "gig_worker", "Optimize route to a field assignment", []JourneyStep{step(JourneyActionRouteOptimize), step(JourneyActionRoutePlan)}},
		{"gig.worker_work_evidence", JourneyGig, "gig_worker", "Validate work-evidence policy", []JourneyStep{step(JourneyActionVerificationPolicy)}},
		{"gig.worker_asset_assignment", JourneyGig, "asset_operator", "Verify worker and asset assignment eligibility", []JourneyStep{step(JourneyActionVerificationCheck), step(JourneyActionVerificationPolicy)}},
		{"gig.worker_replacement_vehicle", JourneyGig, "asset_operator", "Revalidate replacement vehicle assignment", []JourneyStep{step(JourneyActionVerificationPolicy), step(JourneyActionRidePresence)}},
		{"gig.worker_safety_incident", JourneyGig, "safety_operator", "Place a policy-led safety review", []JourneyStep{step(JourneyActionVerificationPolicy), optional(JourneyActionRideLocation)}},
		{"gig.worker_compliance_expiry", JourneyGig, "compliance_operator", "Review expiring eligibility evidence", []JourneyStep{step(JourneyActionVerificationCheck), step(JourneyActionVerificationPolicy)}},
		{"gig.worker_payout_reconcile", JourneyGig, "finance_operator", "Observe worker settlement reconciliation", []JourneyStep{step(JourneyActionPaymentReconcile)}},
		{"gig.worker_payout_release", JourneyGig, "finance_operator", "Review an approved worker payout before separately authorized release", []JourneyStep{step(JourneyActionPaymentReconcile)}},
		{"gig.worker_dispute_review", JourneyGig, "support_operator", "Review a worker dispute with policy evidence", []JourneyStep{step(JourneyActionVerificationPolicy), optional(JourneyActionPaymentReconcile)}},
		{"gig.worker_customer_job_quote", JourneyGig, "customer", "Quote a gig-worker field-service job", []JourneyStep{step(JourneyActionPricingDeliveryQuote), step(JourneyActionRouteOptimize)}},
		{"gig.worker_dispatch_capacity", JourneyGig, "dispatcher", "Match available eligible workers", []JourneyStep{step(JourneyActionRidePresence), step(JourneyActionRideMatch)}},
		{"gig.worker_offboarding", JourneyGig, "compliance_operator", "Verify policy before worker offboarding", []JourneyStep{step(JourneyActionVerificationPolicy), optional(JourneyActionRidePresence)}},
	}
	return append([]JourneyDefinition(nil), catalog...)
}

func JourneyByID(id string) (JourneyDefinition, bool) {
	for _, journey := range JourneyCatalog() {
		if journey.ID == id {
			return journey, true
		}
	}
	return JourneyDefinition{}, false
}

func ValidateJourneyCatalog(catalog []JourneyDefinition) error {
	counts := map[JourneyVertical]int{}
	seen := map[string]struct{}{}
	for _, journey := range catalog {
		if strings.TrimSpace(journey.ID) == "" || strings.TrimSpace(journey.Stakeholder) == "" || strings.TrimSpace(journey.Title) == "" || len(journey.Steps) == 0 {
			return fmt.Errorf("journey contains required empty fields")
		}
		if _, exists := seen[journey.ID]; exists {
			return fmt.Errorf("duplicate journey ID %q", journey.ID)
		}
		seen[journey.ID] = struct{}{}
		counts[journey.Vertical]++
		for _, item := range journey.Steps {
			if strings.TrimSpace(string(item.Action)) == "" || strings.TrimSpace(item.InputKey) == "" {
				return fmt.Errorf("journey %q has an invalid step", journey.ID)
			}
			if item.Compensation != "" && strings.TrimSpace(string(item.Compensation)) == "" {
				return fmt.Errorf("journey %q has an invalid compensation action", journey.ID)
			}
		}
	}
	for _, vertical := range []JourneyVertical{JourneyDelivery, JourneyRide, JourneyGig} {
		if counts[vertical] != 20 {
			return fmt.Errorf("journey catalog has %d %s scenarios, expected 20", counts[vertical], vertical)
		}
	}
	return nil
}

func SortedJourneyCatalog() []JourneyDefinition {
	catalog := JourneyCatalog()
	sort.Slice(catalog, func(i, j int) bool { return catalog[i].ID < catalog[j].ID })
	return catalog
}
