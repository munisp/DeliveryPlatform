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
    cmp::Ordering,
    env,
            net::SocketAddr,
        time::{SystemTime, UNIX_EPOCH},

    sync::{
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        Arc,
    },
};
use tokio_postgres::{Client, NoTls};
use tracing::{info, info_span, Instrument, Level};

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
struct DispatchRequest {
    order_id: Option<i64>,
    trip_mode: Option<String>,
    demand_level: Option<f64>,
    supply_level: Option<f64>,
    multi_stop: Option<bool>,
    long_trip_minutes: Option<f64>,
    priority_level: Option<String>,
    drivers: Vec<DriverInput>,
}

#[derive(Debug, Deserialize, Serialize)]
struct TripRadarRequest {
    orders: Vec<TripRadarOrder>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct TripRadarOrder {
    order_id: i64,
    demand_level: Option<f64>,
    supply_level: Option<f64>,
    long_trip_minutes: Option<f64>,
    multi_stop: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
struct BatchRequest {
    orders: Vec<BatchOrder>,
    max_batch_distance_km: Option<f64>,
    max_batch_size: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct BatchOrder {
    order_id: i64,
    zone_key: Option<String>,
    distance_km: f64,
    prep_minutes: Option<f64>,
    regulated_items: Option<bool>,
    priority_level: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct EtaRequest {
    distance_km: f64,
    merchant_prep_minutes: f64,
    driver_eta_minutes: Option<f64>,
    stacked_orders: Option<u32>,
    weather_condition: Option<String>,
    priority_delivery: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
struct VoicePriorityRequest {
    active_calls: Option<f64>,
    staffed_lines: Option<f64>,
    substitution_cases: Option<f64>,
    lifetime_orders: Option<f64>,
    substitution_risk: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct InstantRetailAllocationRequest {
    order_id: Option<i64>,
    city: Option<String>,
    customer_zone: Option<String>,
    cold_chain_required: Option<bool>,
    priority_level: Option<String>,
    items: Vec<InstantRetailItem>,
    warehouses: Vec<WarehouseCandidate>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct InstantRetailItem {
    sku: String,
    quantity: f64,
    substitution_group: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct WarehouseCandidate {
    warehouse_id: i64,
    label: String,
    zone_key: Option<String>,
    distance_km: f64,
    pick_pack_minutes: Option<f64>,
    cold_chain_ready: Option<bool>,
    stock_accuracy: Option<f64>,
    available_inventory: Vec<WarehouseInventory>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct WarehouseInventory {
    sku: String,
    available_units: f64,
    freshness_hours: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct DriverInput {
    driver_id: i64,
    name: Option<String>,
    tier: Option<String>,
    acceptance_rate: Option<f64>,
    completion_rate: Option<f64>,
    utilization_rate: Option<f64>,
    distance_km: Option<f64>,
    idle_minutes: Option<f64>,
    recent_rejections: Option<i32>,
    on_trip: Option<bool>,
}

#[derive(Debug, Serialize)]
struct DispatchResponse {
    strategy: String,
    supply_demand_ratio: f64,
    surge_multiplier: f64,
    long_trip_premium: f64,
    multi_stop_surcharge: f64,
    recommended_driver_id: Option<i64>,
    recommended_driver_name: Option<String>,
    ranked_candidates: Vec<RankedDriver>,
}

#[derive(Debug, Serialize)]
struct TripRadarResponse {
    strategy: String,
    highlighted_orders: Vec<TripRadarOrderResponse>,
}

#[derive(Debug, Serialize)]
struct TripRadarOrderResponse {
    order_id: i64,
    trip_mode: String,
    publish_to_radar: bool,
    payout_multiplier: f64,
    reason: String,
}

#[derive(Debug, Serialize)]
struct BatchResponse {
    strategy: String,
    recommended_batches: Vec<BatchRecommendation>,
    unbatched_order_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
struct BatchRecommendation {
    batch_id: String,
    zone_key: String,
    order_ids: Vec<i64>,
    total_distance_km: f64,
    fulfillment_mode: String,
    priority_band: String,
    reason: String,
}

#[derive(Debug, Serialize)]
struct EtaResponse {
    eta_minutes: u32,
    confidence_band: String,
    batching_delay_minutes: u32,
    dispatch_ready_in_minutes: u32,
    customer_message: String,
}

#[derive(Debug, Serialize)]
struct VoicePriorityResponse {
    band: String,
    score: f64,
    reason: String,
}

#[derive(Debug, Serialize)]
struct InstantRetailAllocationResponse {
    strategy: String,
    selected_warehouse_id: Option<i64>,
    selected_warehouse_label: Option<String>,
    fill_rate: f64,
    estimated_ready_minutes: u32,
    split_shipment_required: bool,
    suggested_substitutions: Vec<String>,
    ranked_warehouses: Vec<WarehouseAllocationScore>,
    rationale: String,
    metrics: ResponseMetrics,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct SupplyShockZone {
    zone_key: String,
    open_orders: f64,
    online_drivers: f64,
    warehouse_fill_rate: f64,
    avg_eta_minutes: f64,
    cold_chain_gap: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
struct SupplyShockRebalanceRequest {
    city: Option<String>,
    shock_type: Option<String>,
    priority_level: Option<String>,
    zones: Vec<SupplyShockZone>,
}

#[derive(Debug, Serialize)]
struct SupplyShockZoneRecommendation {
    zone_key: String,
    pressure_score: f64,
    action: String,
    recommended_driver_shift: i32,
    recommended_inventory_shift_units: i32,
    reason: String,
}

#[derive(Debug, Serialize)]
struct SupplyShockRebalanceResponse {
    strategy: String,
    shock_type: String,
    city: Option<String>,
    highest_risk_zone: Option<String>,
    recommendations: Vec<SupplyShockZoneRecommendation>,
    metrics: ResponseMetrics,
}

#[derive(Debug, Serialize)]
struct ResponseMetrics {
    trace_id: String,
    duration_ms: f64,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct WarehouseAllocationScore {
    warehouse_id: i64,
    label: String,
    zone_key: String,
    score: f64,
    fill_rate: f64,
    estimated_ready_minutes: u32,
    cold_chain_ready: bool,
    reason: String,
}

#[derive(Debug, Serialize)]
struct RankedDriver {
    driver_id: i64,
    name: Option<String>,
    tier: String,
    dispatch_mode: String,
    score: f64,
    estimated_pickup_km: f64,
    compensation_multiplier: f64,
    cherry_pick_risk: String,
    reason: String,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    service: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct RoutePlanRequest {
    work_order_id: String,
    created_by: Option<i32>,
}

#[derive(Debug, Clone)]
struct RouteStopInput {
    id: String,
    sequence_no: i32,
    stop_kind: String,
    latitude: f64,
    longitude: f64,
}

#[derive(Debug, Serialize)]
struct RoutePlanStopResponse {
    work_order_stop_id: String,
    stop_kind: String,
    visit_sequence: i32,
    leg_distance_m: f64,
    estimated_arrival_offset_s: i32,
}

#[derive(Debug, Serialize)]
struct RoutePlanResponse {
    route_plan_id: String,
    work_order_id: String,
    plan_version: i32,
    algorithm_version: String,
    total_distance_m: f64,
    stops: Vec<RoutePlanStopResponse>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(Level::INFO)
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
        .unwrap_or_else(|error| panic!("failed to initialize dispatch connection pool: {error}"));
    if let Err(error) = ensure_schema(&database).await {
        panic!("failed to initialize dispatch optimizer schema: {error}");
    }

    let state = Arc::new(AppState {
        service_name: "switchos-dispatch-optimizer".to_string(),
        database,
        internal_service_token,
        request_sequence: Arc::new(AtomicUsize::new(1)),
    });
    let protected_routes = Router::new()
        .route("/optimize", post(optimize_dispatch))
        .route("/trip-radar", post(trip_radar))
        .route("/batch-orders", post(batch_orders))
        .route("/eta", post(estimate_eta))
        .route("/voice-priority", post(voice_priority))
        .route("/instant-retail-allocation", post(instant_retail_allocation))
        .route("/supply-shock-rebalance", post(supply_shock_rebalance))
        .route("/operations/route-plans", post(create_route_plan))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_internal_access_middleware));
    metrics::init("switchos-dispatch-optimizer");
    let app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics::handler))
        .merge(protected_routes)
        .layer(middleware::from_fn(metrics::track))
        .layer(middleware::from_fn_with_state(state.clone(), correlation_middleware))
        .with_state(state);

    let bind_host = std::env::var("BIND_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let addr: SocketAddr = std::env::var("PORT")
        .ok()
        .and_then(|port| format!("{}:{}", bind_host, port).parse().ok())
        .unwrap_or_else(|| "127.0.0.1:8090".parse().expect("valid default addr"));

    info!("dispatch optimizer listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind listener");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("serve application");
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
    let sequence = state.request_sequence.fetch_add(1, AtomicOrdering::Relaxed);
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
        Err((status, message)) => (status, message).into_response(),
    }
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match acquire_client(&state.database).await {
        Ok(client) if client.query_one("SELECT 1", &[]).await.is_ok() => (
            StatusCode::OK,
            Json(HealthResponse {
                status: "healthy".to_string(),
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

async fn optimize_dispatch(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut request): Json<DispatchRequest>,
) -> Result<Json<DispatchResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;
    let client = acquire_client(&state.database).await?;

    if request.drivers.is_empty() {
        request.drivers = load_candidate_drivers(&client).await?;
    }
    if request.drivers.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one driver is required".to_string()));
    }

    let demand = match request.demand_level {
        Some(value) => value.max(0.1),
        None => load_open_demand(&client).await?.max(0.1),
    };
    let supply = match request.supply_level {
        Some(value) => value.max(0.1),
        None => load_available_supply(&client).await?.max(0.1),
    };
    let ratio = demand / supply;
    let long_trip_minutes = request.long_trip_minutes.unwrap_or(estimate_long_trip_from_db(&client, request.order_id).await?);
    let multi_stop = request.multi_stop.unwrap_or(order_has_complexity(&client, request.order_id).await?);

    let trip_mode = request.trip_mode.clone().unwrap_or_else(|| {
        if long_trip_minutes >= 60.0 {
            "long_haul".to_string()
        } else {
            "standard".to_string()
        }
    });
    let priority_level = request.priority_level.clone().unwrap_or_else(|| "standard".to_string());

    let strategy = if ratio > 1.25 || long_trip_minutes >= 60.0 || trip_mode == "long_haul" {
        "broadcast_trip_radar"
    } else if priority_level == "vip" || priority_level == "urgent" {
        "priority_direct_assignment"
    } else {
        "direct_assignment"
    };

    let surge_multiplier = if ratio > 2.0 {
        1.6
    } else if ratio > 1.5 {
        1.35
    } else if ratio > 1.15 {
        1.15
    } else {
        1.0
    };

    let long_trip_premium = if long_trip_minutes >= 90.0 {
        0.2
    } else if long_trip_minutes >= 60.0 {
        0.12
    } else {
        0.0
    };

    let multi_stop_surcharge = if multi_stop { 0.15 } else { 0.0 };

    let mut ranked: Vec<RankedDriver> = request
        .drivers
        .iter()
        .filter(|driver| !driver.on_trip.unwrap_or(false))
        .map(|driver| {
            score_driver(
                driver,
                strategy,
                &trip_mode,
                surge_multiplier,
                long_trip_premium,
                multi_stop_surcharge,
                &priority_level,
            )
        })
        .collect();

    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    let recommended = ranked.first();

    let response = DispatchResponse {
        strategy: strategy.to_string(),
        supply_demand_ratio: round2(ratio),
        surge_multiplier,
        long_trip_premium,
        multi_stop_surcharge,
        recommended_driver_id: recommended.map(|d| d.driver_id),
        recommended_driver_name: recommended.and_then(|d| d.name.clone()),
        ranked_candidates: ranked,
    };

    persist_run(&client, "optimize", &request, &response, request.order_id).await?;
    Ok(Json(response))
}

async fn trip_radar(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut request): Json<TripRadarRequest>,
) -> Result<Json<TripRadarResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;
    let client = acquire_client(&state.database).await?;

    if request.orders.is_empty() {
        request.orders = load_trip_radar_orders(&client).await?;
    }
    if request.orders.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one order is required".to_string()));
    }

    let supply = load_available_supply(&client).await?.max(0.1);
    let request_snapshot = request.orders.clone();
    let highlighted_orders = request
        .orders
        .into_iter()
        .map(|order| {
            let demand = order.demand_level.unwrap_or(1.0).max(0.1);
            let ratio = demand / order.supply_level.unwrap_or(supply).max(0.1);
            let long_trip = order.long_trip_minutes.unwrap_or(0.0) >= 60.0;
            let multi_stop = order.multi_stop.unwrap_or(false);
            let publish_to_radar = ratio > 1.2 || long_trip || multi_stop;
            let payout_multiplier: f64 = 1.0_f64
                + if ratio > 1.5 {
                    0.18_f64
                } else if ratio > 1.15 {
                    0.1_f64
                } else {
                    0.0_f64
                }
                + if long_trip { 0.12_f64 } else { 0.0_f64 }
                + if multi_stop { 0.15_f64 } else { 0.0_f64 };
            let trip_mode = if long_trip {
                "long_haul"
            } else if multi_stop {
                "multi_stop"
            } else {
                "standard"
            };
            TripRadarOrderResponse {
                order_id: order.order_id,
                trip_mode: trip_mode.to_string(),
                publish_to_radar,
                payout_multiplier: round2(payout_multiplier),
                reason: "Trips with constrained supply, long travel time, or multi-stop complexity benefit from radar-style marketplace exposure.".to_string(),
            }
        })
        .collect::<Vec<_>>();

    let response = TripRadarResponse {
        strategy: "trip_radar_marketplace_dispatch".to_string(),
        highlighted_orders,
    };
    persist_run(&client, "trip_radar", &TripRadarRequest { orders: request_snapshot }, &response, None).await?;
    Ok(Json(response))
}

async fn batch_orders(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut request): Json<BatchRequest>,
) -> Result<Json<BatchResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;
    let client = acquire_client(&state.database).await?;

    if request.orders.is_empty() {
        request.orders = load_batchable_orders(&client).await?;
    }
    if request.orders.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one order is required".to_string()));
    }

    let max_batch_distance = request.max_batch_distance_km.unwrap_or(8.0).max(1.0);
    let max_batch_size = request.max_batch_size.unwrap_or(3).max(1) as usize;
    let request_snapshot = request.orders.clone();
    let mut orders = request.orders;
    orders.sort_by(|a, b| {
        let zone_a = a.zone_key.clone().unwrap_or_else(|| "default".to_string());
        let zone_b = b.zone_key.clone().unwrap_or_else(|| "default".to_string());
        zone_a
            .cmp(&zone_b)
            .then_with(|| a.distance_km.partial_cmp(&b.distance_km).unwrap_or(Ordering::Equal))
    });

    let mut recommendations = Vec::new();
    let mut unbatched = Vec::new();
    let mut current: Vec<BatchOrder> = Vec::new();

    for order in orders.into_iter() {
        let regulated = order.regulated_items.unwrap_or(false);
        if regulated {
            unbatched.push(order.order_id);
            continue;
        }

        let current_zone = current
            .first()
            .and_then(|item| item.zone_key.clone())
            .unwrap_or_else(|| order.zone_key.clone().unwrap_or_else(|| "default".to_string()));
        let order_zone = order.zone_key.clone().unwrap_or_else(|| "default".to_string());
        let projected_distance: f64 = current.iter().map(|item| item.distance_km).sum::<f64>() + order.distance_km;

        let should_flush = !current.is_empty()
            && (current.len() >= max_batch_size || current_zone != order_zone || projected_distance > max_batch_distance);

        if should_flush {
            recommendations.push(build_batch_recommendation(&current, recommendations.len() + 1));
            current.clear();
        }

        current.push(order);
    }

    if !current.is_empty() {
        if current.len() > 1 {
            recommendations.push(build_batch_recommendation(&current, recommendations.len() + 1));
        } else if let Some(order) = current.first() {
            unbatched.push(order.order_id);
        }
    }

    let response = BatchResponse {
        strategy: "same_zone_batching".to_string(),
        recommended_batches: recommendations,
        unbatched_order_ids: unbatched,
    };
    persist_run(&client, "batch_orders", &BatchRequest { orders: request_snapshot, max_batch_distance_km: request.max_batch_distance_km, max_batch_size: request.max_batch_size }, &response, None).await?;
    Ok(Json(response))
}

async fn voice_priority(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<VoicePriorityRequest>,
) -> Result<Json<VoicePriorityResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;

    let active_calls = request.active_calls.unwrap_or(0.0).max(0.0);
    let staffed_lines = request.staffed_lines.unwrap_or(1.0).max(1.0);
    let substitution_cases = request.substitution_cases.unwrap_or(0.0).max(0.0);
    let lifetime_orders = request.lifetime_orders.unwrap_or(0.0).max(0.0);
    let substitution_risk = request.substitution_risk.unwrap_or_else(|| "low".to_string()).to_lowercase();

    let queue_pressure = active_calls / staffed_lines;
    let repeat_value = if lifetime_orders >= 20.0 {
        10.0
    } else if lifetime_orders >= 8.0 {
        6.0
    } else if lifetime_orders >= 3.0 {
        3.0
    } else {
        0.0
    };
    let substitution_penalty = if substitution_risk == "high" {
        18.0
    } else if substitution_risk == "medium" {
        9.0
    } else {
        0.0
    };

    let mut score = 35.0 + (queue_pressure * 18.0) + (substitution_cases * 4.5) + repeat_value + substitution_penalty;
    if score > 100.0 {
        score = 100.0;
    }

    let band = if score >= 82.0 {
        "urgent"
    } else if score >= 60.0 {
        "priority"
    } else {
        "standard"
    };

    let reason = if band == "urgent" {
        "Voice queue pressure and substitution sensitivity justify callback priority or rapid human takeover."
    } else if band == "priority" {
        "Voice session should stay near the front of the queue because repeat-order value or substitution complexity is material."
    } else {
        "Voice session can remain in the standard queue because current friction signals are limited."
    };

    Ok(Json(VoicePriorityResponse {
        band: band.to_string(),
        score: round2(score),
        reason: reason.to_string(),
    }))
}

async fn supply_shock_rebalance(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<SupplyShockRebalanceRequest>,
) -> Result<Json<SupplyShockRebalanceResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;
    let client = acquire_client(&state.database).await?;
    let started_at = std::time::Instant::now();
    let trace_id = headers
        .get("x-trace-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            format!("ssr-{}", millis)
        });

    if request.zones.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one zone is required".to_string()));
    }

    let mut ranked = request
        .zones
        .iter()
        .map(|zone| {
            let demand_supply_gap = zone.open_orders / zone.online_drivers.max(1.0);
            let eta_penalty = zone.avg_eta_minutes / 30.0;
            let fill_penalty = (1.0 - zone.warehouse_fill_rate.clamp(0.0, 1.0)) * 2.0;
            let cold_chain_penalty = if zone.cold_chain_gap.unwrap_or(false) { 0.8 } else { 0.0 };
            let pressure_score = round2((demand_supply_gap * 2.8) + eta_penalty + fill_penalty + cold_chain_penalty);
            let action = if pressure_score >= 5.5 {
                "surge_rebalance_and_inventory_pull"
            } else if pressure_score >= 3.5 {
                "driver_shift_and_eta_protection"
            } else {
                "watch_and_hold"
            };
            let recommended_driver_shift = if pressure_score >= 5.5 {
                4
            } else if pressure_score >= 3.5 {
                2
            } else {
                0
            };
            let recommended_inventory_shift_units = if zone.warehouse_fill_rate < 0.75 {
                18
            } else if zone.warehouse_fill_rate < 0.88 {
                8
            } else {
                0
            };
            SupplyShockZoneRecommendation {
                zone_key: zone.zone_key.clone(),
                pressure_score,
                action: action.to_string(),
                recommended_driver_shift,
                recommended_inventory_shift_units,
                reason: format!(
                    "{} has {:.1} open orders per online driver, {:.0} minute ETA pressure, and {:.0}% warehouse fill.",
                    zone.zone_key,
                    demand_supply_gap,
                    zone.avg_eta_minutes,
                    zone.warehouse_fill_rate.clamp(0.0, 1.0) * 100.0
                ),
            }
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|a, b| b.pressure_score.partial_cmp(&a.pressure_score).unwrap_or(Ordering::Equal));
    let response = SupplyShockRebalanceResponse {
        strategy: "zone_pressure_rebalance".to_string(),
        shock_type: request.shock_type.clone().unwrap_or_else(|| "demand_spike".to_string()),
        city: request.city.clone(),
        highest_risk_zone: ranked.first().map(|item| item.zone_key.clone()),
        recommendations: ranked,
        metrics: ResponseMetrics {
            trace_id,
            duration_ms: round2(started_at.elapsed().as_secs_f64() * 1000.0),
            payload: serde_json::json!({
                "zone_count": request.zones.len(),
                "priority_level": request.priority_level,
            }),
        },
    };

    persist_run(&client, "supply_shock_rebalance", &request, &response, None).await?;
    Ok(Json(response))
}

async fn instant_retail_allocation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<InstantRetailAllocationRequest>,
) -> Result<Json<InstantRetailAllocationResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;
    let started_at = std::time::Instant::now();
    let trace_id = headers
        .get("x-trace-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            format!("iro-{}", millis)
        });

    if request.items.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one retail item is required".to_string()));
    }
    if request.warehouses.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one warehouse candidate is required".to_string()));
    }

    let cold_chain_required = request.cold_chain_required.unwrap_or(false);
    let priority_level = request.priority_level.unwrap_or_else(|| "standard".to_string()).to_lowercase();

    let mut ranked = request
        .warehouses
        .iter()
        .map(|warehouse| {
            let requested_units: f64 = request.items.iter().map(|item| item.quantity.max(0.0)).sum();
            let fulfilled_units: f64 = request
                .items
                .iter()
                .map(|item| {
                    warehouse
                        .available_inventory
                        .iter()
                        .find(|inventory| inventory.sku == item.sku)
                        .map(|inventory| inventory.available_units.min(item.quantity.max(0.0)))
                        .unwrap_or(0.0)
                })
                .sum();
            let fill_rate = if requested_units > 0.0 {
                (fulfilled_units / requested_units).clamp(0.0, 1.0)
            } else {
                1.0
            };
            let pick_pack = warehouse.pick_pack_minutes.unwrap_or(8.0).max(2.0);
            let cold_chain_ready = warehouse.cold_chain_ready.unwrap_or(false);
            let stock_accuracy = warehouse.stock_accuracy.unwrap_or(0.92).clamp(0.4, 1.0);
            let distance_penalty = (warehouse.distance_km / 16.0).clamp(0.0, 0.4);
            let speed_score = (1.0 / (1.0 + (pick_pack + warehouse.distance_km * 3.1) / 30.0)).clamp(0.2, 1.0);
            let cold_chain_penalty = if cold_chain_required && !cold_chain_ready { 0.35 } else { 0.0 };
            let priority_boost = if priority_level == "urgent" || priority_level == "vip" { 1.08 } else { 1.0 };
            let score = (((fill_rate * 0.55) + (speed_score * 0.2) + (stock_accuracy * 0.15) + if cold_chain_ready { 0.1 } else { 0.0 }) * priority_boost - distance_penalty - cold_chain_penalty)
                .clamp(0.0, 1.2)
                * 100.0;
            let estimated_ready = (pick_pack + (warehouse.distance_km * 3.1)).round().clamp(5.0, 120.0) as u32;
            let reason = if fill_rate >= 0.98 && (!cold_chain_required || cold_chain_ready) {
                format!("Full-fill candidate with {:.0}% stock accuracy and {} minute ready time.", stock_accuracy * 100.0, estimated_ready)
            } else if cold_chain_required && !cold_chain_ready {
                "Candidate lacks cold-chain readiness for chilled or regulated inventory.".to_string()
            } else {
                format!("Can fulfill {:.0}% of the basket with {} minute ready time; substitutions or split shipment may be required.", fill_rate * 100.0, estimated_ready)
            };

            WarehouseAllocationScore {
                warehouse_id: warehouse.warehouse_id,
                label: warehouse.label.clone(),
                zone_key: warehouse.zone_key.clone().unwrap_or_else(|| "unknown".to_string()),
                score: round2(score),
                fill_rate: round2(fill_rate),
                estimated_ready_minutes: estimated_ready,
                cold_chain_ready,
                reason,
            }
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|left, right| right.score.partial_cmp(&left.score).unwrap_or(Ordering::Equal));
    let winner = ranked.first();
    let suggested_substitutions = request
        .items
        .iter()
        .filter(|item| {
            winner
                .and_then(|selected| request.warehouses.iter().find(|warehouse| warehouse.warehouse_id == selected.warehouse_id))
                .and_then(|warehouse| warehouse.available_inventory.iter().find(|inventory| inventory.sku == item.sku))
                .map(|inventory| inventory.available_units + 0.01 < item.quantity)
                .unwrap_or(true)
        })
        .map(|item| item.substitution_group.clone().unwrap_or_else(|| format!("{} substitute", item.sku)))
        .collect::<Vec<_>>();
    let split_required = winner.map(|selected| selected.fill_rate < 0.95).unwrap_or(true) && request.warehouses.len() > 1;

    let duration_ms = started_at.elapsed().as_secs_f64() * 1000.0;
    info!(trace_id = %trace_id, duration_ms = duration_ms, items = request.items.len(), warehouses = request.warehouses.len(), "instant retail allocation completed");

    Ok(Json(InstantRetailAllocationResponse {
        strategy: if cold_chain_required { "cold_chain_nearest_full_fill".to_string() } else { "fastest_full_fill".to_string() },
        selected_warehouse_id: winner.map(|selected| selected.warehouse_id),
        selected_warehouse_label: winner.map(|selected| selected.label.clone()),
        fill_rate: winner.map(|selected| selected.fill_rate).unwrap_or(0.0),
        estimated_ready_minutes: winner.map(|selected| selected.estimated_ready_minutes).unwrap_or(0),
        split_shipment_required: split_required,
        suggested_substitutions,
        rationale: winner
            .map(|selected| format!("Selected {} in {} with {:.0}% fill and {} minute ready time.", selected.label, selected.zone_key, selected.fill_rate * 100.0, selected.estimated_ready_minutes))
            .unwrap_or_else(|| "No warehouse candidate could be selected.".to_string()),
        ranked_warehouses: ranked,
        metrics: ResponseMetrics {
            trace_id,
            duration_ms: round2(duration_ms),
            payload: serde_json::json!({
                "item_count": request.items.len(),
                "warehouse_count": request.warehouses.len(),
                "cold_chain_required": cold_chain_required,
            }),
        },
    }))
}

