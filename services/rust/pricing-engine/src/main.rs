mod config_validation;

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    env,
            net::SocketAddr,
        time::{SystemTime, UNIX_EPOCH},

    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio_postgres::{Client, NoTls};
use tracing::{info, info_span, Instrument};

mod metrics;

const RESILIENCE_RUN_HEADER: &str = "x-resilience-run-id";
const REQUEST_ID_HEADER: &str = "x-request-id";


#[derive(Clone)]
struct DatabasePool {
    slots: Arc<Vec<tokio::sync::RwLock<Arc<Client>>>>,
    next: Arc<AtomicUsize>,
    database_url: Arc<String>,
}

#[derive(Clone)]
struct AppState {
    service_name: String,
    database: DatabasePool,
    internal_service_token: String,
    request_sequence: Arc<AtomicUsize>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PricingRequest {
    base_price: f64,
    distance_km: f64,
    current_demand: f64,
    available_drivers: f64,
    hour_of_day: Option<u8>,
    day_of_week: Option<u8>,
    weather_condition: Option<String>,
    price_floor: Option<f64>,
    price_ceiling: Option<f64>,
    merchant_elasticity: Option<f64>,
    incentive_budget_ratio: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
struct RideSurgeQuoteRequest {
    trip_id: String,
    zone_id: String,
    city_code: String,
    request_id: String,
    idempotency_key: String,
    base_fare_kobo: i64,
    demand_count: i32,
    supply_count: i32,
    market_source_version: i64,
    h3_cell: String,
    quote_ttl_seconds: Option<i64>,
}

#[derive(Debug, Serialize)]
struct RideSurgeQuoteResponse {
    quote_id: String,
    state: String,
    idempotent: bool,
    policy_version: String,
    surge_multiplier_bps: i32,
    quoted_total_kobo: i64,
    driver_earnings_kobo: i64,
    platform_commission_kobo: i64,
    tax_and_statutory_kobo: i64,
    provider_fee_kobo: i64,
    effective_commission_bps: i32,
    market_demand_count: i32,
    market_supply_count: i32,
    rationale: String,
}

#[derive(Debug, Clone)]
struct SurgePolicy {
    id: String,
    policy_version: String,
    demand_supply_target_bps: i32,
    max_surge_bps: i32,
    max_surge_step_bps: i32,
    base_commission_bps: i32,
    surge_commission_relief_bps: i32,
    minimum_driver_earnings_kobo: i64,
    tax_bps: i32,
    provider_fee_bps: i32,
}

#[derive(Debug, Clone)]
struct CommissionSplit {
    surge_multiplier_bps: i32,
    quoted_total_kobo: i64,
    driver_earnings_kobo: i64,
    platform_commission_kobo: i64,
    tax_and_statutory_kobo: i64,
    provider_fee_kobo: i64,
    effective_commission_bps: i32,
}

#[derive(Debug, Deserialize, Serialize)]
struct BundleQuoteRequest {
    subtotal: f64,
    delivery_fee: f64,
    service_fee: f64,
    small_order_fee: Option<f64>,
    membership_active: Option<bool>,
    reward_balance: Option<i64>,
    sponsored_boost: Option<f64>,
    tip_amount: Option<f64>,
    items_in_basket: Option<u32>,
    priority_delivery: Option<bool>,
    merchant_prep_minutes: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
struct VerticalQuoteRequest {
    vertical_name: String,
    base_fee: f64,
    distance_km: f64,
    item_count: u32,
    turnaround_hours: u32,
    membership_active: Option<bool>,
    regulated_items: Option<bool>,
    special_handling: Option<bool>,
    service_level: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CourierOfferRequest {
    order_value: f64,
    base_payout: f64,
    distance_km: f64,
    estimated_trip_minutes: f64,
    current_demand: f64,
    available_drivers: f64,
    stacked_orders: Option<u32>,
    weather_condition: Option<String>,
    priority_level: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct MarketplaceQuoteRequest {
    vertical_name: String,
    subtotal: f64,
    distance_km: f64,
    item_count: u32,
    current_demand: f64,
    available_drivers: f64,
    membership_active: Option<bool>,
    regulated_items: Option<bool>,
    special_handling: Option<bool>,
    tip_amount: Option<f64>,
    merchant_prep_minutes: Option<u32>,
}

#[derive(Debug, Serialize)]
struct PricingResponse {
    optimized_price: f64,
    surge_multiplier: f64,
    demand_factor: f64,
    supply_factor: f64,
    time_factor: f64,
    fairness_adjustment: f64,
    confidence: f64,
    strategy: String,
    model_version: String,
    guardrail_applied: bool,
    price_floor: f64,
    price_ceiling: f64,
    elasticity_factor: f64,
    incentive_intensity: f64,
    pricing_rationale: String,
}

#[derive(Debug, Serialize)]
struct BundleQuoteResponse {
    base_total: f64,
    discounted_total: f64,
    membership_savings: f64,
    reward_credit: f64,
    sponsored_lift_score: f64,
    suggested_tip: f64,
    eta_minutes: u32,
    recommended_surface: String,
    checkout_message: String,
}

#[derive(Debug, Serialize)]
struct VerticalQuoteResponse {
    vertical_name: String,
    quote_total: f64,
    recommended_fulfillment_mode: String,
    turnaround_risk: String,
    vertical_multiplier: f64,
    surcharge_components: Vec<String>,
    quote_summary: String,
}

#[derive(Debug, Serialize)]
struct CourierOfferResponse {
    payout_total: f64,
    payout_multiplier: f64,
    earnings_per_km: f64,
    earnings_per_hour: f64,
    incentive_components: Vec<String>,
    recommended_dispatch_mode: String,
    courier_message: String,
}

#[derive(Debug, Serialize)]
struct MarketplaceQuoteResponse {
    vertical_name: String,
    customer_total: f64,
    courier_payout: f64,
    platform_take: f64,
    surge_multiplier: f64,
    eta_minutes: u32,
    batching_eligible: bool,
    checkout_surface: String,
    operational_summary: String,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    service: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    if let Err(error) = config_validation::validate_boot_configuration() {
        panic!("{error}");
    }
    let database_url = env::var("DATABASE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .expect("DATABASE_URL must be explicitly configured");
    let internal_service_token = env::var("INTERNAL_SERVICE_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| value.len() >= 32)
        .expect("INTERNAL_SERVICE_TOKEN must be explicitly configured with at least 32 characters");

    let database = create_pool(&database_url)
        .await
        .unwrap_or_else(|error| panic!("failed to initialize pricing connection pool: {error}"));
    ensure_schema(&database)
        .await
        .unwrap_or_else(|error| panic!("failed to initialize pricing schema: {error}"));

    let port = env::var("PORT").unwrap_or_else(|_| "8101".to_string());
    let bind_host = env::var("BIND_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let state = Arc::new(AppState {
        service_name: "pricing-engine".to_string(),
        database,
        internal_service_token,
        request_sequence: Arc::new(AtomicUsize::new(1)),
    });

    let protected_routes = Router::new()
        .route("/price", post(price))
        .route("/ride/surge-quote", post(quote_ride_surge))
        .route("/quote-bundle", post(quote_bundle))
        .route("/quote-vertical", post(quote_vertical))
        .route("/quote-courier-offer", post(quote_courier_offer))
        .route("/quote-marketplace", post(quote_marketplace))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_internal_access_middleware));
    metrics::init("switchos-pricing-engine");
    let app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics::handler))
        .merge(protected_routes)
        .layer(middleware::from_fn(metrics::track))
        .layer(middleware::from_fn_with_state(state.clone(), correlation_middleware))
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", bind_host, port)
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 8101)));
    info!("starting pricing engine on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("shutdown signal received; draining in-flight requests");
}

