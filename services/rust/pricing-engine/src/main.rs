use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{env, net::SocketAddr, sync::Arc};
use tracing::info;

#[derive(Clone)]
struct AppState {
    service_name: String,
}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
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

    let port = env::var("PORT").unwrap_or_else(|_| "8101".to_string());
    let bind_host = env::var("BIND_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let state = Arc::new(AppState {
        service_name: "pricing-engine".to_string(),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/price", post(price))
        .route("/quote-bundle", post(quote_bundle))
        .route("/quote-vertical", post(quote_vertical))
        .route("/quote-courier-offer", post(quote_courier_offer))
        .route("/quote-marketplace", post(quote_marketplace))
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", bind_host, port)
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 8101)));
    info!("starting pricing engine on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(HealthResponse {
        status: "ok".to_string(),
        service: state.service_name.clone(),
    })
}

async fn price(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<PricingRequest>,
) -> Result<Json<PricingResponse>, (StatusCode, Json<serde_json::Value>)> {
    if request.base_price <= 0.0 || request.distance_km < 0.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid pricing request"})),
        ));
    }

    let demand_factor = (request.current_demand / request.available_drivers.max(1.0)).clamp(0.5, 3.0);
    let supply_factor = (1.5 - (request.available_drivers / request.current_demand.max(1.0))).clamp(0.7, 1.5);
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
    let elasticity_input = request.merchant_elasticity.unwrap_or(1.0).clamp(0.7, 1.2);
    let elasticity_factor = if demand_factor > 1.2 {
        (1.0 / elasticity_input).clamp(0.85, 1.15)
    } else {
        1.0
    };
    let incentive_intensity = request
        .incentive_budget_ratio
        .unwrap_or_else(|| ((request.distance_km / 20.0) + (demand_factor / 4.0)).clamp(0.0, 0.35))
        .clamp(0.0, 0.4);

    let raw_multiplier =
        demand_factor * supply_factor * time_factor * weather_factor * weekend_factor * fairness_adjustment * elasticity_factor;
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
    let confidence = (0.82 + (request.available_drivers / (request.current_demand.max(1.0) * 10.0))).clamp(0.75, 0.98);

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

    Ok(Json(PricingResponse {
        optimized_price: round2(optimized_price),
        surge_multiplier: round2(surge_multiplier),
        demand_factor: round2(demand_factor),
        supply_factor: round2(supply_factor),
        time_factor: round2(time_factor),
        fairness_adjustment: round2(fairness_adjustment),
        confidence,
        strategy: strategy.to_string(),
        model_version: "rust-pricing-engine-v5".to_string(),
        guardrail_applied,
        price_floor: round2(base_guardrail_floor),
        price_ceiling: round2(base_guardrail_ceiling),
        elasticity_factor: round2(elasticity_factor),
        incentive_intensity: round2(incentive_intensity),
        pricing_rationale: pricing_rationale.to_string(),
    }))
}

async fn quote_bundle(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<BundleQuoteRequest>,
) -> Result<Json<BundleQuoteResponse>, (StatusCode, Json<serde_json::Value>)> {
    if request.subtotal < 0.0 || request.delivery_fee < 0.0 || request.service_fee < 0.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid quote request"})),
        ));
    }

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
    let sponsored_lift_score = request.sponsored_boost.unwrap_or(0.12).clamp(0.0, 0.5);
    let discounted_total = (base_total - membership_savings - reward_credit + suggested_tip).max(0.0);
    let prep_minutes = request.merchant_prep_minutes.unwrap_or(18);
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

    Ok(Json(BundleQuoteResponse {
        base_total: round2(base_total),
        discounted_total: round2(discounted_total),
        membership_savings: round2(membership_savings),
        reward_credit: round2(reward_credit),
        sponsored_lift_score: round2(sponsored_lift_score),
        suggested_tip: round2(suggested_tip),
        eta_minutes,
        recommended_surface: recommended_surface.to_string(),
        checkout_message: checkout_message.to_string(),
    }))
}

async fn quote_vertical(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<VerticalQuoteRequest>,
) -> Result<Json<VerticalQuoteResponse>, (StatusCode, Json<serde_json::Value>)> {
    if request.base_fee < 0.0 || request.distance_km < 0.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid vertical quote request"})),
        ));
    }

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
    let quoted = ((request.base_fee + distance_component) * multiplier * item_factor) - membership_discount;
    let turnaround_risk = if request.turnaround_hours <= 6 {
        "high"
    } else if request.turnaround_hours <= 24 {
        "moderate"
    } else {
        "normal"
    };

    Ok(Json(VerticalQuoteResponse {
        vertical_name: request.vertical_name,
        quote_total: round2(quoted.max(0.0)),
        recommended_fulfillment_mode: fulfillment_mode,
        turnaround_risk: turnaround_risk.to_string(),
        vertical_multiplier: round2(multiplier),
        surcharge_components,
        quote_summary: "The quote blends vertical-specific handling complexity, turnaround pressure, item density, and distance into a reusable commerce quote.".to_string(),
    }))
}