async fn estimate_eta(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<EtaRequest>,
) -> Result<Json<EtaResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;
    let client = acquire_client(&state.database).await?;

    if request.distance_km < 0.0 || request.merchant_prep_minutes < 0.0 {
        return Err((StatusCode::BAD_REQUEST, "invalid eta request".to_string()));
    }

    let historical_driver_eta = load_recent_driver_eta(&client).await?.unwrap_or(7.0);
    let driver_eta = request.driver_eta_minutes.unwrap_or(historical_driver_eta).max(0.0);
    let stack_count = request.stacked_orders.unwrap_or(1).max(1);
    let batching_delay = if stack_count > 1 { (stack_count - 1) * 6 } else { 0 };
    let weather_delay = match request.weather_condition.as_deref() {
        Some("rain") => 4,
        Some("storm") => 8,
        _ => 0,
    };
    let priority_credit = if request.priority_delivery.unwrap_or(false) { 5 } else { 0 };

    let travel_minutes = (request.distance_km * 4.2).round() as u32;
    let base_eta = request.merchant_prep_minutes.round() as u32
        + driver_eta.round() as u32
        + travel_minutes
        + batching_delay
        + weather_delay;
    let eta_minutes = base_eta.saturating_sub(priority_credit).max(12);
    let confidence_band = if weather_delay >= 8 || stack_count >= 3 {
        "moderate"
    } else {
        "high"
    };

    let response = EtaResponse {
        eta_minutes,
        confidence_band: confidence_band.to_string(),
        batching_delay_minutes: batching_delay,
        dispatch_ready_in_minutes: (request.merchant_prep_minutes.round() as u32).max(driver_eta.round() as u32),
        customer_message: "ETA reflects merchant prep, courier approach time, distance, batching load, and weather pressure.".to_string(),
    };
    persist_run(&client, "eta", &request, &response, None).await?;
    Ok(Json(response))
}

