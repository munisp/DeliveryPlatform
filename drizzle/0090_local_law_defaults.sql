-- Local-law contract defaults (R15).
-- Per-market contract jurisdiction rows pin the governing law and dispute
-- forum workers contract under. Defaults are Nigerian law and Lagos courts —
-- the transcript grievance was forum-shopping workers into Estonian
-- arbitration they could never realistically access. Publication is gated on
-- an activated (or SLA-elapsed) worker-council consultation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.contract_jurisdictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL UNIQUE,
  governing_law text NOT NULL DEFAULT 'Federal Republic of Nigeria',
  dispute_forum text NOT NULL DEFAULT 'Lagos, Nigeria courts',
  consumer_protection_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from timestamptz NOT NULL DEFAULT now(),
  published boolean NOT NULL DEFAULT false,
  consultation_id uuid REFERENCES public.consultation_objects(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_jurisdictions_published_idx
  ON public.contract_jurisdictions (published, market_id);