async fn quote_courier_offer(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<CourierOfferRequest>,
) -> Result<Json<CourierOfferResponse>, (StatusCode, Json<serde_json::Value>)> {
    if request.base_payout <= 0.0 || request.distance_km < 0.0 || request.estimated_trip_minutes <= 0.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid courier offer request"})),
        ));
    }

    let ratio = request.current_demand / request.available_drivers.max(1.0);
    let mut multiplier = 1.0;
    let mut incentive_components = Vec::new();

    if ratio > 1.4 {
        multiplier += 0.18;
        incentive_components.push("demand_surge".to_string());
    }
    if request.distance_km >= 10.0 {
        multiplier += 0.12;
        incentive_components.push("long_distance".to_string());
    }
    if request.stacked_orders.unwrap_or(1) >= 2 {
        multiplier += 0.08;
        incentive_components.push("stacked_batch".to_string());
    }
    if matches!(request.weather_condition.as_deref(), Some("rain") | Some("storm")) {
        multiplier += 0.06;
        incentive_components.push("weather_protection".to_string());
    }
    if matches!(request.priority_level.as_deref(), Some("vip") | Some("urgent")) {
        multiplier += 0.07;
        incentive_components.push("priority_service".to_string());
    }

    let payout_total = request.base_payout * multiplier;
    let earnings_per_km = payout_total / request.distance_km.max(0.5);
    let earnings_per_hour = payout_total / (request.estimated_trip_minutes / 60.0).max(0.25);
    let recommended_dispatch_mode = if ratio > 1.4 || request.distance_km >= 10.0 {
        "trip_radar_offer"
    } else {
        "direct_ping"
    };

    Ok(Json(CourierOfferResponse {
        payout_total: round2(payout_total),
        payout_multiplier: round2(multiplier),
        earnings_per_km: round2(earnings_per_km),
        earnings_per_hour: round2(earnings_per_hour),
        incentive_components,
        recommended_dispatch_mode: recommended_dispatch_mode.to_string(),
        courier_message: "The courier offer combines distance, demand pressure, stacking complexity, and service urgency into a payout recommendation.".to_string(),
    }))
}

async fn quote_marketplace(
    State(_state): State<Arc<AppState>>,
    Json(request): Json<MarketplaceQuoteRequest>,
) -> Result<Json<MarketplaceQuoteResponse>, (StatusCode, Json<serde_json::Value>)> {
    if request.subtotal < 0.0 || request.distance_km < 0.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid marketplace quote request"})),
        ));
    }

    let ratio = request.current_demand / request.available_drivers.max(1.0);
    let surge_multiplier = if ratio > 1.8 {
        1.35
    } else if ratio > 1.2 {
        1.15
    } else {
        1.0
    };

    let vertical_boost = if request.vertical_name.to_lowercase().contains("pharmacy") {
        1.18
    } else if request.vertical_name.to_lowercase().contains("laundry") {
        1.12
    } else {
        1.0
    };

    let handling_fee = if request.regulated_items.unwrap_or(false) { 2.2 } else { 0.0 }
        + if request.special_handling.unwrap_or(false) { 1.7 } else { 0.0 };
    let distance_fee = request.distance_km * 0.95;
    let service_fee = (request.subtotal * 0.08).max(1.5);
    let membership_discount = if request.membership_active.unwrap_or(false) { 2.0 } else { 0.0 };
    let courier_payout = ((distance_fee * 0.72) + (request.item_count as f64 * 0.15) + handling_fee * 0.55) * surge_multiplier;
    let customer_total = ((request.subtotal + distance_fee + service_fee + handling_fee) * vertical_boost * surge_multiplier)
        - membership_discount
        + request.tip_amount.unwrap_or(0.0);
    let platform_take = (customer_total - courier_payout - request.subtotal).max(0.0);
    let batching_eligible = request.item_count <= 8
        && !request.regulated_items.unwrap_or(false)
        && request.merchant_prep_minutes.unwrap_or(16) <= 20
        && request.distance_km <= 6.5;
    let eta_minutes = request.merchant_prep_minutes.unwrap_or(16)
        + if batching_eligible { 24 } else { 19 }
        + if surge_multiplier > 1.0 { 6 } else { 0 };
    let checkout_surface = if request.membership_active.unwrap_or(false) {
        "member_express_checkout"
    } else if batching_eligible {
        "smart_batch_checkout"
    } else {
        "standard_checkout"
    };

    Ok(Json(MarketplaceQuoteResponse {
        vertical_name: request.vertical_name,
        customer_total: round2(customer_total.max(0.0)),
        courier_payout: round2(courier_payout.max(0.0)),
        platform_take: round2(platform_take),
        surge_multiplier: round2(surge_multiplier),
        eta_minutes,
        batching_eligible,
        checkout_surface: checkout_surface.to_string(),
        operational_summary: "The marketplace quote aligns customer pricing, courier earnings, batching eligibility, and platform take into a single operational checkout view.".to_string(),
    }))
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