async fn correlation_middleware(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    let request_id = correlation_header(request.headers(), REQUEST_ID_HEADER).unwrap_or_else(|| generated_request_id(&state));
    let resilience_run_id = correlation_header(request.headers(), RESILIENCE_RUN_HEADER);
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let span = info_span!("http.request", service = %state.service_name, request_id = %request_id, resilience_run_id = %resilience_run_id.as_deref().unwrap_or(""), method = %method, path = %path);
    let mut response = next.run(request).instrument(span).await;
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert(REQUEST_ID_HEADER, value);
    }
    if let Some(run_id) = resilience_run_id {
        if let Ok(value) = HeaderValue::from_str(&run_id) {
            response.headers_mut().insert(RESILIENCE_RUN_HEADER, value);
        }
        info!(service = %state.service_name, event = "http.request.completed", request_id = %request_id, resilience_run_id = %run_id, method = %method, path = %path, status = response.status().as_u16());
    }
    response
}

fn generated_request_id(state: &AppState) -> String {
    let micros = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_micros()).unwrap_or(0);
    let sequence = state.request_sequence.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", state.service_name, micros, sequence)
}

fn correlation_header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|value| value.to_str().ok()).map(str::trim).filter(|value| is_correlation_identifier(value)).map(str::to_owned)
}

fn is_correlation_identifier(value: &str) -> bool {
    (3..=81).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

async fn require_internal_access_middleware(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    match require_internal_access(request.headers(), &state) {
        Ok(()) => next.run(request).await,
        Err((status, body)) => (status, body).into_response(),
    }
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match acquire_client(&state.database).await {
        Ok(client) if client.query_one("SELECT 1", &[]).await.is_ok() => (
            StatusCode::OK,
            Json(HealthResponse {
                status: "ok".to_string(),
                service: state.service_name.clone(),
            }),
        )
            .into_response(),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthResponse {
                status: "degraded".to_string(),
                service: state.service_name.clone(),
            }),
        )
            .into_response(),
    }
}

