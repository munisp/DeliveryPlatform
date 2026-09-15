//! work-record-signer — R14 portable work-record signer (Wave D2).
//!
//! Produces tamper-evident, driver-portable signed work records: the caller
//! (server/_core/dataPortability.ts) canonicalizes the work-record payload
//! (sorted-key UTF-8 JSON); this service signs the EXACT bytes received with
//! ed25519 and exposes a verify endpoint so a driver's reputation survives
//! platform exit and can be validated by any third party holding the public
//! key.
//!
//! Boot configuration (fail fast, name every missing variable at once):
//!   WORK_RECORD_SIGNER_SEED  — 64 lowercase/uppercase hex chars = 32-byte
//!                              ed25519 signing seed.
//!   WORK_RECORD_SIGNER_TOKEN — shared internal token required on the
//!                              X-Internal-Service-Token header for /sign and
//!                              /verify.
//!   PORT (default 8109), BIND_HOST (default 127.0.0.1).
//!
//! key_id = first 8 hex chars of sha256(verifying key bytes).

use std::env;
use std::process::exit;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};
use tiny_http::{Header, Method, Response, Server, StatusCode};

const SERVICE_NAME: &str = "work-record-signer";

struct AppConfig {
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
    key_id: String,
    internal_token: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

fn key_id_for(verifying_key: &VerifyingKey) -> String {
    sha256_hex(verifying_key.as_bytes())[..8].to_string()
}

/// Boot-time configuration validation: fail fast naming every problem in one
/// message instead of crash-looping one variable at a time. Returns Err with
/// a human-readable description when the boot configuration is invalid.
fn load_boot_configuration() -> Result<AppConfig, String> {
    let mut problems: Vec<String> = Vec::new();

    let seed_hex = env::var("WORK_RECORD_SIGNER_SEED").unwrap_or_default();
    let seed_hex = seed_hex.trim().to_string();
    let seed: Option<[u8; 32]> = if seed_hex.is_empty() {
        problems.push("WORK_RECORD_SIGNER_SEED is required (64 hex chars = 32-byte ed25519 seed)".into());
        None
    } else if seed_hex.len() != 64 {
        problems.push(format!(
            "WORK_RECORD_SIGNER_SEED must be exactly 64 hex chars (got {})",
            seed_hex.len()
        ));
        None
    } else {
        match hex::decode(&seed_hex) {
            Ok(bytes) => match <[u8; 32]>::try_from(bytes.as_slice()) {
                Ok(array) => Some(array),
                Err(_) => {
                    problems.push("WORK_RECORD_SIGNER_SEED must decode to exactly 32 bytes".into());
                    None
                }
            },
            Err(_) => {
                problems.push("WORK_RECORD_SIGNER_SEED must be valid hexadecimal".into());
                None
            }
        }
    };

    let internal_token = env::var("WORK_RECORD_SIGNER_TOKEN").unwrap_or_default();
    let internal_token = internal_token.trim().to_string();
    if internal_token.is_empty() {
        problems.push("WORK_RECORD_SIGNER_TOKEN is required".into());
    } else if internal_token.len() < 32 {
        problems.push("WORK_RECORD_SIGNER_TOKEN must be at least 32 characters".into());
    }

    if !problems.is_empty() {
        return Err(format!("invalid boot configuration: {}", problems.join("; ")));
    }

    let signing_key = SigningKey::from_bytes(&seed.expect("seed validated above"));
    let verifying_key = signing_key.verifying_key();
    let key_id = key_id_for(&verifying_key);
    Ok(AppConfig { signing_key, verifying_key, key_id, internal_token })
}

/// Constant-time-ish token comparison (avoids early-exit timing signal).
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

fn json_response(status: u16, body: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let text = body.to_string();
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header is valid");
    Response::new(
        StatusCode(status),
        vec![header],
        std::io::Cursor::new(text.into_bytes()),
        None,
        None,
    )
}

fn error_response(status: u16, code: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(status, serde_json::json!({"error": code}))
}

struct SignOutput {
    payload_hash: String,
    signature_b64: String,
    key_id: String,
    public_key_b64: String,
}

fn sign_payload(config: &AppConfig, payload: &[u8]) -> SignOutput {
    let signature: Signature = config.signing_key.sign(payload);
    SignOutput {
        payload_hash: sha256_hex(payload),
        signature_b64: B64.encode(signature.to_bytes()),
        key_id: config.key_id.clone(),
        public_key_b64: B64.encode(config.verifying_key.as_bytes()),
    }
}

/// Verify `signature_b64` over the exact `payload` bytes against
/// `public_key_b64`. Any decode/parse failure yields `false` — never panics.
fn verify_payload(payload: &[u8], signature_b64: &str, public_key_b64: &str) -> bool {
    let signature_bytes = match B64.decode(signature_b64) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let signature = match Signature::from_slice(&signature_bytes) {
        Ok(signature) => signature,
        Err(_) => return false,
    };
    let public_bytes = match B64.decode(public_key_b64) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    if public_bytes.len() != 32 {
        return false;
    }
    let verifying_key = match VerifyingKey::from_bytes(
        &<[u8; 32]>::try_from(public_bytes.as_slice()).expect("length checked"),
    ) {
        Ok(key) => key,
        Err(_) => return false,
    };
    verifying_key.verify_strict(payload, &signature).is_ok()
}

fn read_body(request: &mut tiny_http::Request) -> Result<String, ()> {
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|_| ())?;
    Ok(body)
}

