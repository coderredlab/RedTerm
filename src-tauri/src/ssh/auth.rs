use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    #[serde(rename = "password")]
    Password { password: String },
    #[serde(rename = "stored_password")]
    StoredPassword { connection_id: String },
    #[serde(rename = "key")]
    Key {
        key_id: String,
        passphrase: Option<String>,
    },
    #[serde(skip)]
    ResolvedKey {
        key_path: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    pub username: String,
    pub method: AuthMethod,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_password_auth_deserializes_as_native_reference() {
        let auth: AuthConfig = serde_json::from_value(serde_json::json!({
            "username": "deploy",
            "method": {
                "type": "stored_password",
                "connection_id": "connection-1"
            }
        }))
        .expect("stored password auth should deserialize");

        assert!(matches!(
            auth.method,
            AuthMethod::StoredPassword { connection_id } if connection_id == "connection-1"
        ));
    }
}
