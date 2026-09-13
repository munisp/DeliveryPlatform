-- DeliveryPlatform analytical Lakehouse contracts, version 1.
-- Target engine: Apache Iceberg 1.x with an ANSI-SQL capable catalog (for
-- example, Nessie, JDBC, or REST catalog) and S3-compatible object storage.
-- These tables are NON-AUTHORITATIVE analytical projections. PostgreSQL,
-- TigerBeetle, and Medusa remain the source systems of record.
--
-- Every producer must publish a post-commit envelope with a stable event_id,
-- source_event_time, emitted_at, schema_version, consent_status, and
-- redaction_profile. The ingestion service must deduplicate on event_id in its
-- delivery ledger before appending to these immutable bronze tables.

CREATE NAMESPACE IF NOT EXISTS lakehouse.bronze;
CREATE NAMESPACE IF NOT EXISTS lakehouse.silver;
CREATE NAMESPACE IF NOT EXISTS lakehouse.governance;

CREATE TABLE IF NOT EXISTS lakehouse.bronze.vehicle_tracker_event_v1 (
  event_id STRING NOT NULL,
  source_event_id_hash STRING NOT NULL,
  source_system STRING NOT NULL,
  provider_kind STRING NOT NULL,
  integration_key STRING NOT NULL,
  tracker_token STRING NOT NULL,
  asset_token STRING,
  rental_token STRING,
  event_type STRING NOT NULL,
  source_event_time TIMESTAMP NOT NULL,
  ingested_at TIMESTAMP NOT NULL,
  event_date DATE NOT NULL,
  latitude_bucket_3dp DECIMAL(6,3),
  longitude_bucket_3dp DECIMAL(6,3),
  speed_kph DECIMAL(8,3),
  heading_degrees DECIMAL(6,2),
  ignition_state STRING,
  geofence_token STRING,
  geofence_outcome STRING,
  signal_digest_sha256 STRING NOT NULL,
  schema_version INT NOT NULL,
  consent_status STRING NOT NULL,
  redaction_profile STRING NOT NULL,
  payload_json STRING,
  emitted_at TIMESTAMP NOT NULL
)
USING iceberg
PARTITIONED BY (days(source_event_time), bucket(32, provider_kind))
TBLPROPERTIES (
  'format-version'='2',
  'write.format.default'='parquet',
  'write.parquet.compression-codec'='zstd',
  'write.target-file-size-bytes'='536870912',
  'commit.manifest.target-size-bytes'='8388608'
);

CREATE TABLE IF NOT EXISTS lakehouse.bronze.tigerbeetle_settlement_event_v1 (
  event_id STRING NOT NULL,
  source_system STRING NOT NULL,
  workflow_token STRING NOT NULL,
  outbox_token STRING NOT NULL,
  debit_fsp_token STRING NOT NULL,
  credit_fsp_token STRING,
  event_type STRING NOT NULL,
  settlement_state STRING NOT NULL,
  source_event_time TIMESTAMP NOT NULL,
  ingested_at TIMESTAMP NOT NULL,
  event_date DATE NOT NULL,
  amount_minor BIGINT,
  currency_code STRING,
  attempt_count INT NOT NULL,
  claim_epoch BIGINT,
  reconciliation_consistent BOOLEAN,
  reconciliation_digest_sha256 STRING,
  schema_version INT NOT NULL,
  redaction_profile STRING NOT NULL,
  emitted_at TIMESTAMP NOT NULL
)
USING iceberg
PARTITIONED BY (days(source_event_time), bucket(32, debit_fsp_token))
TBLPROPERTIES (
  'format-version'='2',
  'write.format.default'='parquet',
  'write.parquet.compression-codec'='zstd',
  'write.target-file-size-bytes'='268435456'
);

CREATE TABLE IF NOT EXISTS lakehouse.bronze.medusa_inventory_event_v1 (
  event_id STRING NOT NULL,
  source_event_key_hash STRING NOT NULL,
  source_system STRING NOT NULL,
  store_token STRING NOT NULL,
  location_token STRING NOT NULL,
  inventory_item_token STRING NOT NULL,
  reservation_token STRING,
  event_type STRING NOT NULL,
  source_event_time TIMESTAMP NOT NULL,
  ingested_at TIMESTAMP NOT NULL,
  event_date DATE NOT NULL,
  quantity DECIMAL(18,6),
  reservation_state STRING,
  delivery_state STRING NOT NULL,
  attempt_count INT NOT NULL,
  claim_epoch BIGINT,
  payload_digest_sha256 STRING NOT NULL,
  schema_version INT NOT NULL,
  redaction_profile STRING NOT NULL,
  emitted_at TIMESTAMP NOT NULL
)
USING iceberg
PARTITIONED BY (days(source_event_time), bucket(32, store_token))
TBLPROPERTIES (
  'format-version'='2',
  'write.format.default'='parquet',
  'write.parquet.compression-codec'='zstd',
  'write.target-file-size-bytes'='268435456'
);

CREATE TABLE IF NOT EXISTS lakehouse.silver.mobility_training_features_v1 (
  feature_row_id STRING NOT NULL,
  feature_set_version STRING NOT NULL,
  subject_token STRING NOT NULL,
  source_window_start TIMESTAMP NOT NULL,
  source_window_end TIMESTAMP NOT NULL,
  event_date DATE NOT NULL,
  label_available_at TIMESTAMP,
  geofence_breach_count_24h INT,
  stationary_ratio_1h DOUBLE,
  speed_p95_kph_24h DOUBLE,
  tracker_signal_gap_p95_seconds DOUBLE,
  inventory_reservation_lag_p95_seconds DOUBLE,
  settlement_exception_count_30d INT,
  eligible_label INT,
  source_snapshot_ref STRING NOT NULL,
  source_event_watermark TIMESTAMP NOT NULL,
  consent_status STRING NOT NULL,
  feature_policy_version STRING NOT NULL,
  created_at TIMESTAMP NOT NULL
)
USING iceberg
PARTITIONED BY (days(event_date), bucket(64, feature_set_version))
TBLPROPERTIES (
  'format-version'='2',
  'write.format.default'='parquet',
  'write.parquet.compression-codec'='zstd',
  'write.target-file-size-bytes'='536870912'
);

CREATE TABLE IF NOT EXISTS lakehouse.governance.ml_training_run_v1 (
  run_id STRING NOT NULL,
  model_name STRING NOT NULL,
  model_version STRING NOT NULL,
  feature_set_version STRING NOT NULL,
  source_snapshot_ref STRING NOT NULL,
  source_event_watermark TIMESTAMP NOT NULL,
  redaction_profile STRING NOT NULL,
  feature_policy_version STRING NOT NULL,
  code_digest_sha256 STRING NOT NULL,
  container_digest STRING NOT NULL,
  training_started_at TIMESTAMP NOT NULL,
  training_finished_at TIMESTAMP,
  run_state STRING NOT NULL,
  metrics_json STRING,
  checkpoint_uri STRING,
  approver_token STRING,
  created_at TIMESTAMP NOT NULL
)
USING iceberg
PARTITIONED BY (days(training_started_at), bucket(32, model_name))
TBLPROPERTIES (
  'format-version'='2',
  'write.format.default'='parquet',
  'write.parquet.compression-codec'='zstd'
);