fn require_token(request: &tiny_http::Request, config: &AppConfig) -> bool {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("X-Internal-Service-Token"))
        .map(|header| subtle_equal(header.value.as_str(), &config.internal_token))
        .unwrap_or(false)
}

fn handle_sign(config: &AppConfig, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return error_response(400, "invalid_json"),
    };
    let payload = match parsed.get("payload").and_then(|value| value.as_str()) {
        Some(payload) => payload,
        None => return error_response(400, "payload_string_required"),
    };
    let output = sign_payload(config, payload.as_bytes());
    json_response(
        200,
        serde_json::json!({
            "payload_hash": output.payload_hash,
            "signature_b64": output.signature_b64,
            "key_id": output.key_id,
            "public_key_b64": output.public_key_b64,
        }),
    )
}

fn handle_verify(body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return error_response(400, "invalid_json"),
    };
    let (payload, signature_b64, public_key_b64) = match (
        parsed.get("payload").and_then(|value| value.as_str()),
        parsed.get("signature_b64").and_then(|value| value.as_str()),
        parsed.get("public_key_b64").and_then(|value| value.as_str()),
    ) {
        (Some(payload), Some(signature), Some(public_key)) => (payload, signature, public_key),
        _ => return error_response(400, "payload_signature_b64_public_key_b64_required"),
    };
    let valid = verify_payload(payload.as_bytes(), signature_b64, public_key_b64);
    json_response(200, serde_json::json!({"valid": valid}))
}

fn route(config: &AppConfig, request: &mut tiny_http::Request) -> Response<std::io::Cursor<Vec<u8>>> {
    let method = request.method().clone();
    let url = request.url().to_string();
    match (method, url.as_str()) {
        (Method::Get, "/healthz") => {
            json_response(200, serde_json::json!({"status": "ok", "service": SERVICE_NAME}))
        }
        (Method::Post, "/sign") => {
            if !require_token(request, config) {
                return error_response(401, "invalid_internal_service_token");
            }
            match read_body(request) {
                Ok(body) => handle_sign(config, &body),
                Err(_) => error_response(400, "body_read_failed"),
            }
        }
        (Method::Post, "/verify") => {
            if !require_token(request, config) {
                return error_response(401, "invalid_internal_service_token");
            }
            match read_body(request) {
                Ok(body) => handle_verify(&body),
                Err(_) => error_response(400, "body_read_failed"),
            }
        }
        _ => error_response(404, "not_found"),
    }
}

