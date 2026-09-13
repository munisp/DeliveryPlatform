CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP SCHEMA IF EXISTS commerce CASCADE;
DROP SCHEMA IF EXISTS operations CASCADE;
DROP TABLE IF EXISTS public.delivery_tracking_events, public.orders, public.drivers, public.service_providers, public.users CASCADE;

CREATE SCHEMA commerce;
CREATE SCHEMA operations;

CREATE TABLE public.users (
  id integer PRIMARY KEY,
  role text NOT NULL,
  open_id text UNIQUE
);
CREATE TABLE public.service_providers (id integer PRIMARY KEY);
CREATE TABLE public.drivers (id integer PRIMARY KEY, open_id text NOT NULL);
CREATE TABLE public.orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES public.users(id),
  provider_id integer REFERENCES public.service_providers(id),
  driver_id integer REFERENCES public.drivers(id)
);
CREATE TABLE public.delivery_tracking_events (
  id bigserial PRIMARY KEY,
  delivery_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  latitude numeric NOT NULL,
  longitude numeric NOT NULL,
  accuracy_meters numeric
);
CREATE TABLE commerce.merchant_portal (provider_id integer PRIMARY KEY);
CREATE TYPE commerce.merchant_access_role AS ENUM ('owner','catalog_manager','inventory_manager');
CREATE TABLE commerce.merchant_user_access (
  provider_id integer NOT NULL,
  user_id integer NOT NULL,
  active boolean NOT NULL,
  role commerce.merchant_access_role NOT NULL
);

INSERT INTO public.users(id,role,open_id) VALUES
  (1,'admin','admin-open-id'),
  (2,'customer','customer-open-id'),
  (3,'merchant','merchant-open-id'),
  (4,'driver','driver-open-id'),
  (5,'viewer','viewer-open-id');
INSERT INTO public.service_providers(id) VALUES (10);
INSERT INTO public.drivers(id,open_id) VALUES (30,'driver-open-id');
INSERT INTO public.orders(id,customer_id,provider_id,driver_id) VALUES (100,2,10,30);
INSERT INTO commerce.merchant_portal(provider_id) VALUES (10);
INSERT INTO commerce.merchant_user_access(provider_id,user_id,active,role) VALUES (10,3,true,'owner');
