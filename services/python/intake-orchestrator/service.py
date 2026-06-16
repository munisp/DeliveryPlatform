from dataclasses import dataclass
from typing import Any


@dataclass
class IntakeRequest:
    vertical_name: str
    pickup_required: bool = True
    dropoff_required: bool = True
    item_count: int = 1
    special_handling: bool = False
    regulated_items: bool = False
    notes: str = ""


class IntakeOrchestratorService:
    def build(self, request: IntakeRequest) -> dict[str, Any]:
        vertical = request.vertical_name.lower()
        fields = [
            {"key": "pickup_window", "label": "Pickup window", "type": "datetime"},
            {"key": "dropoff_window", "label": "Drop-off window", "type": "datetime"},
            {"key": "special_instructions", "label": "Special instructions", "type": "textarea"},
        ]
        playbook = "standard_pickup_dropoff"
        routing_mode = "scheduled_dispatch"
        compliance_flags: list[str] = []
        batching_eligible = True
        substitution_policy = "not_applicable"
        verification_steps: list[str] = []
        merchant_actions: list[str] = [
            "Confirm order acceptance and prep timing.",
            "Publish handoff readiness to dispatch once the order reaches the pickup window.",
        ]
        customer_checkpoints: list[str] = [
            "Collect service address and availability window.",
            "Confirm live order status updates and support contact channel.",
        ]
        fulfillment_steps: list[str] = [
            "Capture order details.",
            "Schedule courier pickup.",
            "Deliver to final destination.",
        ]

        if any(term in vertical for term in ["laundry", "dry", "clean"]):
            playbook = "pickup_process_return"
            routing_mode = "scheduled_roundtrip_dispatch"
            batching_eligible = False
            fields = [
                {"key": "garment_count", "label": "Garment count", "type": "number"},
                {"key": "service_level", "label": "Service level", "type": "select", "options": ["wash_fold", "dry_clean", "press_only"]},
                {"key": "pickup_window", "label": "Pickup window", "type": "datetime"},
                {"key": "dropoff_window", "label": "Drop-off window", "type": "datetime"},
                {"key": "stain_treatment", "label": "Stain treatment", "type": "checkbox"},
            ]
            merchant_actions.extend([
                "Record garment counts and processing SLA before pickup.",
                "Update processing completion so return delivery can be auto-scheduled.",
            ])
            fulfillment_steps = [
                "Collect garments from customer.",
                "Route order into processing queue.",
                "Schedule cleaned-item return drop-off.",
            ]
        elif any(term in vertical for term in ["pharmacy", "health"]):
            playbook = "regulated_delivery"
            routing_mode = "identity_verified_dispatch"
            batching_eligible = False
            substitution_policy = "pharmacist_approval_required"
            compliance_flags.extend(["identity_check", "regulated_chain_of_custody", "age_or_prescription_verification"])
            verification_steps.extend([
                "Capture prescription or regulated-item order reference.",
                "Require courier identity verification at pickup and delivery.",
                "Store recipient confirmation before handoff completion.",
            ])
            fields = [
                {"key": "prescription_id", "label": "Prescription or order ID", "type": "text"},
                {"key": "pickup_window", "label": "Pickup window", "type": "datetime"},
                {"key": "dropoff_window", "label": "Drop-off window", "type": "datetime"},
                {"key": "contactless", "label": "Contactless preferred", "type": "checkbox"},
                {"key": "recipient_dob", "label": "Recipient date of birth", "type": "date"},
            ]
            customer_checkpoints.append("Capture recipient verification requirements before dispatch release.")
            fulfillment_steps = [
                "Validate prescription or regulated order reference.",
                "Dispatch an eligible courier with chain-of-custody controls.",
                "Confirm verified recipient handoff and proof of completion.",
            ]
        elif any(term in vertical for term in ["retail", "grocery"]):
            playbook = "basket_fulfillment"
            routing_mode = "same_day_batching"
            substitution_policy = "customer_configurable"
            fields = [
                {"key": "basket_size", "label": "Basket size", "type": "number"},
                {"key": "substitution_policy", "label": "Substitution policy", "type": "select", "options": ["allow", "contact_me", "none"]},
                {"key": "pickup_window", "label": "Pickup window", "type": "datetime"},
                {"key": "dropoff_window", "label": "Drop-off window", "type": "datetime"},
                {"key": "contact_for_substitutions", "label": "Contact for substitutions", "type": "checkbox"},
            ]
            merchant_actions.extend([
                "Expose out-of-stock events and substitution requests back to the customer channel.",
                "Signal batch-ready state when basket picking is complete.",
            ])
            customer_checkpoints.extend([
                "Capture substitution preference before checkout submission.",
                "Provide item-level revision alerts while basket picking is in progress.",
            ])
            fulfillment_steps = [
                "Receive and validate the basket.",
                "Pick and substitute items according to customer rules.",
                "Batch or directly dispatch the completed order for drop-off.",
            ]

        if request.special_handling:
            compliance_flags.append("special_handling")
            batching_eligible = False
            verification_steps.append("Mark the order for special handling and exclude it from mixed batches.")
        if request.regulated_items:
            compliance_flags.append("regulated_items")
            batching_eligible = False
            if "age_or_prescription_verification" not in compliance_flags:
                verification_steps.append("Collect regulated-item handling requirements before dispatch.")

        readiness = 0.72
        if request.item_count > 10:
            readiness += 0.08
        if request.item_count > 25:
            readiness -= 0.03
        if request.special_handling:
            readiness -= 0.04
        if request.regulated_items:
            readiness -= 0.05
        if not request.pickup_required:
            readiness += 0.03

        return {
            "vertical_name": request.vertical_name,
            "playbook": playbook,
            "routing_mode": routing_mode,
            "fields": fields,
            "pickup_required": request.pickup_required,
            "dropoff_required": request.dropoff_required,
            "compliance_flags": sorted(set(compliance_flags)),
            "verification_steps": verification_steps,
            "merchant_actions": merchant_actions,
            "customer_checkpoints": customer_checkpoints,
            "fulfillment_steps": fulfillment_steps,
            "batching_eligible": batching_eligible,
            "substitution_policy": substitution_policy,
            "readiness_score": round(max(0.45, min(readiness, 0.97)), 2),
            "notes": request.notes,
            "summary": "The intake template now normalizes customer capture, merchant preparation, compliance, substitution handling, and dispatch readiness for multi-vertical fulfillment.",
        }
