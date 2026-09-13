-- Vertical compliance packs: machine-readable regulatory requirement
-- descriptors per service vertical and jurisdiction.
--
-- required_documents and handling_requirements are jsonb arrays of typed
-- requirement descriptors (never prose-only) so consoles, onboarding, and
-- courier/dispatch flows can enforce them programmatically:
--
--   required_documents:    [{ code, label, issuer, verification, renewal, retention_days }]
--   handling_requirements: [{ code, label, enforcement, parameters }]
--   age_restriction:       { minimum_age, verification, scope, jurisdictional_basis } | null
--
-- Seed rows are idempotent (INSERT ... SELECT ... WHERE NOT EXISTS) and link
-- to service_verticals by slug when a matching vertical exists; vertical_id
-- stays NULL when the vertical row has not been provisioned yet.

BEGIN;

CREATE TABLE IF NOT EXISTS public.vertical_compliance_packs (
  id SERIAL PRIMARY KEY,
  vertical_id INTEGER REFERENCES public.service_verticals(id) ON DELETE SET NULL,
  vertical_slug VARCHAR(100) NOT NULL,
  jurisdiction VARCHAR(160) NOT NULL,
  required_documents JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(required_documents) = 'array'),
  age_restriction JSONB
    CHECK (age_restriction IS NULL OR jsonb_typeof(age_restriction) = 'object'),
  handling_requirements JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(handling_requirements) = 'array'),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vertical_compliance_packs_slug_jurisdiction_unique
    UNIQUE (vertical_slug, jurisdiction)
);

CREATE INDEX IF NOT EXISTS idx_vertical_compliance_packs_vertical
  ON public.vertical_compliance_packs (vertical_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_vertical_compliance_packs_slug
  ON public.vertical_compliance_packs (vertical_slug) WHERE active;

COMMENT ON TABLE public.vertical_compliance_packs IS
  'Machine-readable compliance requirement packs per service vertical and jurisdiction; required_documents/handling_requirements are jsonb descriptor arrays enforced by onboarding and delivery flows.';

-- Pharmacy (US federal baseline: FDA + DEA + state boards of pharmacy)
INSERT INTO public.vertical_compliance_packs
  (vertical_id, vertical_slug, jurisdiction, required_documents, age_restriction, handling_requirements, active)
SELECT
  v.id,
  'pharmacy',
  'US federal baseline (FDA/DEA + state board of pharmacy)',
  '[
    {"code":"prescription_verification","label":"Prescription verification","issuer":"licensed_prescriber","verification":"pharmacist_review_of_rx_number_and_prescriber_npi","renewal":"per_fill","retention_days":730},
    {"code":"pharmacist_license","label":"Licensed pharmacist on duty","issuer":"state_board_of_pharmacy","verification":"license_number_lookup","renewal":"per_state_cycle","retention_days":2555},
    {"code":"controlled_substance_log","label":"Controlled-substance dispensing log (DEA Schedules II-V)","issuer":"dea","verification":"dea_form_222_or_csos_record","renewal":"continuous","retention_days":730},
    {"code":"pharmacy_establishment_license","label":"Pharmacy establishment license","issuer":"state_board_of_pharmacy","verification":"license_number_lookup","renewal":"annual","retention_days":2555}
  ]'::jsonb,
  NULL,
  '[
    {"code":"tamper_evident_packaging","label":"Tamper-evident packaging for all dispensed medication","enforcement":"packaging_check_at_pickup","parameters":{"seal_type":"tamper_evident"}},
    {"code":"cold_chain_temperature_log","label":"Temperature log for refrigerated medication","enforcement":"continuous_sensor_log_with_handoff_reading","parameters":{"min_celsius":2,"max_celsius":8,"excursion_alert":true}},
    {"code":"recipient_signature","label":"Signature on delivery for prescription orders","enforcement":"signature_capture_at_dropoff","parameters":{"allow_unattended_dropoff":false}},
    {"code":"controlled_substance_handoff","label":"Controlled substances handed only to verified patient or authorized agent","enforcement":"id_match_at_delivery","parameters":{"id_match_required":true,"allow_authorized_agent":true}}
  ]'::jsonb,
  true
