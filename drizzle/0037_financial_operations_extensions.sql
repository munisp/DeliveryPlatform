-- Independently designed financial operations extensions; all amounts are integer minor units.
CREATE SCHEMA IF NOT EXISTS billing;
CREATE TYPE billing.invoice_state AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'void', 'overdue');
CREATE TYPE billing.dispute_state AS ENUM ('opened', 'under_review', 'resolved_customer', 'resolved_operator', 'rejected', 'closed');
CREATE TYPE billing.report_state AS ENUM ('queued', 'generated', 'expired', 'failed');

CREATE TABLE billing.invoice (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  invoice_number TEXT NOT NULL CHECK (invoice_number ~ '^[A-Z0-9][A-Z0-9-]{3,62}$'),
  customer_reference TEXT NOT NULL CHECK (length(customer_reference) BETWEEN 1 AND 160),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state billing.invoice_state NOT NULL DEFAULT 'draft',
  subtotal_minor BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor BIGINT NOT NULL CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL CHECK (total_minor >= 0 AND total_minor = subtotal_minor + tax_minor),
  issued_at TIMESTAMPTZ NULL,
  due_at TIMESTAMPTZ NULL,
  paid_at TIMESTAMPTZ NULL,
  created_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, invoice_number),
  CHECK (due_at IS NULL OR state = 'draft' OR issued_at IS NOT NULL),
  CHECK ((state IN ('issued','partially_paid','paid','overdue')) = (issued_at IS NOT NULL))
);
CREATE INDEX invoice_tenant_state_due_idx ON billing.invoice (tenant_id, state, due_at, created_at DESC);

CREATE TABLE billing.invoice_line (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES billing.invoice(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0 AND line_no <= 1000),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  unit_amount_minor BIGINT NOT NULL CHECK (unit_amount_minor >= 0),
  line_amount_minor BIGINT NOT NULL CHECK (line_amount_minor = quantity * unit_amount_minor),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (invoice_id, line_no),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE billing.payment_dispute (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  invoice_id UUID NULL REFERENCES billing.invoice(id) ON DELETE RESTRICT,
  payment_reference TEXT NOT NULL CHECK (length(payment_reference) BETWEEN 8 AND 160),
  dispute_type TEXT NOT NULL CHECK (dispute_type ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state billing.dispute_state NOT NULL DEFAULT 'opened',
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 8 AND 2000),
  outcome_note TEXT NULL CHECK (outcome_note IS NULL OR length(outcome_note) BETWEEN 8 AND 2000),
  opened_by INTEGER NOT NULL,
  resolved_by INTEGER NULL,
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, payment_reference, dispute_type),
  CHECK ((state IN ('resolved_customer','resolved_operator','rejected','closed')) = (resolved_at IS NOT NULL))
);
CREATE INDEX payment_dispute_tenant_state_idx ON billing.payment_dispute (tenant_id, state, created_at DESC);

CREATE TABLE billing.dispute_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES billing.payment_dispute(id) ON DELETE CASCADE,
  evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) BETWEEN 16 AND 512),
  evidence_digest BYTEA NOT NULL CHECK (octet_length(evidence_digest)=32),
  submitted_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dispute_id, evidence_ref)
);

CREATE TABLE billing.governed_report_export (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  report_kind TEXT NOT NULL CHECK (report_kind IN ('invoice_aging','dispute_register','operations_sla')),
  state billing.report_state NOT NULL DEFAULT 'queued',
  requested_by INTEGER NOT NULL,
  filter_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_ref TEXT NULL CHECK (result_ref IS NULL OR length(result_ref) BETWEEN 16 AND 512),
  result_payload JSONB NULL,
  freshness_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  error_code TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(filter_spec)='object'),
  CHECK (result_payload IS NULL OR jsonb_typeof(result_payload)='object')
);
CREATE INDEX governed_report_due_idx ON billing.governed_report_export (state, created_at) WHERE state='queued';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='switchos_service') THEN
    GRANT USAGE ON SCHEMA billing TO switchos_service;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA billing TO switchos_service;
  END IF;
END;
$$;
