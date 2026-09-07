cd /secure/reviewed/DeliveryPlatform
for migration in \
  drizzle/0044_field_service_operations.sql \
  drizzle/0045_developer_api_platform.sql \
  drizzle/0046_medusa_commerce_fulfillment.sql \
  drizzle/0047_field_service_proof_and_public_collection.sql \
  drizzle/0048_developer_webhook_delivery_leases.sql \
  drizzle/0049_developer_webhook_retry_jitter.sql \
  drizzle/0050_gig_worker_vehicle_access.sql \
  drizzle/0051_driver_dispatch_fairness.sql \
  drizzle/0052_driver_offer_economics.sql \
  drizzle/0053_stakeholder_verification_engine.sql \
  drizzle/0054_document_forensics_processor.sql; do
  psql "$DDL_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$migration"
done