async fn price(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PricingRequest>,
) -> Result<Json<PricingResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_internal_access(&headers, &state)?;
    if request.base_price <= 0.0 || request.distance_km < 0.0 {
        return Err(error_json(StatusCode::BAD_REQUEST, "invalid pricing request"));
    }

    let client = acquire_client(&state.database).await?;
    let market_demand = if request.current_demand > 0.0 {
        request.current_demand
    } else {
        load_open_demand(&client).await.map_err(jsonify_error)?
    };
    let market_supply = if request.available_drivers > 0.0 {
        request.available_drivers
    } else {
        load_available_supply(&client).await.map_err(jsonify_error)?
    };

    let demand_factor = (market_demand / market_supply.max(1.0)).clamp(0.5, 3.0);
    let supply_factor = (1.5 - (market_supply / market_demand.max(1.0))).clamp(0.7, 1.5);
    let time_factor = match request.hour_of_day.unwrap_or(12) {
        7..=9 | 17..=20 => 1.18,
        21..=23 => 1.10,
        0..=5 => 0.94,
        _ => 1.0,
    };

    let weather_factor = match request.weather_condition.as_deref() {
        Some("rain") | Some("storm") => 1.12,
        Some("heatwave") => 1.06,
        _ => 1.0,
    };

    let weekend_factor = match request.day_of_week.unwrap_or(2) {
        0 | 6 => 1.08,
        _ => 1.0,
    };

    let fairness_adjustment = if request.distance_km > 12.0 { 1.07 } else { 1.0 };
    let elasticity_input = request.merchant_elasticity.unwrap_or(load_default_elasticity(&client).await.map_err(jsonify_error)?).clamp(0.7, 1.2);
    let elasticity_factor = if demand_factor > 1.2 {
        (1.0 / elasticity_input).clamp(0.85, 1.15)
    } else {
        1.0
    };
    let incentive_intensity = request
        .incentive_budget_ratio
        .unwrap_or_else(|| ((request.distance_km / 20.0) + (demand_factor / 4.0)).clamp(0.0, 0.35))
        .clamp(0.0, 0.4);

    let raw_multiplier = demand_factor
        * supply_factor
        * time_factor
        * weather_factor
        * weekend_factor
        * fairness_adjustment
        * elasticity_factor;
    let base_guardrail_floor = request
        .price_floor
        .unwrap_or((request.base_price * 0.9 * 100.0).round() / 100.0)
        .max(0.5);
    let base_guardrail_ceiling = request
        .price_ceiling
        .unwrap_or((request.base_price * 2.4 * 100.0).round() / 100.0);
    let unconstrained_price = request.base_price * raw_multiplier;
    let optimized_price = unconstrained_price.clamp(base_guardrail_floor, base_guardrail_ceiling);
    let guardrail_applied = (optimized_price - unconstrained_price).abs() > f64::EPSILON;
    let surge_multiplier = (optimized_price / request.base_price).clamp(0.85, 2.5);
    let confidence = (0.82 + (market_supply / (market_demand.max(1.0) * 10.0))).clamp(0.75, 0.98);

    let strategy = if surge_multiplier >= 1.25 {
        "surge-protect"
    } else if surge_multiplier <= 0.98 {
        "demand-stimulation"
    } else {
        "balanced-market"
    };

    let pricing_rationale = if guardrail_applied && optimized_price == base_guardrail_ceiling {
        "Price ceiling applied to prevent an excessive surge in a constrained marketplace."
    } else if guardrail_applied && optimized_price == base_guardrail_floor {
        "Price floor applied to preserve margin and minimum viable payout coverage."
    } else if demand_factor > 1.3 && request.distance_km > 12.0 {
        "Demand pressure and long-trip burden justify a moderate surge with fairness support."
    } else if demand_factor < 1.0 {
        "Demand stimulation mode is active to improve marketplace liquidity."
    } else {
        "Balanced market conditions support a standard dispatch-aware price recommendation."
    };

    let response = PricingResponse {
        optimized_price: round2(optimized_price),
        surge_multiplier: round2(surge_multiplier),
        demand_factor: round2(demand_factor),
        supply_factor: round2(supply_factor),
        time_factor: round2(time_factor),
        fairness_adjustment: round2(fairness_adjustment),
        confidence,
        strategy: strategy.to_string(),
        model_version: "rust-pricing-engine-v6-postgres".to_string(),
        guardrail_applied,
        price_floor: round2(base_guardrail_floor),
        price_ceiling: round2(base_guardrail_ceiling),
        elasticity_factor: round2(elasticity_factor),
        incentive_intensity: round2(incentive_intensity),
        pricing_rationale: pricing_rationale.to_string(),
    };
    persist_run(&client, "price", &request, &response).await.map_err(jsonify_error)?;
    Ok(Json(response))
}