fn build_batch_recommendation(orders: &[BatchOrder], sequence: usize) -> BatchRecommendation {
    let zone_key = orders
        .first()
        .and_then(|item| item.zone_key.clone())
        .unwrap_or_else(|| "default".to_string());
    let total_distance_km = orders.iter().map(|item| item.distance_km).sum::<f64>();
    let has_priority = orders
        .iter()
        .any(|item| matches!(item.priority_level.as_deref(), Some("vip") | Some("urgent")));
    BatchRecommendation {
        batch_id: format!("batch-{}-{}", zone_key, sequence),
        zone_key,
        order_ids: orders.iter().map(|item| item.order_id).collect(),
        total_distance_km: round2(total_distance_km),
        fulfillment_mode: if has_priority {
            "priority_sequenced_batch".to_string()
        } else {
            "standard_batch".to_string()
        },
        priority_band: if has_priority { "priority".to_string() } else { "standard".to_string() },
        reason: "Orders sharing geography and non-regulated constraints can be grouped to improve courier utilization without violating handling rules.".to_string(),
    }
}

fn score_driver(
    driver: &DriverInput,
    strategy: &str,
    trip_mode: &str,
    surge_multiplier: f64,
    long_trip_premium: f64,
    multi_stop_surcharge: f64,
    priority_level: &str,
) -> RankedDriver {
    let tier = driver.tier.clone().unwrap_or_else(|| "bronze".to_string()).to_lowercase();
    let tier_bonus = match tier.as_str() {
        "platinum" => 18.0,
        "gold" => 12.0,
        "silver" => 6.0,
        _ => 0.0,
    };
    let acceptance = driver.acceptance_rate.unwrap_or(70.0).clamp(0.0, 100.0);
    let completion = driver.completion_rate.unwrap_or(85.0).clamp(0.0, 100.0);
    let utilization = driver.utilization_rate.unwrap_or(65.0).clamp(0.0, 100.0);
    let distance = driver.distance_km.unwrap_or(10.0).max(0.1);
    let idle = driver.idle_minutes.unwrap_or(0.0).max(0.0);
    let rejections = driver.recent_rejections.unwrap_or(0).max(0) as f64;

    let proximity_score = (35.0 - (distance * 4.0)).max(0.0);
    let reliability_score = acceptance * 0.22 + completion * 0.28;
    let utilization_score = if utilization < 45.0 {
        12.0
    } else if utilization < 70.0 {
        7.0
    } else {
        2.0
    };
    let idle_bonus = (idle / 3.0).min(8.0);
    let rejection_penalty = rejections * 4.0;
    let priority_bonus = if priority_level == "vip" || priority_level == "urgent" { 7.0 } else { 0.0 };

    let mode_bonus = if strategy == "broadcast_trip_radar" {
        tier_bonus + idle_bonus + if trip_mode == "long_haul" { 6.0 } else { 0.0 }
    } else {
        proximity_score + tier_bonus * 0.5 + priority_bonus
    };

    let total_score = (reliability_score + utilization_score + mode_bonus - rejection_penalty).max(0.0);
    let compensation_multiplier = 1.0 + ((surge_multiplier - 1.0) + long_trip_premium + multi_stop_surcharge).max(0.0);

    let cherry_pick_risk = if acceptance < 45.0 || utilization < 35.0 || rejections >= 3.0 {
        "high"
    } else if acceptance < 70.0 || utilization < 55.0 {
        "medium"
    } else {
        "low"
    };

    let reason = format!(
        "tier={} acceptance={:.1}% completion={:.1}% distance={:.1}km utilization={:.1}% strategy={} trip_mode={} priority={}",
        tier, acceptance, completion, distance, utilization, strategy, trip_mode, priority_level
    );

    RankedDriver {
        driver_id: driver.driver_id,
        name: driver.name.clone(),
        tier,
        dispatch_mode: strategy.to_string(),
        score: round2(total_score),
        estimated_pickup_km: distance,
        compensation_multiplier: round2(compensation_multiplier),
        cherry_pick_risk: cherry_pick_risk.to_string(),
        reason,
    }
}