FROM (SELECT 1) AS seed
LEFT JOIN public.service_verticals v ON v.slug = 'pharmacy'
WHERE NOT EXISTS (
  SELECT 1 FROM public.vertical_compliance_packs p
  WHERE p.vertical_slug = 'pharmacy'
    AND p.jurisdiction = 'US federal baseline (FDA/DEA + state board of pharmacy)'
);

-- Alcohol (US baseline: state ABC licensing + 21+ federal drinking age)
INSERT INTO public.vertical_compliance_packs
  (vertical_id, vertical_slug, jurisdiction, required_documents, age_restriction, handling_requirements, active)
SELECT
  v.id,
  'alcohol',
  'US baseline (state ABC + local jurisdiction)',
  '[
    {"code":"liquor_license","label":"Retail liquor license","issuer":"state_alcoholic_beverage_control_board","verification":"license_number_lookup","renewal":"annual","retention_days":1825},
    {"code":"alcohol_delivery_permit","label":"Off-premises alcohol delivery permit","issuer":"state_or_local_abc_authority","verification":"permit_number_lookup","renewal":"annual","retention_days":1825},
    {"code":"seller_server_certification","label":"Responsible beverage seller/server certification","issuer":"state_approved_training_program","verification":"certificate_number_lookup","renewal":"every_2_to_3_years","retention_days":1095},
    {"code":"id_scan_record","label":"ID scan record per alcohol delivery","issuer":"platform_courier_app","verification":"id_scan_plus_age_computation","renewal":"per_delivery","retention_days":1095}
  ]'::jsonb,
  '{"minimum_age":21,"verification":"id_scan_at_delivery","scope":"recipient","jurisdictional_basis":"US National Minimum Drinking Age Act; stricter local rules take precedence"}'::jsonb,
  '[
    {"code":"adult_signature_required","label":"Adult (21+) signature captured at delivery","enforcement":"signature_capture_at_dropoff","parameters":{"allow_unattended_dropoff":false,"allow_mailbox_delivery":false}},
    {"code":"sobriety_assessment","label":"No delivery to visibly intoxicated recipients","enforcement":"courier_refusal_workflow","parameters":{"refund_on_refusal":true,"return_to_sender":true}},
    {"code":"sealed_container","label":"Alcohol delivered in original sealed container","enforcement":"packaging_check_at_pickup","parameters":{"open_container_prohibited":true}},
    {"code":"dry_jurisdiction_block","label":"Delivery blocked in dry jurisdictions and during restricted hours","enforcement":"geofence_and_time_window_check","parameters":{"check_at":["order_placement","dispatch","delivery"]}}
  ]'::jsonb,
  true
FROM (SELECT 1) AS seed
LEFT JOIN public.service_verticals v ON v.slug = 'alcohol'
WHERE NOT EXISTS (
  SELECT 1 FROM public.vertical_compliance_packs p
  WHERE p.vertical_slug = 'alcohol'
    AND p.jurisdiction = 'US baseline (state ABC + local jurisdiction)'
);

-- Healthcare (US baseline: HIPAA-style handling + patient consent)
INSERT INTO public.vertical_compliance_packs
  (vertical_id, vertical_slug, jurisdiction, required_documents, age_restriction, handling_requirements, active)