async fn quote_ride_surge(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<RideSurgeQuoteRequest>,
) -> Result<Json<RideSurgeQuoteResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_internal_access(&headers, &state)?;
    validate_ride_quote_request(&request)?;
    let client = acquire_client(&state.database).await?;
    let policy = load_active_surge_policy(&client, &request.city_code, &request.zone_id)
        .await
        .map_err(jsonify_error)?;
    let split = calculate_commission_split(
        &policy,
        request.base_fare_kobo,
        request.demand_count,
        request.supply_count,
    )?;
    let ttl_seconds = request.quote_ttl_seconds.unwrap_or(300).clamp(30, 900);
    let request_payload = serde_json::to_value(&request).map_err(|error| jsonify_error(error.to_string()))?;
    let request_digest_source = request_payload.to_string();
    let response_payload = serde_json::json!({
        "policy_version": policy.policy_version,
        "surge_multiplier_bps": split.surge_multiplier_bps,
        "quoted_total_kobo": split.quoted_total_kobo,
        "driver_earnings_kobo": split.driver_earnings_kobo,
        "platform_commission_kobo": split.platform_commission_kobo,
        "tax_and_statutory_kobo": split.tax_and_statutory_kobo,
        "provider_fee_kobo": split.provider_fee_kobo,
        "effective_commission_bps": split.effective_commission_bps,
    });

    // This one statement atomically records a fresh quote, all allocations, and the
    // durable publish intent. On an idempotency conflict it writes nothing and the
    // existing quote is returned below.
    let created = client
        .query_opt(
            r#"
            WITH inserted AS (
              INSERT INTO pricing.ride_quote
                (trip_id, zone_id, pricing_policy_id, pricing_policy_version, request_id, idempotency_key,
                 base_fare_kobo, surge_multiplier_bps, quoted_total_kobo, demand_count, supply_count, expires_at)
              VALUES
                ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4, $5::text::uuid, $6, $7, $8, $9, $10, $11, NOW() + ($12::bigint * INTERVAL '1 second'))
              ON CONFLICT (trip_id, idempotency_key) DO NOTHING
              RETURNING id
            ), allocations AS (
              INSERT INTO pricing.quote_commission_allocation
                (quote_id, allocation_kind, amount_kobo, rate_bps, policy_version)
              SELECT inserted.id, allocation_kind::pricing.allocation_kind, amount_kobo, rate_bps, $4
              FROM inserted
              CROSS JOIN (VALUES
                ('driver_earnings', $13::bigint, NULL::integer),
                ('platform_commission', $14::bigint, $15::integer),
                ('tax_and_statutory', $16::bigint, $17::integer),
                ('provider_fee', $18::bigint, $19::integer)
              ) AS contribution(allocation_kind, amount_kobo, rate_bps)
              RETURNING quote_id
            ), event AS (
              INSERT INTO pricing.outbox_event (aggregate_type, aggregate_id, event_type, idempotency_key, payload)
              SELECT 'ride_quote', inserted.id, 'pricing.quote.created', 'ride-quote:' || inserted.id::text, $20::jsonb
              FROM inserted
              RETURNING id
            )
            SELECT id::text FROM inserted
            "#,
            &[
                &request.trip_id, &request.zone_id, &policy.id, &policy.policy_version, &request.request_id,
                &request.idempotency_key, &request.base_fare_kobo, &split.surge_multiplier_bps,
                &split.quoted_total_kobo, &request.demand_count, &request.supply_count, &ttl_seconds,
                &split.driver_earnings_kobo, &split.platform_commission_kobo, &split.effective_commission_bps,
                &split.tax_and_statutory_kobo, &policy.tax_bps, &split.provider_fee_kobo,
                &policy.provider_fee_bps, &response_payload,
            ],
        )
        .await
        .map_err(|error| jsonify_error(error.to_string()))?;

    let (quote_id, idempotent) = if let Some(row) = created {
        (row.get::<_, String>("id"), false)
    } else {
        let row = client
            .query_one(
                "SELECT id::text FROM pricing.ride_quote WHERE trip_id=$1::text::uuid AND idempotency_key=$2",
                &[&request.trip_id, &request.idempotency_key],
            )
            .await
            .map_err(|error| jsonify_error(error.to_string()))?;
        (row.get::<_, String>("id"), true)
    };

    // Every accepted quote carries a durable market observation. Snapshot collisions
    // are benign when the caller retries the same source version.
    client
        .execute(
            "INSERT INTO pricing.market_snapshot (city_code, zone_id, h3_cell, window_started_at, window_ended_at, open_trip_count, eligible_driver_count, source_version, input_digest) VALUES ($1,$2::text::uuid,$3,NOW()-INTERVAL '1 minute',NOW(),$4,$5,$6,digest($7::text,'sha256')) ON CONFLICT (zone_id,h3_cell,source_version) DO NOTHING",
            &[&request.city_code, &request.zone_id, &request.h3_cell, &request.demand_count, &request.supply_count, &request.market_source_version, &request_digest_source],
        )
        .await
        .map_err(|error| jsonify_error(error.to_string()))?;

    Ok(Json(RideSurgeQuoteResponse {
        quote_id,
        state: "quoted".to_string(),
        idempotent,
        policy_version: policy.policy_version.clone(),
        surge_multiplier_bps: split.surge_multiplier_bps,
        quoted_total_kobo: split.quoted_total_kobo,
        driver_earnings_kobo: split.driver_earnings_kobo,
        platform_commission_kobo: split.platform_commission_kobo,
        tax_and_statutory_kobo: split.tax_and_statutory_kobo,
        provider_fee_kobo: split.provider_fee_kobo,
        effective_commission_bps: split.effective_commission_bps,
        market_demand_count: request.demand_count,
        market_supply_count: request.supply_count,
        rationale: format!("policy={} demand={} supply={} surge_bps={}", policy.policy_version, request.demand_count, request.supply_count, split.surge_multiplier_bps),
    }))
}

fn validate_ride_quote_request(request: &RideSurgeQuoteRequest) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let is_uuid = |value: &str| is_canonical_uuid(value);
    if !is_uuid(&request.trip_id) || !is_uuid(&request.zone_id) || !is_uuid(&request.request_id) {
        return Err(error_json(StatusCode::BAD_REQUEST, "trip_id, zone_id, and request_id must be UUIDs"));
    }
    if request.city_code.len() < 3 || request.city_code.len() > 12 || !request.city_code.chars().all(|value| value.is_ascii_uppercase()) {
        return Err(error_json(StatusCode::BAD_REQUEST, "city_code must contain 3-12 uppercase ASCII letters"));
    }
    if request.idempotency_key.len() < 16 || request.idempotency_key.len() > 160 || request.base_fare_kobo <= 0 || request.demand_count < 0 || request.supply_count < 0 || request.market_source_version <= 0 || request.h3_cell.len() < 15 || request.h3_cell.len() > 16 || !request.h3_cell.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err(error_json(StatusCode::BAD_REQUEST, "ride surge quote request is outside validated bounds"));
    }
    Ok(())
}

async fn load_active_surge_policy(client: &Client, city_code: &str, zone_id: &str) -> Result<SurgePolicy, String> {
    let row = client
        .query_opt(
            "SELECT id::text, policy_version, demand_supply_target_bps, max_surge_bps, max_surge_step_bps, base_commission_bps, surge_commission_relief_bps, minimum_driver_earnings_kobo, tax_bps, provider_fee_bps FROM pricing.surge_policy WHERE city_code=$1 AND active=true AND effective_from<=NOW() AND (effective_to IS NULL OR effective_to>NOW()) AND (zone_id=$2::text::uuid OR zone_id IS NULL) ORDER BY (zone_id IS NULL), effective_from DESC LIMIT 1",
            &[&city_code, &zone_id],
        )
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no active surge policy exists for this city and zone".to_string())?;
    Ok(SurgePolicy {
        id: row.get("id"),
        policy_version: row.get("policy_version"),
        demand_supply_target_bps: row.get("demand_supply_target_bps"),
        max_surge_bps: row.get("max_surge_bps"),
        max_surge_step_bps: row.get("max_surge_step_bps"),
        base_commission_bps: row.get("base_commission_bps"),
        surge_commission_relief_bps: row.get("surge_commission_relief_bps"),
        minimum_driver_earnings_kobo: row.get("minimum_driver_earnings_kobo"),
        tax_bps: row.get("tax_bps"),
        provider_fee_bps: row.get("provider_fee_bps"),
    })
}

