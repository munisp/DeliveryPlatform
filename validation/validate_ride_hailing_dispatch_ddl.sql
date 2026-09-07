\set ON_ERROR_STOP on

CREATE TABLE public.users (
  id serial PRIMARY KEY,
  open_id varchar(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

\i /tmp/ride_hailing_dispatch_ddl.sql

SELECT COUNT(*) AS mobility_table_count
FROM information_schema.tables
WHERE table_schema = 'mobility' AND table_type = 'BASE TABLE';

SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'mobility'
ORDER BY routine_name;
