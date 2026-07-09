use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, env, net::SocketAddr, sync::Arc};
use tokio_postgres::{Client, NoTls};
use tracing::{info, Level};

#[derive(Clone)]
struct AppState {
    service_name: String,
    database_url: String,
    internal_service_token: String,
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
    status: &'static str,
    service: &'static str,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(Level::INFO)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos?sslmode=disable".to_string());
    let internal_service_token = env::var("INTERNAL_SERVICE_TOKEN")
        .unwrap_or_else(|_| "switchos-internal-dev-token-change-before-production".to_string());

    if let Err(error) = ensure_schema(&database_url).await {
        panic!("failed to initialize dispatch optimizer schema: {error}");
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/optimize", post(optimize_dispatch))
        .route("/trip-radar", post(trip_radar))
        .route("/batch-orders", post(batch_orders))
        .route("/eta", post(estimate_eta))
        .route("/voice-priority", post(voice_priority))
        .route("/instant-retail-allocation", post(instant_retail_allocation))
        .with_state(Arc::new(AppState {
            service_name: "switchos-dispatch-optimizer".to_string(),
            database_url,
            internal_service_token,
        }));

    let bind_host = std::env::var("BIND_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let addr: SocketAddr = std::env::var("PORT")
        .ok()
        .and_then(|port| format!("{}:{}", bind_host, port).parse().ok())
        .unwrap_or_else(|| "127.0.0.1:8090".parse().expect("valid default addr"));

    info!("dispatch optimizer listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind listener");
    axum::serve(listener, app).await.expect("serve application");
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "switchos-dispatch-optimizer",
    })
}

async fn optimize_dispatch(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut request): Json<DispatchRequest>,
) -> Result<Json<DispatchResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;
    let client = open_db(&state.database_url).await?;

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
    let client = open_db(&state.database_url).await?;

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
    let client = open_db(&state.database_url).await?;

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

async fn instant_retail_allocation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<InstantRetailAllocationRequest>,
) -> Result<Json<InstantRetailAllocationResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;

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
    }))
}

async fn estimate_eta(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<EtaRequest>,
) -> Result<Json<EtaResponse>, (StatusCode, String)> {
    require_internal_access(&headers, &state)?;
    let client = open_db(&state.database_url).await?;

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

async fn open_db(database_url: &str) -> Result<Client, (StatusCode, String)> {
    let (client, connection) = tokio_postgres::connect(database_url, NoTls)
        .await
        .map_err(internal_error)?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            tracing::error!("dispatch optimizer postgres connection error: {}", error);
        }
    });
    Ok(client)
}

async fn ensure_schema(database_url: &str) -> Result<(), String> {
    let client = open_db(database_url).await.map_err(|(_, message)| message)?;
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
                END AS utilization_rate,
                CASE
                    WHEN current_location ILIKE '%airport%' THEN 3.0
                    WHEN current_location IS NOT NULL AND current_location <> '' THEN 6.0
                    ELSE 10.0
                END AS distance_km,
                CASE
                    WHEN COALESCE(active_orders, 0) = 0 THEN 18.0
                    ELSE 4.0
                END AS idle_minutes,
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
            driver_id: row.get("id"),
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