fn calculate_commission_split(policy: &SurgePolicy, base_fare_kobo: i64, demand_count: i32, supply_count: i32) -> Result<CommissionSplit, (StatusCode, Json<serde_json::Value>)> {
    if base_fare_kobo <= 0 {
        return Err(error_json(StatusCode::BAD_REQUEST, "base_fare_kobo must be positive"));
    }
    let ratio_bps = ((i64::from(demand_count) * 10_000) / i64::from(supply_count.max(1))) as i32;
    let excess_bps = ratio_bps.saturating_sub(policy.demand_supply_target_bps);
    let computed_surge_bps = 10_000 + (excess_bps / 2).clamp(0, policy.max_surge_step_bps);
    let surge_multiplier_bps = computed_surge_bps.clamp(10_000, policy.max_surge_bps);
    let quoted_total_kobo = multiply_bps_round_half_up(base_fare_kobo, surge_multiplier_bps);
    let relief = ((surge_multiplier_bps - 10_000).max(0) * policy.surge_commission_relief_bps) / 10_000;
    let effective_commission_bps = policy.base_commission_bps.saturating_sub(relief).max(0);
    let tax_and_statutory_kobo = multiply_bps_round_half_up(quoted_total_kobo, policy.tax_bps);
    let provider_fee_kobo = multiply_bps_round_half_up(quoted_total_kobo, policy.provider_fee_bps);
    let mut platform_commission_kobo = multiply_bps_round_half_up(quoted_total_kobo, effective_commission_bps);
    let minimum_required = policy.minimum_driver_earnings_kobo;
    let preliminary_driver = quoted_total_kobo - tax_and_statutory_kobo - provider_fee_kobo - platform_commission_kobo;
    if preliminary_driver < minimum_required {
        let relief_kobo = (minimum_required - preliminary_driver).min(platform_commission_kobo);
        platform_commission_kobo -= relief_kobo;
    }
    let driver_earnings_kobo = quoted_total_kobo - tax_and_statutory_kobo - provider_fee_kobo - platform_commission_kobo;
    if driver_earnings_kobo < 0 {
        return Err(error_json(StatusCode::UNPROCESSABLE_ENTITY, "policy deductions exceed quoted fare"));
    }
    Ok(CommissionSplit {
        surge_multiplier_bps,
        quoted_total_kobo,
        driver_earnings_kobo,
        platform_commission_kobo,
        tax_and_statutory_kobo,
        provider_fee_kobo,
        effective_commission_bps,
    })
}

fn multiply_bps_round_half_up(amount_kobo: i64, basis_points: i32) -> i64 {
    (amount_kobo.saturating_mul(i64::from(basis_points)) + 5_000) / 10_000
}

