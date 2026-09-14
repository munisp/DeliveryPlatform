//! Boot-time configuration validation.
//!
//! Fails fast, naming every missing or invalid required environment
//! variable in a single error, instead of panicking one variable at a
//! time across crash-loop iterations. The static manifest contract check
//! (scripts/testing/check-config-contract.py) reads REQUIRED_ENV_VARS to
//! cross-check the Kubernetes manifests against the code.

use std::env;

pub const REQUIRED_ENV_VARS: &[&str] = &[
    "DATABASE_URL",
    "INTERNAL_SERVICE_TOKEN",
];

/// Returns an error naming every missing or invalid required environment
/// variable, or `Ok(())` when the boot configuration is complete.
pub fn validate_boot_configuration() -> Result<(), String> {
    let mut problems: Vec<String> = Vec::new();
    for name in REQUIRED_ENV_VARS {
        let value = env::var(name).ok().map(|value| value.trim().to_string());
        match value {
            Some(value) if !value.is_empty() => {}
            _ => problems.push(format!("{name} is required")),
        }
    }
    if let Ok(token) = env::var("INTERNAL_SERVICE_TOKEN") {
        let token = token.trim();
        if !token.is_empty() && token.len() < 32 {
            problems.push("INTERNAL_SERVICE_TOKEN must be at least 32 characters".to_string());
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!("invalid boot configuration: {}", problems.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_variables_are_all_named() {
        for name in REQUIRED_ENV_VARS {
            env::remove_var(name);
        }
        let error = validate_boot_configuration().expect_err("missing configuration must fail");
        for name in REQUIRED_ENV_VARS {
            assert!(error.contains(name), "expected error to name {name}: {error}");
        }
    }

    #[test]
    fn complete_environment_passes() {
        env::set_var("DATABASE_URL", "postgres://example.invalid/switchos");
        env::set_var("INTERNAL_SERVICE_TOKEN", "a".repeat(32));
        validate_boot_configuration().expect("complete environment must pass");
        env::remove_var("DATABASE_URL");
        env::remove_var("INTERNAL_SERVICE_TOKEN");
    }
}
