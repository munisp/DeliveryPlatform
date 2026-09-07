use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, env, net::SocketAddr, sync::Arc};
use tracing::info;

#[derive(Clone)]
struct AppState {
    internal_token: String,
}

#[derive(Debug, Deserialize)]
struct EvaluationRequest {
    subject_type: String,
    completed_processors: Vec<String>,
    provider_checks: Vec<ProviderCheck>,
}

#[derive(Debug, Deserialize)]
struct ProviderCheck {
    check_type: String,
    state: String,
}

#[derive(Debug, Serialize, PartialEq)]
struct EvaluationResponse {
    outcome_code: String,
    manual_review_required: bool,
    missing_checks: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MrzRequest {
    lines: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
struct MrzResponse {
    present: bool,
    format: String,
    valid: bool,
    failures: Vec<String>,
}

fn required_checks(subject_type: &str) -> Option<Vec<&'static str>> {
    match subject_type {
        "driver" => Some(vec!["identity_document", "liveness", "driving_licence", "criminal_record", "sanctions"]),
        "vehicle_asset" => Some(vec!["vehicle_registry", "commercial_insurance"]),
        "field_technician" => Some(vec!["identity_document", "liveness", "criminal_record", "sanctions", "technician_credential"]),
        "merchant" => Some(vec!["beneficial_owner", "sanctions"]),
        "fleet_provider" => Some(vec!["beneficial_owner", "sanctions", "commercial_insurance"]),
        "operator" => Some(vec!["identity_document", "liveness", "criminal_record", "sanctions", "operator_recertification"]),
        _ => None,
    }
}

fn evaluate(request: EvaluationRequest) -> EvaluationResponse {
    let required = match required_checks(&request.subject_type) {
        Some(value) => value,
        None => return EvaluationResponse { outcome_code: "invalid_subject_type_manual_review".into(), manual_review_required: true, missing_checks: vec![] },
    };
    let completed: HashSet<&str> = request.completed_processors.iter().map(String::as_str).collect();
    let passed: HashSet<&str> = request.provider_checks.iter().filter(|item| item.state == "passed").map(|item| item.check_type.as_str()).collect();
    let mut missing: Vec<String> = required.iter().filter(|check| !passed.contains(**check)).map(|check| (*check).to_string()).collect();
    if request.subject_type == "driver" && !completed.contains("paddleocr") && !completed.contains("docling") && !completed.contains("vlm_document") {
        missing.push("document_processing".into());
    }
    if request.subject_type == "driver" && !completed.contains("document_forensics") {
        missing.push("document_forensics_processing".into());
    }
    if request.subject_type == "driver" && !completed.contains("liveness") {
        missing.push("liveness_processing".into());
    }
    missing.sort();
    if missing.is_empty() {
        EvaluationResponse { outcome_code: "all_checks_present_manual_review_required".into(), manual_review_required: true, missing_checks: vec![] }
    } else {
        EvaluationResponse { outcome_code: "verification_checks_incomplete_manual_review".into(), manual_review_required: true, missing_checks: missing }
    }
}

fn mrz_character_value(character: char) -> Option<u32> {
    match character {
        '<' => Some(0),
        '0'..='9' => Some(character as u32 - '0' as u32),
        'A'..='Z' => Some(character as u32 - 'A' as u32 + 10),
        _ => None,
    }
}

fn mrz_check_digit(value: &str) -> Option<u32> {
    const WEIGHTS: [u32; 3] = [7, 3, 1];
    value.chars().enumerate().try_fold(0_u32, |sum, (index, character)| {
        mrz_character_value(character).map(|numeric| sum + numeric * WEIGHTS[index % WEIGHTS.len()])
    }).map(|sum| sum % 10)
}

fn validate_td3_mrz(lines: &[String]) -> MrzResponse {
    let normalized: Vec<String> = lines.iter().map(|line| line.trim().replace(' ', "")).collect();
    if normalized.len() != 2 || normalized.iter().any(|line| line.len() != 44 || !line.is_ascii()) {
        return MrzResponse { present: !normalized.is_empty(), format: "unsupported_or_malformed".into(), valid: false, failures: vec!["mrz_td3_two_44_character_lines_required".into()] };
    }
    let first = normalized[0].as_bytes();
    let second = normalized[1].as_bytes();
    let mut failures = Vec::new();
    if &first[0..2] != b"P<" { failures.push("mrz_td3_document_prefix_invalid".into()); }
    let checks = [
        ("document_number", &normalized[1][0..9], second[9] as char),
        ("birth_date", &normalized[1][13..19], second[19] as char),
        ("expiry_date", &normalized[1][21..27], second[27] as char),
        ("personal_number", &normalized[1][28..42], second[42] as char),
    ];
    for (name, value, claimed) in checks {
        if !claimed.is_ascii_digit() || mrz_check_digit(value) != claimed.to_digit(10) {
            failures.push(format!("mrz_{}_checksum_invalid", name));
        }
    }
    let composite = format!("{}{}{}{}{}", &normalized[1][0..10], &normalized[1][13..20], &normalized[1][21..43], "", "");
    if !second[43].is_ascii_digit() || mrz_check_digit(&composite) != (second[43] as char).to_digit(10) {
        failures.push("mrz_composite_checksum_invalid".into());
    }
    MrzResponse { present: true, format: "td3_passport".into(), valid: failures.is_empty(), failures }
}

fn require_token(headers: &HeaderMap, state: &AppState) -> Result<(), StatusCode> {
    headers.get("x-internal-service-token").and_then(|value| value.to_str().ok()).filter(|value| *value == state.internal_token).map(|_| ()).ok_or(StatusCode::UNAUTHORIZED)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status":"ok","service":"verification-policy"}))
}

async fn evaluate_handler(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(request): Json<EvaluationRequest>) -> Result<Json<EvaluationResponse>, StatusCode> {
    require_token(&headers, &state)?;
    Ok(Json(evaluate(request)))
}

async fn validate_mrz_handler(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(request): Json<MrzRequest>) -> Result<Json<MrzResponse>, StatusCode> {
    require_token(&headers, &state)?;
    Ok(Json(validate_td3_mrz(&request.lines)))
}

#[tokio::main]
async fn main() {
    let token = env::var("INTERNAL_SERVICE_TOKEN").expect("INTERNAL_SERVICE_TOKEN is required");
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/evaluate", post(evaluate_handler))
        .route("/v1/forensics/mrz", post(validate_mrz_handler))
        .with_state(Arc::new(AppState { internal_token: token }));
    let addr: SocketAddr = env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8122".into()).parse().expect("valid BIND_ADDR");
    info!(%addr, "verification policy service starting");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind verification policy service");
    axum::serve(listener, app).await.expect("serve verification policy service");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_td3() -> Vec<String> {
        vec![
            "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<".into(),
            "L898902C36UTO7408122F1204159ZE184226B<<<<<10".into(),
        ]
    }

    #[test]
    fn driver_missing_checks_requires_manual_review() {
        let result = evaluate(EvaluationRequest { subject_type: "driver".into(), completed_processors: vec!["paddleocr".into()], provider_checks: vec![] });
        assert_eq!(result.outcome_code, "verification_checks_incomplete_manual_review");
        assert!(result.manual_review_required);
        assert!(result.missing_checks.contains(&"sanctions".to_string()));
        assert!(result.missing_checks.contains(&"liveness_processing".to_string()));
        assert!(result.missing_checks.contains(&"document_forensics_processing".to_string()));
    }

    #[test]
    fn all_required_driver_signals_still_routes_to_manual_review() {
        let checks = ["identity_document","liveness","driving_licence","criminal_record","sanctions"].into_iter().map(|check_type| ProviderCheck { check_type: check_type.into(), state: "passed".into() }).collect();
        let result = evaluate(EvaluationRequest { subject_type: "driver".into(), completed_processors: vec!["docling".into(),"document_forensics".into(),"liveness".into()], provider_checks: checks });
        assert_eq!(result.outcome_code, "all_checks_present_manual_review_required");
        assert!(result.manual_review_required);
    }

    #[test]
    fn valid_td3_mrz_passes_all_checksum_rules() {
        let result = validate_td3_mrz(&valid_td3());
        assert!(result.valid, "unexpected failures: {:?}", result.failures);
        assert_eq!(result.format, "td3_passport");
    }

    #[test]
    fn altered_td3_mrz_is_risk_evidence_not_an_authenticity_verdict() {
        let mut lines = valid_td3();
        lines[1].replace_range(9..10, "0");
        let result = validate_td3_mrz(&lines);
        assert!(!result.valid);
        assert!(result.failures.contains(&"mrz_document_number_checksum_invalid".to_string()));
    }
}
