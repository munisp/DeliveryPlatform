-- SwitchOS Lakehouse Analytics Views
-- These Spark SQL views provide real-time analytics for dashboards
-- Data source: Delta Lake tables populated by Kafka event streams

-- ==================================================================
-- ORDER METRICS VIEWS
-- ==================================================================

-- Order completion rate by hour
CREATE OR REPLACE VIEW order_completion_rate_hourly AS
SELECT 
    DATE_TRUNC('hour', created_at) as hour,
    COUNT(*) as total_orders,
    SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as completed_orders,
    ROUND(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as completion_rate_pct,
    AVG(CASE WHEN actual_delivery_time IS NOT NULL 
        THEN UNIX_TIMESTAMP(actual_delivery_time) - UNIX_TIMESTAMP(created_at) 
        END) / 60 as avg_delivery_time_minutes
FROM delta.`/data/lakehouse/orders`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAYS
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- Order status distribution
CREATE OR REPLACE VIEW order_status_distribution AS
SELECT 
    status,
    COUNT(*) as order_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage,
    AVG(total_amount) as avg_order_value,
    SUM(total_amount) as total_revenue
FROM delta.`/data/lakehouse/orders`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 30 DAYS
GROUP BY status
ORDER BY order_count DESC;

-- Peak order hours
CREATE OR REPLACE VIEW peak_order_hours AS
SELECT 
    HOUR(created_at) as hour_of_day,
    COUNT(*) as order_count,
    AVG(total_amount) as avg_order_value,
    PERCENTILE_APPROX(total_amount, 0.5) as median_order_value
FROM delta.`/data/lakehouse/orders`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 30 DAYS
GROUP BY HOUR(created_at)
ORDER BY order_count DESC;

-- Order funnel analysis
CREATE OR REPLACE VIEW order_funnel AS
SELECT 
    'Created' as stage,
    COUNT(*) as count,
    1 as stage_order
FROM delta.`/data/lakehouse/orders`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 1 DAY
UNION ALL
SELECT 
    'Assigned' as stage,
    COUNT(*) as count,
    2 as stage_order
FROM delta.`/data/lakehouse/orders`
WHERE driver_id IS NOT NULL
    AND created_at >= CURRENT_TIMESTAMP - INTERVAL 1 DAY
UNION ALL
SELECT 
    'Picked Up' as stage,
    COUNT(*) as count,
    3 as stage_order
FROM delta.`/data/lakehouse/orders`
WHERE actual_pickup_time IS NOT NULL
    AND created_at >= CURRENT_TIMESTAMP - INTERVAL 1 DAY
UNION ALL
SELECT 
    'Delivered' as stage,
    COUNT(*) as count,
    4 as stage_order
FROM delta.`/data/lakehouse/orders`
WHERE status = 'delivered'
    AND created_at >= CURRENT_TIMESTAMP - INTERVAL 1 DAY
ORDER BY stage_order;

-- ==================================================================
-- DRIVER UTILIZATION VIEWS
-- ==================================================================

-- Driver performance metrics
CREATE OR REPLACE VIEW driver_performance AS
SELECT 
    d.id as driver_id,
    d.name as driver_name,
    d.vehicle_type,
    COUNT(o.id) as total_deliveries,
    SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) as completed_deliveries,
    ROUND(SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) * 100.0 / COUNT(o.id), 2) as completion_rate_pct,
    AVG(CASE WHEN o.actual_delivery_time IS NOT NULL 
        THEN UNIX_TIMESTAMP(o.actual_delivery_time) - UNIX_TIMESTAMP(o.actual_pickup_time) 
        END) / 60 as avg_delivery_time_minutes,
    SUM(o.driver_fee) as total_earnings,
    d.rating as driver_rating
FROM delta.`/data/lakehouse/drivers` d
LEFT JOIN delta.`/data/lakehouse/orders` o ON d.id = o.driver_id
WHERE o.created_at >= CURRENT_TIMESTAMP - INTERVAL 30 DAYS
GROUP BY d.id, d.name, d.vehicle_type, d.rating
ORDER BY total_deliveries DESC;

