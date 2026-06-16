use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, net::SocketAddr, sync::Arc};
use tracing::{info, Level};

#[derive(Clone, Default)]
struct AppState;

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
struct TripRadarRequest {
    orders: Vec<TripRadarOrder>,
}

#[derive(Debug, Deserialize)]
struct TripRadarOrder {
    order_id: i64,
    demand_level: Option<f64>,
    supply_level: Option<f64>,
    long_trip_minutes: Option<f64>,
    multi_stop: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct BatchRequest {
    orders: Vec<BatchOrder>,
    max_batch_distance_km: Option<f64>,
    max_batch_size: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct BatchOrder {
    order_id: i64,
    zone_key: Option<String>,
    distance_km: f64,
    prep_minutes: Option<f64>,
    regulated_items: Option<bool>,
    priority_level: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EtaRequest {
    distance_km: f64,
    merchant_prep_minutes: f64,
    driver_eta_minutes: Option<f64>,
    stacked_orders: Option<u32>,
    weather_condition: Option<String>,
    priority_delivery: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
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

    let app = Router::new()
        .route("/health", get(health))
        .route("/optimize", post(optimize_dispatch))
        .route("/trip-radar", post(trip_radar))
        .route("/batch-orders", post(batch_orders))
        .route("/eta", post(estimate_eta))
        .with_state(Arc::new(AppState::default()));

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
    State(_state): State<Arc<AppState>>,
    Json(request): Json<DispatchRequest>,
) -> Result<Json<DispatchResponse>, (StatusCode, String)> {
    if request.drivers.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one driver is required".to_string()));
    }

    let demand = request.demand_level.unwrap_or(1.0).max(0.1);
    let supply = request.supply_level.unwrap_or(1.0).max(0.1);
    let ratio = demand / supply;
    let long_trip_minutes = request.long_trip_minutes.unwrap_or(0.0);
    let multi_stop = request.multi_stop.unwrap_or(false);

    let trip_mode = request.trip_mode.as_deref().unwrap_or("standard");
    let priority_level = request.priority_level.as_deref().unwrap_or("standard");
    let _order_id = request.order_id.unwrap_or_default();

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
                trip_mode,
                surge_multiplier,
                long_trip_premium,
                multi_stop_surcharge,
                priority_level,
            )
        })
        .collect();

    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));

    let recommended = ranked.first();

    Ok(Json(DispatchResponse {
        strategy: strategy.to_string(),
        supply_demand_ratio: round2(ratio),
        surge_multiplier,
        long_trip_premium,
        multi_stop_surcharge,
        recommended_driver_id: recommended.map(|d| d.driver_id),
        recommended_driver_name: recommended.and_then(|d| d.name.clone()),
        ranked_candidates: ranked,
    }))
}

async fn trip_radar(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<TripRadarRequest>,
) -> Result<Json<TripRadarResponse>, (StatusCode, String)> {
    if request.orders.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one order is required".to_string()));
    }

    let highlighted_orders = request
        .orders
        .into_iter()
        .map(|order| {
            let demand = order.demand_level.unwrap_or(1.0).max(0.1);
            let supply = order.supply_level.unwrap_or(1.0).max(0.1);
            let long_trip = order.long_trip_minutes.unwrap_or(0.0) >= 60.0;
            let multi_stop = order.multi_stop.unwrap_or(false);
            let ratio = demand / supply;
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
        .collect();

    Ok(Json(TripRadarResponse {
        strategy: "trip_radar_marketplace_dispatch".to_string(),
        highlighted_orders,
    }))
}

async fn batch_orders(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<BatchRequest>,
) -> Result<Json<BatchResponse>, (StatusCode, String)> {
    if request.orders.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one order is required".to_string()));
    }

    let max_batch_distance = request.max_batch_distance_km.unwrap_or(8.0).max(1.0);
    let max_batch_size = request.max_batch_size.unwrap_or(3).max(1) as usize;
    let mut orders = request.orders;
    orders.sort_by(|a, b| {
        let zone_a = a.zone_key.clone().unwrap_or_else(|| "default".to_string());
        let zone_b = b.zone_key.clone().unwrap_or_else(|| "default".to_string());
        zone_a.cmp(&zone_b).then_with(|| a.distance_km.partial_cmp(&b.distance_km).unwrap_or(Ordering::Equal))
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

    Ok(Json(BatchResponse {
        strategy: "same_zone_batching".to_string(),
        recommended_batches: recommendations,
        unbatched_order_ids: unbatched,
    }))
}

async fn estimate_eta(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<EtaRequest>,
) -> Result<Json<EtaResponse>, (StatusCode, String)> {
    if request.distance_km < 0.0 || request.merchant_prep_minutes < 0.0 {
        return Err((StatusCode::BAD_REQUEST, "invalid eta request".to_string()));
    }

    let driver_eta = request.driver_eta_minutes.unwrap_or(7.0).max(0.0);
    let stack_count = request.stacked_orders.unwrap_or(1).max(1);
    let batching_delay = if stack_count > 1 { (stack_count - 1) * 6 } else { 0 };
    let weather_delay = match request.weather_condition.as_deref() {
        Some("rain") => 4,
        Some("storm") => 8,
        _ => 0,
    };
    let priority_credit = if request.priority_delivery.unwrap_or(false) { 5 } else { 0 };

    let travel_minutes = (request.distance_km * 4.2).round() as u32;
    let base_eta = request.merchant_prep_minutes.round() as u32 + driver_eta.round() as u32 + travel_minutes + batching_delay + weather_delay;
    let eta_minutes = base_eta.saturating_sub(priority_credit).max(12);
    let confidence_band = if weather_delay >= 8 || stack_count >= 3 {
        "moderate"
    } else {
        "high"
    };

    Ok(Json(EtaResponse {
        eta_minutes,
        confidence_band: confidence_band.to_string(),
        batching_delay_minutes: batching_delay,
        dispatch_ready_in_minutes: (request.merchant_prep_minutes.round() as u32).max(driver_eta.round() as u32),
        customer_message: "ETA reflects merchant prep, courier approach time, distance, batching load, and weather pressure.".to_string(),
    }))
}

fn build_batch_recommendation(orders: &[BatchOrder], sequence: usize) -> BatchRecommendation {
    let zone_key = orders
        .first()
        .and_then(|item| item.zone_key.clone())
        .unwrap_or_else(|| "default".to_string());
    let total_distance_km = orders.iter().map(|item| item.distance_km).sum::<f64>();
    let has_priority = orders.iter().any(|item| matches!(item.priority_level.as_deref(), Some("vip") | Some("urgent")));
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

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