async fn create_route_plan(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<RoutePlanRequest>,
) -> Result<Json<RoutePlanResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;
    if !canonical_uuid(&request.work_order_id) {
        return Err((StatusCode::BAD_REQUEST, "work_order_id must be a canonical UUID".to_string()));
    }
    let client = acquire_client(&state.database).await?;
    let order = client
        .query_opt(
            "SELECT tenant_id, state::text FROM operations.work_order WHERE id = ($1::text)::uuid",
            &[&request.work_order_id],
        )
        .await
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "work order not found".to_string()))?;
    let state_name: String = order.get("state");
    if !matches!(state_name.as_str(), "queued" | "allocated" | "in_progress") {
        return Err((StatusCode::CONFLICT, "work order is not eligible for route planning".to_string()));
    }
    let tenant_id: String = order.get("tenant_id");
    let rows = client
        .query(
            "SELECT id::text, sequence_no, stop_kind::text, ST_Y(location::geometry)::float8 AS latitude, ST_X(location::geometry)::float8 AS longitude FROM operations.work_order_stop WHERE work_order_id = ($1::text)::uuid AND completed_at IS NULL ORDER BY sequence_no",
            &[&request.work_order_id],
        )
        .await
        .map_err(internal_error)?;
    let stops: Vec<RouteStopInput> = rows
        .into_iter()
        .map(|row| RouteStopInput {
            id: row.get("id"),
            sequence_no: row.get("sequence_no"),
            stop_kind: row.get("stop_kind"),
            latitude: row.get("latitude"),
            longitude: row.get("longitude"),
        })
        .collect();
    if stops.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "work order requires at least one incomplete stop".to_string()));
    }
    let planned_stops = plan_route_stops(stops)?;
    let total_distance_m = planned_stops.iter().map(|stop| stop.leg_distance_m).sum::<f64>();
    let snapshot = serde_json::json!({
        "algorithm": "independent_nearest_neighbor_pickup_safe",
        "algorithm_version": "v1",
        "stop_count": planned_stops.len(),
        "total_distance_m": round2(total_distance_m),
        "source": "operations.work_order_stop",
    });
    let mut persisted = None;
    for _ in 0..3 {
        let row = client
            .query_opt(
                "WITH next_version AS (SELECT COALESCE(MAX(plan_version), 0) + 1 AS value FROM operations.route_plan WHERE work_order_id = ($1::text)::uuid) INSERT INTO operations.route_plan (tenant_id, work_order_id, plan_version, algorithm_version, state, total_distance_m, planning_snapshot, created_by) SELECT $2, ($1::text)::uuid, next_version.value, 'independent_nearest_neighbor_pickup_safe_v1', 'planned', $3::float8, $4::jsonb, $5 FROM next_version ON CONFLICT (work_order_id, plan_version) DO NOTHING RETURNING id::text, plan_version",
                &[&request.work_order_id, &tenant_id, &total_distance_m, &snapshot, &request.created_by],
            )
            .await
            .map_err(internal_error)?;
        if let Some(row) = row {
            persisted = Some((row.get::<_, String>("id"), row.get::<_, i32>("plan_version")));
            break;
        }
    }
    let (route_plan_id, plan_version) = persisted.ok_or_else(|| (StatusCode::CONFLICT, "route plan contention; retry request".to_string()))?;
    for stop in &planned_stops {
        client
            .execute(
                "INSERT INTO operations.route_plan_stop (route_plan_id, work_order_stop_id, visit_sequence, leg_distance_m, estimated_arrival_offset_s) VALUES (($1::text)::uuid, ($2::text)::uuid, $3, $4::float8, $5)",
                &[&route_plan_id, &stop.work_order_stop_id, &stop.visit_sequence, &stop.leg_distance_m, &stop.estimated_arrival_offset_s],
            )
            .await
            .map_err(internal_error)?;
    }
    client
        .execute(
            "UPDATE operations.route_plan SET state = 'superseded' WHERE work_order_id = ($1::text)::uuid AND id <> ($2::text)::uuid AND state = 'planned'",
            &[&request.work_order_id, &route_plan_id],
        )
        .await
        .map_err(internal_error)?;
    Ok(Json(RoutePlanResponse {
        route_plan_id,
        work_order_id: request.work_order_id,
        plan_version,
        algorithm_version: "independent_nearest_neighbor_pickup_safe_v1".to_string(),
        total_distance_m: round2(total_distance_m),
        stops: planned_stops,
    }))
}

