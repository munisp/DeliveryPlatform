-- Rollback for 0104_consumer_commerce_core.sql: drop the consumer commerce
-- function and tables. IF EXISTS drops only; no REVOKEs (0104 grants none).

DROP FUNCTION IF EXISTS public.consumer_checkout(integer, uuid, text, text, double precision, double precision, text, bigint, bigint);

DROP TABLE IF EXISTS public.consumer_group_order_participants;
DROP TABLE IF EXISTS public.consumer_group_orders;
DROP TABLE IF EXISTS public.consumer_subscriptions;
DROP TABLE IF EXISTS public.consumer_checkout_sessions;
DROP TABLE IF EXISTS public.consumer_cart_items;
DROP TABLE IF EXISTS public.consumer_carts;