fn main() {
    let config = match load_boot_configuration() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            eprintln!("{SERVICE_NAME}: {error}");
            exit(1);
        }
    };
    let bind_host = env::var("BIND_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = env::var("PORT").unwrap_or_else(|_| "8109".into());
    let addr = format!("{bind_host}:{port}");
    let server = Server::http(&addr).unwrap_or_else(|error| {
        eprintln!("{SERVICE_NAME}: failed to bind {addr}: {error}");
        exit(1);
    });
    eprintln!("{SERVICE_NAME}: listening on {addr} key_id={}", config.key_id);
    for mut request in server.incoming_requests() {
        let response = route(&config, &mut request);
        let _ = request.respond(response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SEED: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn test_config() -> AppConfig {
        let seed_bytes = hex::decode(TEST_SEED).unwrap();
        let signing_key = SigningKey::from_bytes(&<[u8; 32]>::try_from(seed_bytes.as_slice()).unwrap());
        let verifying_key = signing_key.verifying_key();
        let key_id = key_id_for(&verifying_key);
        AppConfig {
            signing_key,
            verifying_key,
            key_id,
            internal_token: TEST_TOKEN.into(),
        }
    }

    #[test]
    fn sign_verify_roundtrip_is_valid() {
        let config = test_config();
        let payload = br#"{"driver_id":42,"trips":17}"#;
        let output = sign_payload(&config, payload);
        assert!(verify_payload(payload, &output.signature_b64, &output.public_key_b64));
    }

    #[test]
    fn tampered_payload_fails_verification() {
        let config = test_config();
        let output = sign_payload(&config, b"{\"net_minor\":5000}");
        assert!(!verify_payload(
            b"{\"net_minor\":5001}",
            &output.signature_b64,
            &output.public_key_b64
        ));
    }

    #[test]
    fn wrong_public_key_fails_verification() {
        let config = test_config();
        let output = sign_payload(&config, b"payload");
        let other_key = SigningKey::from_bytes(&[9u8; 32]);
        let other_public_b64 = B64.encode(other_key.verifying_key().as_bytes());
        assert!(!verify_payload(b"payload", &output.signature_b64, &other_public_b64));
    }

    #[test]
    fn payload_hash_is_deterministic_sha256() {
        let config = test_config();
        let first = sign_payload(&config, b"canonical-bytes");
        let second = sign_payload(&config, b"canonical-bytes");
        assert_eq!(first.payload_hash, second.payload_hash);
        // Independent sha256 check of the same bytes.
        assert_eq!(first.payload_hash, sha256_hex(b"canonical-bytes"));
        assert_eq!(first.payload_hash.len(), 64);
    }

    #[test]
    fn key_id_is_first_8_hex_of_sha256_verifying_key() {
        let config = test_config();
        let expected = sha256_hex(config.verifying_key.as_bytes())[..8].to_string();
        assert_eq!(config.key_id, expected);
        assert_eq!(config.key_id.len(), 8);
    }

    #[test]
    fn missing_env_fails_boot_configuration() {
        let original_seed = env::var("WORK_RECORD_SIGNER_SEED").ok();
        let original_token = env::var("WORK_RECORD_SIGNER_TOKEN").ok();
        env::remove_var("WORK_RECORD_SIGNER_SEED");
        env::remove_var("WORK_RECORD_SIGNER_TOKEN");
        let result = load_boot_configuration();
        if let Some(value) = original_seed {
            env::set_var("WORK_RECORD_SIGNER_SEED", value);
        }
        if let Some(value) = original_token {
            env::set_var("WORK_RECORD_SIGNER_TOKEN", value);
        }
        let message = result.err().expect("missing env must fail boot");
        assert!(message.contains("WORK_RECORD_SIGNER_SEED is required"));
        assert!(message.contains("WORK_RECORD_SIGNER_TOKEN is required"));
    }

    #[test]
    fn malformed_seed_fails_boot_configuration() {
        let original_seed = env::var("WORK_RECORD_SIGNER_SEED").ok();
        let original_token = env::var("WORK_RECORD_SIGNER_TOKEN").ok();
        env::set_var("WORK_RECORD_SIGNER_SEED", "zz-not-hex");
        env::set_var("WORK_RECORD_SIGNER_TOKEN", TEST_TOKEN);
        let result = load_boot_configuration();
        match original_seed {
            Some(value) => env::set_var("WORK_RECORD_SIGNER_SEED", value),
            None => env::remove_var("WORK_RECORD_SIGNER_SEED"),
        }
        match original_token {
            Some(value) => env::set_var("WORK_RECORD_SIGNER_TOKEN", value),
            None => env::remove_var("WORK_RECORD_SIGNER_TOKEN"),
        }
        assert!(result.is_err());
    }

    #[test]
    fn healthz_route_returns_ok() {
        let config = test_config();
        let server = Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr();
        let config = std::sync::Arc::new(config);
        let config_thread = config.clone();
        std::thread::spawn(move || {
            if let Ok(mut request) = server.recv() {
                let response = route(&config_thread, &mut request);
                let _ = request.respond(response);
            }
        });
        let port = match addr {
            tiny_http::ListenAddr::IP(socket) => socket.port(),
            _ => panic!("unexpected listen addr"),
        };
        let body = ureq_get(&format!("http://127.0.0.1:{port}/healthz"));
        assert!(body.contains("\"status\":\"ok\""), "body was: {body}");
    }

    /// Minimal HTTP GET using std::net (tests only — no extra dev-dependency).
    fn ureq_get(url: &str) -> String {
        let rest = url.strip_prefix("http://").expect("test url");
        let (host_port, path) = rest.split_once('/').expect("test url path");
        let mut stream = std::net::TcpStream::connect(host_port).expect("connect");
        use std::io::{Read, Write};
        write!(stream, "GET /{path} HTTP/1.0\r\nHost: {host_port}\r\n\r\n").expect("write");
        let mut buf = String::new();
        stream.read_to_string(&mut buf).expect("read");
        buf
    }

    #[test]
    fn subtle_equal_behaves() {
        assert!(subtle_equal("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!subtle_equal("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"));
        assert!(!subtle_equal("short", "much-longer-token"));
    }

    #[test]
    fn verify_rejects_garbage_inputs_without_panicking() {
        assert!(!verify_payload(b"x", "!!!not-base64!!!", "also-bad"));
        assert!(!verify_payload(b"x", &B64.encode([1u8; 10]), &B64.encode([2u8; 64])));
    }
}