fn plan_route_stops(stops: Vec<RouteStopInput>) -> Result<Vec<RoutePlanStopResponse>, (StatusCode, String)> {
    let mut remaining = stops;
    let mut selected: Option<RouteStopInput> = None;
    let mut output = Vec::new();
    let mut elapsed_seconds = 0i32;
    while !remaining.is_empty() {
        let pickup_remaining = remaining.iter().any(|stop| stop.stop_kind == "pickup");
        let candidate_index = if let Some(previous) = selected.as_ref() {
            remaining
                .iter()
                .enumerate()
                .filter(|(_, stop)| !pickup_remaining || stop.stop_kind == "pickup")
                .min_by(|(_, left), (_, right)| {
                    haversine_m(previous.latitude, previous.longitude, left.latitude, left.longitude)
                        .partial_cmp(&haversine_m(previous.latitude, previous.longitude, right.latitude, right.longitude))
                        .unwrap_or(Ordering::Equal)
                        .then_with(|| left.sequence_no.cmp(&right.sequence_no))
                })
                .map(|(index, _)| index)
                .ok_or_else(|| internal_error("no pickup-safe route candidate"))?
        } else {
            remaining
                .iter()
                .enumerate()
                .filter(|(_, stop)| !pickup_remaining || stop.stop_kind == "pickup")
                .min_by_key(|(_, stop)| stop.sequence_no)
                .map(|(index, _)| index)
                .ok_or_else(|| internal_error("no initial route candidate"))?
        };
        let next = remaining.remove(candidate_index);
        let leg_distance_m = selected
            .as_ref()
            .map(|previous| haversine_m(previous.latitude, previous.longitude, next.latitude, next.longitude))
            .unwrap_or(0.0);
        elapsed_seconds = elapsed_seconds.saturating_add((leg_distance_m / 8.0).ceil() as i32);
        output.push(RoutePlanStopResponse {
            work_order_stop_id: next.id.clone(),
            stop_kind: next.stop_kind.clone(),
            visit_sequence: output.len() as i32 + 1,
            leg_distance_m: round2(leg_distance_m),
            estimated_arrival_offset_s: elapsed_seconds,
        });
        selected = Some(next);
    }
    Ok(output)
}