-- Driver utilization by hour
CREATE OR REPLACE VIEW driver_utilization_hourly AS
SELECT 
    DATE_TRUNC('hour', o.created_at) as hour,
    COUNT(DISTINCT o.driver_id) as active_drivers,
    COUNT(o.id) as total_orders,
    ROUND(COUNT(o.id) * 1.0 / COUNT(DISTINCT o.driver_id), 2) as orders_per_driver,
    AVG(o.driver_fee) as avg_driver_fee
FROM delta.`/data/lakehouse/orders` o
WHERE o.driver_id IS NOT NULL
    AND o.created_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAYS
GROUP BY DATE_TRUNC('hour', o.created_at)
ORDER BY hour DESC;

-- Driver availability by status
CREATE OR REPLACE VIEW driver_availability AS
SELECT 
    status,
    COUNT(*) as driver_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage,
    AVG(rating) as avg_rating
FROM delta.`/data/lakehouse/drivers`
GROUP BY status
ORDER BY driver_count DESC;

-- ==================================================================
-- PAYMENT SUCCESS RATE VIEWS
-- ==================================================================

-- Payment success rate by method
CREATE OR REPLACE VIEW payment_success_by_method AS
SELECT 
    p.payment_method,
    COUNT(*) as total_transactions,
    SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) as successful_transactions,
    ROUND(SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as success_rate_pct,
    SUM(p.amount) as total_volume,
    AVG(p.amount) as avg_transaction_amount
FROM delta.`/data/lakehouse/payments` p
WHERE p.created_at >= CURRENT_TIMESTAMP - INTERVAL 30 DAYS
GROUP BY p.payment_method
ORDER BY total_transactions DESC;

-- Payment failure analysis
CREATE OR REPLACE VIEW payment_failure_analysis AS
SELECT 
    p.failure_reason,
    COUNT(*) as failure_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage,
    AVG(p.amount) as avg_failed_amount
FROM delta.`/data/lakehouse/payments` p
WHERE p.status = 'failed'
    AND p.created_at >= CURRENT_TIMESTAMP - INTERVAL 30 DAYS
GROUP BY p.failure_reason
ORDER BY failure_count DESC;

-- Payment processing time
CREATE OR REPLACE VIEW payment_processing_time AS
SELECT 
    DATE_TRUNC('hour', created_at) as hour,
    payment_method,
    COUNT(*) as transaction_count,
    AVG(UNIX_TIMESTAMP(updated_at) - UNIX_TIMESTAMP(created_at)) as avg_processing_seconds,
    PERCENTILE_APPROX(UNIX_TIMESTAMP(updated_at) - UNIX_TIMESTAMP(created_at), 0.95) as p95_processing_seconds
FROM delta.`/data/lakehouse/payments`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAYS
GROUP BY DATE_TRUNC('hour', created_at), payment_method
ORDER BY hour DESC, transaction_count DESC;

-- ==================================================================
-- GEOSPATIAL ANALYTICS VIEWS
-- ==================================================================

-- Order density by geographic grid (H3 hexagons level 8)
CREATE OR REPLACE VIEW order_density_geospatial AS
SELECT 
    h3_latlng_to_cell(pickup_latitude, pickup_longitude, 8) as h3_cell,
    COUNT(*) as order_count,
    AVG(total_amount) as avg_order_value,
    COUNT(DISTINCT driver_id) as unique_drivers
FROM delta.`/data/lakehouse/orders`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAYS
    AND pickup_latitude IS NOT NULL
    AND pickup_longitude IS NOT NULL
GROUP BY h3_latlng_to_cell(pickup_latitude, pickup_longitude, 8)
ORDER BY order_count DESC
LIMIT 1000;

-- Average delivery distance and time by region
CREATE OR REPLACE VIEW delivery_metrics_by_region AS
SELECT 
    FLOOR(pickup_latitude * 100) / 100 as lat_bucket,
    FLOOR(pickup_longitude * 100) / 100 as lon_bucket,
    COUNT(*) as order_count,
    AVG(ST_Distance(
        ST_Point(pickup_longitude, pickup_latitude),
        ST_Point(delivery_longitude, delivery_latitude)
    )) / 1000 as avg_distance_km,
    AVG(CASE WHEN actual_delivery_time IS NOT NULL 
        THEN UNIX_TIMESTAMP(actual_delivery_time) - UNIX_TIMESTAMP(actual_pickup_time) 
        END) / 60 as avg_delivery_time_minutes
FROM delta.`/data/lakehouse/orders`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 30 DAYS
    AND pickup_latitude IS NOT NULL
    AND actual_delivery_time IS NOT NULL
GROUP BY FLOOR(pickup_latitude * 100) / 100, FLOOR(pickup_longitude * 100) / 100
HAVING COUNT(*) >= 10
ORDER BY order_count DESC;

-- Driver location heatmap (current active drivers)
CREATE OR REPLACE VIEW driver_location_heatmap AS
SELECT 
    h3_latlng_to_cell(current_latitude, current_longitude, 9) as h3_cell,
    COUNT(*) as driver_count,
    AVG(rating) as avg_rating,
    COLLECT_LIST(STRUCT(id, name, vehicle_type, rating)) as drivers
FROM delta.`/data/lakehouse/drivers`
WHERE status = 'available'
    AND current_latitude IS NOT NULL
    AND current_longitude IS NOT NULL
    AND last_location_update >= CURRENT_TIMESTAMP - INTERVAL 15 MINUTES
GROUP BY h3_latlng_to_cell(current_latitude, current_longitude, 9)
ORDER BY driver_count DESC;

-- ==================================================================
-- TIME-SERIES AGGREGATION VIEWS
-- ==================================================================

-- Daily revenue and order trends
CREATE OR REPLACE VIEW daily_revenue_trends AS
SELECT 
    DATE(created_at) as date,
    COUNT(*) as total_orders,
    SUM(total_amount) as total_revenue,
    SUM(platform_fee) as platform_revenue,
    SUM(driver_fee) as driver_payouts,
    AVG(total_amount) as avg_order_value,
    COUNT(DISTINCT customer_id) as unique_customers,
    COUNT(DISTINCT driver_id) as active_drivers
FROM delta.`/data/lakehouse/orders`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 90 DAYS
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Weekly growth metrics
CREATE OR REPLACE VIEW weekly_growth_metrics AS
SELECT 
    DATE_TRUNC('week', created_at) as week,
    COUNT(*) as orders,
    COUNT(*) - LAG(COUNT(*)) OVER (ORDER BY DATE_TRUNC('week', created_at)) as order_growth,
    ROUND((COUNT(*) - LAG(COUNT(*)) OVER (ORDER BY DATE_TRUNC('week', created_at))) * 100.0 / 
        LAG(COUNT(*)) OVER (ORDER BY DATE_TRUNC('week', created_at)), 2) as order_growth_pct,
    SUM(total_amount) as revenue,
    SUM(total_amount) - LAG(SUM(total_amount)) OVER (ORDER BY DATE_TRUNC('week', created_at)) as revenue_growth,
    COUNT(DISTINCT customer_id) as active_customers
FROM delta.`/data/lakehouse/orders`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 12 WEEKS
GROUP BY DATE_TRUNC('week', created_at)
ORDER BY week DESC;

-- Real-time dashboard metrics (last 5 minutes)
CREATE OR REPLACE VIEW realtime_dashboard_metrics AS
SELECT 
    COUNT(*) as orders_last_5min,
    SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered_last_5min,
    COUNT(DISTINCT driver_id) as active_drivers_last_5min,
    SUM(total_amount) as revenue_last_5min,
    AVG(total_amount) as avg_order_value_last_5min
FROM delta.`/data/lakehouse/orders`
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 5 MINUTES;