fn is_canonical_uuid(value: &str) -> bool {
    let expected = [8usize, 4, 4, 4, 12];
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == expected.len()
        && parts.iter().zip(expected.iter()).all(|(part, expected_len)| part.len() == *expected_len && part.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

async fn quote_bundle(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<BundleQuoteRequest>,
) -> Result<Json<BundleQuoteResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_internal_access(&headers, &state)?;
    if request.subtotal < 0.0 || request.delivery_fee < 0.0 || request.service_fee < 0.0 {
        return Err(error_json(StatusCode::BAD_REQUEST, "invalid quote request"));
    }

    let client = acquire_client(&state.database).await?;
    let small_order_fee = request.small_order_fee.unwrap_or(0.0).max(0.0);
    let priority_fee = if request.priority_delivery.unwrap_or(false) { 2.49 } else { 0.0 };
    let base_total = request.subtotal + request.delivery_fee + request.service_fee + small_order_fee + priority_fee;
    let membership_savings = if request.membership_active.unwrap_or(false) {
        (request.delivery_fee * 0.85).min(request.delivery_fee) + if priority_fee > 0.0 { 0.99 } else { 0.0 }
    } else {
        0.0
    };
    let reward_credit = if request.reward_balance.unwrap_or(0) >= 300 { 3.0 } else { 0.0 };
    let suggested_tip = request.tip_amount.unwrap_or_else(|| {
        let item_density = request.items_in_basket.unwrap_or(3) as f64;
        (request.subtotal * 0.12).max(2.0) + (item_density / 10.0)
    });
    let sponsored_lift_score = request.sponsored_boost.unwrap_or(load_default_boost(&client).await.map_err(jsonify_error)?).clamp(0.0, 0.5);
    let discounted_total = (base_total - membership_savings - reward_credit + suggested_tip).max(0.0);
    let prep_minutes = request.merchant_prep_minutes.unwrap_or(load_average_prep_minutes(&client).await.map_err(jsonify_error)?);
    let eta_minutes = prep_minutes + if request.priority_delivery.unwrap_or(false) { 18 } else { 26 };

    let recommended_surface = if !request.membership_active.unwrap_or(false) && request.subtotal < 18.0 {
        "membership_upsell"
    } else if reward_credit > 0.0 {
        "reward_redemption"
    } else if request.priority_delivery.unwrap_or(false) {
        "priority_checkout"
    } else {
        "express_checkout"
    };
    let checkout_message = if recommended_surface == "membership_upsell" {
        "Offer a membership nudge to remove fee friction before basket abandonment."
    } else if recommended_surface == "reward_redemption" {
        "Prompt reward redemption to secure conversion without over-subsidizing the basket."
    } else if recommended_surface == "priority_checkout" {
        "Promote a premium checkout lane with stronger ETA confidence and courier priority."
    } else {
        "Fast-path the order through express checkout with a sponsored reorder follow-up."
    };

    let response = BundleQuoteResponse {
        base_total: round2(base_total),
        discounted_total: round2(discounted_total),
        membership_savings: round2(membership_savings),
        reward_credit: round2(reward_credit),
        sponsored_lift_score: round2(sponsored_lift_score),
        suggested_tip: round2(suggested_tip),
        eta_minutes,
        recommended_surface: recommended_surface.to_string(),
        checkout_message: checkout_message.to_string(),
    };
    persist_run(&client, "quote_bundle", &request, &response).await.map_err(jsonify_error)?;
    Ok(Json(response))
}

async fn quote_vertical(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<VerticalQuoteRequest>,
) -> Result<Json<VerticalQuoteResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_internal_access(&headers, &state)?;
    if request.base_fee < 0.0 || request.distance_km < 0.0 {
        return Err(error_json(StatusCode::BAD_REQUEST, "invalid vertical quote request"));
    }

    let client = acquire_client(&state.database).await?;
    let vertical = request.vertical_name.to_lowercase();
    let mut multiplier = 1.0;
    let mut surcharge_components = Vec::new();
    let mut fulfillment_mode = "pickup_dropoff".to_string();

    if vertical.contains("laundry") || vertical.contains("dry") || vertical.contains("clean") {
        multiplier += 0.18;
        fulfillment_mode = "pickup_process_dropoff".to_string();
        surcharge_components.push("processing_handling".to_string());
    } else if vertical.contains("pharmacy") || vertical.contains("health") {
        multiplier += 0.22;
        fulfillment_mode = "regulated_chain_of_custody".to_string();
        surcharge_components.push("regulated_chain_of_custody".to_string());
    } else if vertical.contains("retail") || vertical.contains("grocery") {
        multiplier += 0.12;
        fulfillment_mode = "basket_fulfillment".to_string();
        surcharge_components.push("basket_coordination".to_string());
    }

    if request.turnaround_hours <= 6 {
        multiplier += 0.15;
        surcharge_components.push("rush_turnaround".to_string());
    }
    if request.special_handling.unwrap_or(false) {
        multiplier += 0.1;
        surcharge_components.push("special_handling".to_string());
    }
    if request.regulated_items.unwrap_or(false) {
        multiplier += 0.12;
        surcharge_components.push("regulated_items".to_string());
    }
    if matches!(request.service_level.as_deref(), Some("priority") | Some("white_glove")) {
        multiplier += 0.09;
        surcharge_components.push("priority_service_level".to_string());
    }

    let item_factor = 1.0 + ((request.item_count as f64) / 30.0).clamp(0.0, 0.35);
    let distance_component = request.distance_km * 0.85;
    let membership_discount = if request.membership_active.unwrap_or(false) { 2.5 } else { 0.0 };
    let compliance_load = load_vertical_compliance_multiplier(&client, &request.vertical_name)
        .await
        .map_err(jsonify_error)?;
    let quoted = ((request.base_fee + distance_component) * multiplier * item_factor * compliance_load) - membership_discount;
    let turnaround_risk = if request.turnaround_hours <= 6 {
        "high"
    } else if request.turnaround_hours <= 24 {
        "moderate"
    } else {
        "normal"
    };

    let response = VerticalQuoteResponse {
        vertical_name: request.vertical_name.clone(),
        quote_total: round2(quoted.max(0.0)),
        recommended_fulfillment_mode: fulfillment_mode,
        turnaround_risk: turnaround_risk.to_string(),
        vertical_multiplier: round2(multiplier * compliance_load),
        surcharge_components,
        quote_summary: format!(
            "Quote reflects vertical complexity, distance, item count, compliance load, and turnaround expectations for {}.",
            request.vertical_name
        ),
    };
    persist_run(&client, "quote_vertical", &request, &response).await.map_err(jsonify_error)?;
    Ok(Json(response))
}

async fn quote_courier_offer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CourierOfferRequest>,
) -> Result<Json<CourierOfferResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_internal_access(&headers, &state)?;
    let client = acquire_client(&state.database).await?;

    let demand = if request.current_demand > 0.0 {
        request.current_demand
    } else {
        load_open_demand(&client).await.map_err(jsonify_error)?
    };
    let supply = if request.available_drivers > 0.0 {
        request.available_drivers
    } else {
        load_available_supply(&client).await.map_err(jsonify_error)?
    };
    let ratio = demand / supply.max(1.0);
    let weather_bonus = match request.weather_condition.as_deref() {
        Some("rain") => 0.07,
        Some("storm") => 0.12,
        _ => 0.0,
    };
    let stack_penalty = if request.stacked_orders.unwrap_or(1) > 1 { 0.08 } else { 0.0 };
    let priority_bonus = match request.priority_level.as_deref() {
        Some("urgent") | Some("vip") => 0.10,
        Some("high") => 0.05,
        _ => 0.0,
    };
    let demand_bonus = if ratio > 1.5 { 0.15 } else if ratio > 1.15 { 0.08 } else { 0.0 };
    let payout_multiplier = 1.0 + weather_bonus + stack_penalty + priority_bonus + demand_bonus;
    let payout_total = request.base_payout * payout_multiplier;
    let earnings_per_km = payout_total / request.distance_km.max(1.0);
    let earnings_per_hour = payout_total / (request.estimated_trip_minutes.max(10.0) / 60.0);

    let response = CourierOfferResponse {
        payout_total: round2(payout_total),
        payout_multiplier: round2(payout_multiplier),
        earnings_per_km: round2(earnings_per_km),
        earnings_per_hour: round2(earnings_per_hour),
        incentive_components: vec![
            format!("demand_ratio_bonus={:.2}", demand_bonus),
            format!("weather_bonus={:.2}", weather_bonus),
            format!("priority_bonus={:.2}", priority_bonus),
        ],
        recommended_dispatch_mode: if ratio > 1.2 { "trip_radar".to_string() } else { "direct_assignment".to_string() },
        courier_message: "Courier payout reflects demand pressure, weather, stack complexity, and priority service incentives.".to_string(),
    };
    persist_run(&client, "quote_courier_offer", &request, &response).await.map_err(jsonify_error)?;
    Ok(Json(response))
}