fn haversine_m(latitude_a: f64, longitude_a: f64, latitude_b: f64, longitude_b: f64) -> f64 {
    let earth_radius_m = 6_371_008.8_f64;
    let d_lat = (latitude_b - latitude_a).to_radians();
    let d_lng = (longitude_b - longitude_a).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + latitude_a.to_radians().cos() * latitude_b.to_radians().cos() * (d_lng / 2.0).sin().powi(2);
    earth_radius_m * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, character)| {
            if [8, 13, 18, 23].contains(&index) { character == '-' } else { character.is_ascii_hexdigit() }
        })
}

async fn connect_client(database_url: &str) -> Result<Client, String> {
    let (client, connection) = tokio_postgres::connect(database_url, NoTls)
        .await
        .map_err(|error| format!("connect postgres: {error}"))?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            tracing::error!("dispatch optimizer pooled postgres connection error: {}", error);
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
            .map_err(|error| format!("open dispatch database connection {slot}: {error}"))?;
        slots.push(tokio::sync::RwLock::new(Arc::new(client)));
    }
    Ok(DatabasePool {
        slots: Arc::new(slots),
        next: Arc::new(AtomicUsize::new(0)),
        database_url: Arc::new(database_url.to_string()),
    })
}

async fn acquire_client(pool: &DatabasePool) -> Result<Arc<Client>, (StatusCode, String)> {
    if pool.slots.is_empty() {
        return Err(internal_error("database pool unavailable"));
    }
    let len = pool.slots.len();
    let start = pool.next.fetch_add(1, AtomicOrdering::Relaxed) % len;
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
                tracing::info!("dispatch optimizer re-established a postgres pool connection");
                return Ok(client);
            }
            Err(error) => {
                tracing::warn!("dispatch optimizer postgres reconnect failed: {}", error);
            }
        }
    }
    Err(internal_error("database pool unavailable"))
}