SELECT
  v.id,
  'healthcare',
  'US baseline (HIPAA/HITECH + state health privacy law)',
  '[
    {"code":"patient_consent_record","label":"Patient consent for transport/delivery coordination","issuer":"patient_or_legal_guardian","verification":"signed_consent_on_file","renewal":"per_episode_of_care","retention_days":2190},
    {"code":"business_associate_agreement","label":"Business associate agreement (BAA) with covered entity","issuer":"covered_entity_and_platform","verification":"executed_baa_on_file","renewal":"per_contract","retention_days":2555},
    {"code":"phi_access_authorization","label":"Minimum-necessary PHI access authorization per workforce role","issuer":"platform_privacy_officer","verification":"role_scoped_access_grant","renewal":"annual","retention_days":2190},
    {"code":"courier_hipaa_training","label":"Courier HIPAA awareness training certificate","issuer":"platform_compliance_training","verification":"training_completion_record","renewal":"annual","retention_days":1095}
  ]'::jsonb,
  NULL,
  '[
    {"code":"minimum_necessary_phi","label":"Couriers see only minimum-necessary patient information","enforcement":"field_level_data_masking","parameters":{"masked_fields":["diagnosis","treatment_notes","full_medical_record"]}},
    {"code":"encrypted_phi_transit","label":"PHI encrypted in transit and at rest","enforcement":"platform_encryption_policy","parameters":{"tls_min_version":"1.2","at_rest":"aes_256"}},
    {"code":"chain_of_custody","label":"Chain-of-custody log for specimens and medical supplies","enforcement":"scan_events_at_each_handoff","parameters":{"custody_events":["pickup","in_transit","delivery"],"signature_required":true}},
    {"code":"breach_incident_reporting","label":"PHI breach or loss reported within 24 hours","enforcement":"incident_workflow","parameters":{"notify":["privacy_officer","covered_entity"],"sla_hours":24}}
  ]'::jsonb,
  true
FROM (SELECT 1) AS seed
LEFT JOIN public.service_verticals v ON v.slug = 'healthcare'
WHERE NOT EXISTS (
  SELECT 1 FROM public.vertical_compliance_packs p
  WHERE p.vertical_slug = 'healthcare'
    AND p.jurisdiction = 'US baseline (HIPAA/HITECH + state health privacy law)'
);

-- Grocery (US baseline: FDA Food Code + FSMA + local health department)
INSERT INTO public.vertical_compliance_packs
  (vertical_id, vertical_slug, jurisdiction, required_documents, age_restriction, handling_requirements, active)
SELECT
  v.id,
  'grocery',
  'US baseline (FDA Food Code/FSMA + local health department)',
  '[
    {"code":"food_establishment_permit","label":"Food establishment permit","issuer":"local_health_department","verification":"permit_number_lookup","renewal":"annual","retention_days":1825},
    {"code":"food_protection_manager_cert","label":"Certified food protection manager on staff","issuer":"ansi_accredited_program","verification":"certificate_number_lookup","renewal":"every_5_years","retention_days":2190},
    {"code":"temperature_log","label":"Cold-chain temperature log for perishable deliveries","issuer":"platform_courier_app","verification":"sensor_or_manual_log_at_pickup_and_handoff","renewal":"per_delivery","retention_days":365},
    {"code":"recall_traceability_record","label":"Lot/recall traceability record for recalled items","issuer":"merchant_catalog","verification":"lot_code_capture","renewal":"per_batch","retention_days":730}
  ]'::jsonb,
  NULL,
  '[
    {"code":"cold_chain_compliance","label":"Perishables held at safe temperatures in insulated transport","enforcement":"temperature_check_at_pickup_and_handoff","parameters":{"cold_max_celsius":4,"frozen_max_celsius":-18,"insulated_container_required":true}},
    {"code":"expiry_fefo_handling","label":"First-expired-first-out picking and no expired-item delivery","enforcement":"picking_workflow_check","parameters":{"block_expired_items":true,"min_shelf_life_hours_at_delivery":24}},
    {"code":"cross_contamination_separation","label":"Raw meat, allergens, and chemicals bagged separately","enforcement":"packaging_check_at_pickup","parameters":{"separate_bags":["raw_meat_poultry_seafood","allergen_flagged","household_chemicals"]}},
    {"code":"recall_item_block","label":"Recalled lots blocked from sale and delivery","enforcement":"catalog_lot_block","parameters":{"block_window":"until_recall_cleared"}}
  ]'::jsonb,
  true
FROM (SELECT 1) AS seed
LEFT JOIN public.service_verticals v ON v.slug = 'grocery'
WHERE NOT EXISTS (
  SELECT 1 FROM public.vertical_compliance_packs p
  WHERE p.vertical_slug = 'grocery'
    AND p.jurisdiction = 'US baseline (FDA Food Code/FSMA + local health department)'
);

COMMIT;