async fn quote_marketplace(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<MarketplaceQuoteRequest>,
) -> Result<Json<MarketplaceQuoteResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_internal_access(&headers, &state)?;
    let client = acquire_client(&state.database).await?;

    let demand = if request.current_demand > 0.0 {
        request.current_demand
    } else {
        load_open_demand(&client).await.map_err(jsonify_error)?
    };
    let supply = if request.available_drivers > 0.0 {
        request.available_drivers
    } else {
        load_available_supply(&client).await.map_err(jsonify_error)?
    };
    let surge_multiplier = if demand / supply.max(1.0) > 1.5 {
        1.25
    } else if demand / supply.max(1.0) > 1.15 {
        1.12
    } else {
        1.0
    };
    let courier_payout = (request.distance_km * 0.95 + request.item_count as f64 * 0.18)
        * if request.special_handling.unwrap_or(false) { 1.12 } else { 1.0 };
    let eta_minutes = request.merchant_prep_minutes.unwrap_or(load_average_prep_minutes(&client).await.map_err(jsonify_error)?)
        + if request.distance_km > 10.0 { 28 } else { 18 };
    let tip_amount = request.tip_amount.unwrap_or(0.0);
    let customer_total = (request.subtotal * surge_multiplier) + courier_payout + tip_amount;
    let platform_take = (customer_total - courier_payout).max(0.0) * 0.22;
    let batching_eligible = request.item_count <= 12 && !request.regulated_items.unwrap_or(false);

    let response = MarketplaceQuoteResponse {
        vertical_name: request.vertical_name.clone(),
        customer_total: round2(customer_total),
        courier_payout: round2(courier_payout),
        platform_take: round2(platform_take),
        surge_multiplier: round2(surge_multiplier),
        eta_minutes,
        batching_eligible,
        checkout_surface: if request.membership_active.unwrap_or(false) {
            "member_checkout".to_string()
        } else {
            "standard_checkout".to_string()
        },
        operational_summary: format!(
            "Quote uses live marketplace demand and driver supply with {} batching eligibility.",
            if batching_eligible { "positive" } else { "restricted" }
        ),
    };
    persist_run(&client, "quote_marketplace", &request, &response).await.map_err(jsonify_error)?;
    Ok(Json(response))
}

async fn connect_client(database_url: &str) -> Result<Client, String> {
    let (client, connection) = tokio_postgres::connect(database_url, NoTls)
        .await
        .map_err(|error| format!("connect postgres: {error}"))?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            tracing::error!("pricing engine pooled postgres connection error: {}", error);
        }
    });
    Ok(client)
}

async fn create_pool(database_url: &str) -> Result<DatabasePool, String> {
    let max_size = env::var("DATABASE_POOL_MAX_SIZE")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(24)
        .clamp(4, 48);
    let mut slots = Vec::with_capacity(max_size);
    for slot in 0..max_size {
        let client = connect_client(database_url)
            .await
            .map_err(|error| format!("open pricing database connection {slot}: {error}"))?;
        slots.push(tokio::sync::RwLock::new(Arc::new(client)));
    }
    Ok(DatabasePool {
        slots: Arc::new(slots),
        next: Arc::new(AtomicUsize::new(0)),
        database_url: Arc::new(database_url.to_string()),
    })
}

async fn acquire_client(pool: &DatabasePool) -> Result<Arc<Client>, (StatusCode, Json<serde_json::Value>)> {
    if pool.slots.is_empty() {
        return Err(jsonify_error("database pool unavailable".to_string()));
    }
    let len = pool.slots.len();
    let start = pool.next.fetch_add(1, Ordering::Relaxed) % len;
    for offset in 0..len {
        let slot = &pool.slots[(start + offset) % len];
        {
            let guard = slot.read().await;
            if !guard.is_closed() {
                return Ok(Arc::clone(&guard));
            }
        }
        // The cached connection is dead (e.g. after a Postgres restart):
        // replace it with a fresh one so the pool heals itself.
        let mut guard = slot.write().await;
        if !guard.is_closed() {
            return Ok(Arc::clone(&guard));
        }
        match connect_client(&pool.database_url).await {
            Ok(client) => {
                let client = Arc::new(client);
                *guard = Arc::clone(&client);
                tracing::info!("pricing engine re-established a postgres pool connection");
                return Ok(client);
            }
            Err(error) => {
                tracing::warn!("pricing engine postgres reconnect failed: {}", error);
            }
        }
    }
    Err(jsonify_error("database pool unavailable".to_string()))
}