async fn ensure_schema(pool: &DatabasePool) -> Result<(), String> {
    let client = acquire_client(pool).await.map_err(|(_, message)| message)?;
    client
        .batch_execute(
            r#"
            CREATE TABLE IF NOT EXISTS dispatch_optimizer_runs (
                id BIGSERIAL PRIMARY KEY,
                endpoint TEXT NOT NULL,
                order_id BIGINT,
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

fn require_internal_access(headers: &HeaderMap, state: &AppState) -> Result<(), (StatusCode, String)> {
    let provided = headers
        .get("x-internal-service-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim();
    if subtle_equal(provided, &state.internal_service_token) {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "unauthorized".to_string()))
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

async fn load_candidate_drivers(client: &Client) -> Result<Vec<DriverInput>, (StatusCode, String)> {
    let rows = client
        .query(
            r#"
            SELECT
                id,
                name,
                COALESCE(acceptance_rate::float8, 80.0) AS acceptance_rate,
                COALESCE(completion_rate::float8, 95.0) AS completion_rate,
                CASE
                    WHEN COALESCE(active_orders, 0) >= 3 THEN 90.0
                    WHEN COALESCE(active_orders, 0) >= 1 THEN 60.0
                    ELSE 30.0
                END::float8 AS utilization_rate,
                CASE
                    WHEN current_location ILIKE '%airport%' THEN 3.0
                    WHEN current_location IS NOT NULL AND current_location <> '' THEN 6.0
                    ELSE 10.0
                END::float8 AS distance_km,
                CASE
                    WHEN COALESCE(active_orders, 0) = 0 THEN 18.0
                    ELSE 4.0
                END::float8 AS idle_minutes,
                0 AS recent_rejections,
                CASE WHEN availability = 'available' AND status = 'online' THEN false ELSE true END AS on_trip,
                CASE
                    WHEN rating::float8 >= 4.85 THEN 'platinum'
                    WHEN rating::float8 >= 4.7 THEN 'gold'
                    WHEN rating::float8 >= 4.5 THEN 'silver'
                    ELSE 'bronze'
                END AS tier
            FROM drivers
            WHERE status = 'online'
            ORDER BY rating::float8 DESC NULLS LAST, completed_deliveries DESC NULLS LAST
            LIMIT 50
            "#,
            &[],
        )
        .await
        .map_err(internal_error)?;

    Ok(rows
        .into_iter()
        .map(|row| DriverInput {
            driver_id: i64::from(row.get::<_, i32>("id")),
            name: Some(row.get::<_, String>("name")),
            tier: Some(row.get::<_, String>("tier")),
            acceptance_rate: Some(row.get::<_, f64>("acceptance_rate")),
            completion_rate: Some(row.get::<_, f64>("completion_rate")),
            utilization_rate: Some(row.get::<_, f64>("utilization_rate")),
            distance_km: Some(row.get::<_, f64>("distance_km")),
            idle_minutes: Some(row.get::<_, f64>("idle_minutes")),
            recent_rejections: Some(row.get::<_, i32>("recent_rejections")),
            on_trip: Some(row.get::<_, bool>("on_trip")),
        })
        .collect())
}

async fn load_open_demand(client: &Client) -> Result<f64, (StatusCode, String)> {
    let row = client
        .query_one(
            "SELECT COUNT(*)::float8 AS count FROM orders WHERE status IN ('pending', 'confirmed', 'assigned', 'picked_up', 'in_transit')",
            &[],
        )
        .await
        .map_err(internal_error)?;
    Ok(row.get::<_, f64>("count").max(1.0))
}

async fn load_available_supply(client: &Client) -> Result<f64, (StatusCode, String)> {
    let row = client
        .query_one(
            "SELECT COUNT(*)::float8 AS count FROM drivers WHERE status = 'online' AND COALESCE(availability, 'available') = 'available'",
            &[],
        )
        .await
        .map_err(internal_error)?;
    Ok(row.get::<_, f64>("count").max(1.0))
}

async fn estimate_long_trip_from_db(client: &Client, order_id: Option<i64>) -> Result<f64, (StatusCode, String)> {
    let Some(order_id) = order_id else {
        return Ok(0.0);
    };
    let row = client
        .query_opt(
            "SELECT pickup_address, delivery_address FROM orders WHERE id = $1",
            &[&order_id],
        )
        .await
        .map_err(internal_error)?;
    if let Some(row) = row {
        let pickup: Option<String> = row.get("pickup_address");
        let delivery: Option<String> = row.get("delivery_address");
        let trip_complexity = pickup.unwrap_or_default().len() as f64 + delivery.unwrap_or_default().len() as f64;
        if trip_complexity > 120.0 {
            return Ok(70.0);
        }
        if trip_complexity > 60.0 {
            return Ok(42.0);
        }
    }
    Ok(0.0)
}

async fn order_has_complexity(client: &Client, order_id: Option<i64>) -> Result<bool, (StatusCode, String)> {
    let Some(order_id) = order_id else {
        return Ok(false);
    };
    let row = client
        .query_opt("SELECT notes FROM orders WHERE id = $1", &[&order_id])
        .await
        .map_err(internal_error)?;
    Ok(row
        .and_then(|row| row.get::<_, Option<String>>("notes"))
        .map(|notes| {
            let normalized = notes.to_lowercase();
            normalized.contains("multi") || normalized.contains("stop") || normalized.contains("batch")
        })
        .unwrap_or(false))
}

async fn load_trip_radar_orders(client: &Client) -> Result<Vec<TripRadarOrder>, (StatusCode, String)> {
    let demand = load_open_demand(client).await?;
    let supply = load_available_supply(client).await?;
    let rows = client
        .query(
            "SELECT id, notes FROM orders WHERE status IN ('pending', 'confirmed', 'assigned') ORDER BY updated_at DESC LIMIT 20",
            &[],
        )
        .await
        .map_err(internal_error)?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let notes: Option<String> = row.get("notes");
            let normalized = notes.unwrap_or_default().to_lowercase();
            TripRadarOrder {
                order_id: row.get("id"),
                demand_level: Some(demand),
                supply_level: Some(supply),
                long_trip_minutes: Some(if normalized.contains("airport") { 65.0 } else { 25.0 }),
                multi_stop: Some(normalized.contains("multi") || normalized.contains("stop")),
            }
        })
        .collect())
}

async fn load_batchable_orders(client: &Client) -> Result<Vec<BatchOrder>, (StatusCode, String)> {
    let rows = client
        .query(
            r#"
            SELECT id, COALESCE(delivery_address, pickup_address, 'default') AS location_hint, COALESCE(notes, '') AS notes
            FROM orders
            WHERE status IN ('pending', 'confirmed', 'assigned')
            ORDER BY updated_at DESC
            LIMIT 30
            "#,
            &[],
        )
        .await
        .map_err(internal_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let location_hint: String = row.get("location_hint");
            let notes: String = row.get("notes");
            let normalized_notes = notes.to_lowercase();
            let zone_key = location_hint
                .split(',')
                .next()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            BatchOrder {
                order_id: row.get("id"),
                zone_key,
                distance_km: if location_hint.to_lowercase().contains("airport") { 7.5 } else { 3.2 },
                prep_minutes: Some(if normalized_notes.contains("prep") { 24.0 } else { 14.0 }),
                regulated_items: Some(normalized_notes.contains("regulated") || normalized_notes.contains("pharmacy")),
                priority_level: Some(if normalized_notes.contains("vip") || normalized_notes.contains("urgent") {
                    "urgent".to_string()
                } else {
                    "standard".to_string()
                }),
            }
        })
        .collect())
}

async fn load_recent_driver_eta(client: &Client) -> Result<Option<f64>, (StatusCode, String)> {
    let row = client
        .query_one(
            "SELECT AVG((response_json->>'dispatch_ready_in_minutes')::float8) AS avg_eta FROM dispatch_optimizer_runs WHERE endpoint = 'eta'",
            &[],
        )
        .await
        .map_err(internal_error)?;
    Ok(row.get::<_, Option<f64>>("avg_eta"))
}

async fn persist_run<T: Serialize, U: Serialize>(
    client: &Client,
    endpoint: &str,
    request: &T,
    response: &U,
    order_id: Option<i64>,
) -> Result<(), (StatusCode, String)> {
    let request_json = serde_json::to_value(request).map_err(internal_error)?;
    let response_json = serde_json::to_value(response).map_err(internal_error)?;
    client
        .execute(
            "INSERT INTO dispatch_optimizer_runs (endpoint, order_id, request_json, response_json) VALUES ($1, $2, $3, $4)",
            &[&endpoint, &order_id, &request_json, &response_json],
        )
        .await
        .map_err(internal_error)?;
    Ok(())
}

fn internal_error<E: std::fmt::Display>(error: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::{round2, subtle_equal};

    #[test]
    fn secure_comparison_accepts_only_equal_values() {
        assert!(subtle_equal("32-character-internal-service-token", "32-character-internal-service-token"));
        assert!(!subtle_equal("32-character-internal-service-token", "32-character-internal-service-t0ken"));
        assert!(!subtle_equal("short", "longer"));
    }

    #[test]
    fn rounding_preserves_two_decimal_dispatch_precision() {
        assert_eq!(round2(12.345), 12.35);
        assert_eq!(round2(12.344), 12.34);
        assert_eq!(round2(-1.235), -1.24);
    }
}