async fn ensure_schema(pool: &DatabasePool) -> Result<(), String> {
    let client = acquire_client(pool).await.map_err(|(_, payload)| payload["error"].as_str().unwrap_or("database error").to_string())?;
    client
        .batch_execute(
            r#"
            CREATE TABLE IF NOT EXISTS pricing_engine_runs (
                id BIGSERIAL PRIMARY KEY,
                endpoint TEXT NOT NULL,
                request_json JSONB NOT NULL,
                response_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            "#,
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn require_internal_access(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let provided = headers
        .get("x-internal-service-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim();
    if subtle_equal(provided, &state.internal_service_token) {
        Ok(())
    } else {
        Err(error_json(StatusCode::UNAUTHORIZED, "unauthorized"))
    }
}

fn subtle_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes()
        .iter()
        .zip(b.as_bytes().iter())
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

async fn load_open_demand(client: &Client) -> Result<f64, String> {
    let row = client
        .query_one(
            "SELECT COUNT(*)::float8 AS count FROM orders WHERE status IN ('pending', 'confirmed', 'assigned', 'picked_up', 'in_transit')",
            &[],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(row.get::<_, f64>("count").max(1.0))
}

async fn load_available_supply(client: &Client) -> Result<f64, String> {
    let row = client
        .query_one(
            "SELECT COUNT(*)::float8 AS count FROM drivers WHERE status = 'online' AND COALESCE(availability, 'available') = 'available'",
            &[],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(row.get::<_, f64>("count").max(1.0))
}

async fn load_default_elasticity(client: &Client) -> Result<f64, String> {
    let row = client
        .query_one(
            "SELECT COALESCE(AVG(CASE WHEN status = 'delivered' THEN 0.96 ELSE 1.04 END), 1.0)::float8 AS elasticity FROM orders",
            &[],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(row.get::<_, f64>("elasticity").clamp(0.8, 1.15))
}

async fn load_default_boost(client: &Client) -> Result<f64, String> {
    let row = client
        .query_one(
            "SELECT COALESCE(AVG(CASE WHEN is_active THEN 0.18 ELSE 0.08 END), 0.12)::float8 AS boost FROM marketing_campaigns",
            &[],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(row.get::<_, f64>("boost").clamp(0.08, 0.3))
}

async fn load_average_prep_minutes(client: &Client) -> Result<u32, String> {
    let row = client
        .query_one(
            "SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(actual_delivery_time, estimated_delivery_time, NOW()) - created_at)) / 60.0), 18)::float8 AS prep_minutes FROM orders",
            &[],
        )
        .await
        .map_err(|error| error.to_string())?;
    let value = row.get::<_, f64>("prep_minutes").round().clamp(10.0, 45.0);
    Ok(value as u32)
}

async fn load_vertical_compliance_multiplier(client: &Client, vertical_name: &str) -> Result<f64, String> {
    let normalized = vertical_name.to_lowercase();
    let row = client
        .query_one(
            "SELECT COALESCE(AVG(CASE WHEN status = 'active' THEN 1.0 ELSE 1.08 END), 1.0)::float8 AS factor FROM service_providers WHERE LOWER(category) LIKE $1 OR LOWER(name) LIKE $1 OR LOWER(business_name) LIKE $1",
            &[&format!("%{}%", normalized)],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(row.get::<_, f64>("factor").clamp(1.0, 1.2))
}

async fn persist_run<T: Serialize, U: Serialize>(client: &Client, endpoint: &str, request: &T, response: &U) -> Result<(), String> {
    let request_json = serde_json::to_value(request).map_err(|error| error.to_string())?;
    let response_json = serde_json::to_value(response).map_err(|error| error.to_string())?;
    client
        .execute(
            "INSERT INTO pricing_engine_runs (endpoint, request_json, response_json) VALUES ($1, $2, $3)",
            &[&endpoint, &request_json, &response_json],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn jsonify_error(error: String) -> (StatusCode, Json<serde_json::Value>) {
    error_json(StatusCode::INTERNAL_SERVER_ERROR, &error)
}

fn error_json(status: StatusCode, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": message })))
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::{calculate_commission_split, multiply_bps_round_half_up, round2, subtle_equal, SurgePolicy};

    #[test]
    fn secure_comparison_accepts_only_equal_values() {
        assert!(subtle_equal("32-character-internal-service-token", "32-character-internal-service-token"));
        assert!(!subtle_equal("32-character-internal-service-token", "32-character-internal-service-t0ken"));
        assert!(!subtle_equal("short", "longer"));
    }

    #[test]
    fn surge_and_commission_are_integer_safe_and_balanced() {
        let policy = SurgePolicy {
            id: "00000000-0000-0000-0000-000000000001".to_string(), policy_version: "test-v1".to_string(),
            demand_supply_target_bps: 10_000, max_surge_bps: 18_000, max_surge_step_bps: 4_000,
            base_commission_bps: 2_000, surge_commission_relief_bps: 1_000, minimum_driver_earnings_kobo: 6_000,
            tax_bps: 500, provider_fee_bps: 200,
        };
        let split = calculate_commission_split(&policy, 10_000, 30, 10).expect("valid split");
        assert_eq!(split.surge_multiplier_bps, 14_000);
        assert_eq!(split.quoted_total_kobo, 14_000);
        assert_eq!(split.quoted_total_kobo, split.driver_earnings_kobo + split.platform_commission_kobo + split.tax_and_statutory_kobo + split.provider_fee_kobo);
        assert_eq!(multiply_bps_round_half_up(101, 500), 5);
    }

    #[test]
    fn rounding_preserves_two_decimal_pricing_precision() {
        assert_eq!(round2(19.995), 20.0);
        assert_eq!(round2(19.994), 19.99);
        assert_eq!(round2(-2.675), -2.68);
    }
}
