use serde::{Deserialize, Serialize};

#[cfg(target_os = "ios")]
use tauri::{
    plugin::{PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_redterm_ios_native);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardImageResult {
    pub found: bool,
    #[serde(rename = "localPath")]
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoicePermissionStates {
    pub microphone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceInputLanguage {
    pub tag: String,
    pub label: String,
}

#[cfg(any(target_os = "ios", test))]
#[derive(Debug, Serialize)]
struct ClipboardImageRequest {
    #[serde(rename = "stagingDirectory")]
    staging_directory: String,
}

#[cfg(any(target_os = "ios", test))]
#[derive(Debug, Serialize)]
struct KeepScreenOnRequest {
    enabled: bool,
}

#[cfg(any(target_os = "ios", test))]
#[derive(Debug, Serialize)]
struct KeyboardVisibilityRequest {
    visible: bool,
}

#[cfg(any(target_os = "ios", test))]
#[derive(Debug, Serialize)]
struct VoiceInputRequest {
    #[serde(rename = "languageTag")]
    language_tag: String,
}

#[cfg(any(target_os = "ios", test))]
impl VoiceInputRequest {
    fn new(language_tag: impl Into<String>) -> Self {
        Self {
            language_tag: language_tag.into(),
        }
    }
}

#[cfg(any(target_os = "ios", test))]
#[derive(Debug, Serialize)]
struct CredentialIdRequest {
    #[serde(rename = "credentialId")]
    credential_id: String,
}

#[cfg(any(target_os = "ios", test))]
#[derive(Debug, Serialize)]
struct CredentialWriteRequest {
    #[serde(rename = "credentialId")]
    credential_id: String,
    password: String,
}

#[cfg(target_os = "ios")]
#[derive(Debug, Deserialize)]
struct CredentialReadResult {
    found: bool,
    password: Option<String>,
}

#[cfg(target_os = "ios")]
pub struct RedtermIosNative<R: Runtime> {
    handle: PluginHandle<R>,
}

#[cfg(target_os = "ios")]
impl<R: Runtime> RedtermIosNative<R> {
    fn read_clipboard_image(
        &self,
        staging_directory: String,
    ) -> Result<ClipboardImageResult, String> {
        self.handle
            .run_mobile_plugin(
                "readClipboardImage",
                ClipboardImageRequest { staging_directory },
            )
            .map_err(|error| error.to_string())
    }

    fn set_keep_screen_on(&self, enabled: bool) -> Result<(), String> {
        self.handle
            .run_mobile_plugin("setKeepScreenOn", KeepScreenOnRequest { enabled })
            .map_err(|error| error.to_string())
    }

    fn set_keyboard_visible(&self, visible: bool) -> Result<(), String> {
        self.handle
            .run_mobile_plugin("setKeyboardVisible", KeyboardVisibilityRequest { visible })
            .map_err(|error| error.to_string())
    }

    fn check_voice_input_permissions(&self) -> Result<VoicePermissionStates, String> {
        self.handle
            .run_mobile_plugin("checkVoiceInputPermissions", ())
            .map_err(|error| error.to_string())
    }

    fn request_voice_input_permissions(&self) -> Result<VoicePermissionStates, String> {
        self.handle
            .run_mobile_plugin("requestVoiceInputPermissions", ())
            .map_err(|error| error.to_string())
    }

    fn list_voice_input_languages(&self) -> Result<Vec<VoiceInputLanguage>, String> {
        self.handle
            .run_mobile_plugin("listVoiceInputLanguages", ())
            .map_err(|error| error.to_string())
    }

    fn start_voice_input(&self, language_tag: String) -> Result<(), String> {
        self.handle
            .run_mobile_plugin("startVoiceInput", VoiceInputRequest::new(language_tag))
            .map_err(|error| error.to_string())
    }

    fn stop_voice_input(&self) -> Result<(), String> {
        self.handle
            .run_mobile_plugin("stopVoiceInput", ())
            .map_err(|error| error.to_string())
    }

    fn cancel_voice_input(&self) -> Result<(), String> {
        self.handle
            .run_mobile_plugin("cancelVoiceInput", ())
            .map_err(|error| error.to_string())
    }

    fn store_credential(&self, credential_id: String, password: String) -> Result<(), String> {
        self.handle
            .run_mobile_plugin(
                "storeCredential",
                CredentialWriteRequest {
                    credential_id,
                    password,
                },
            )
            .map_err(|error| error.to_string())
    }

    fn get_credential(&self, credential_id: String) -> Result<Option<String>, String> {
        self.handle
            .run_mobile_plugin::<CredentialReadResult>(
                "getCredential",
                CredentialIdRequest { credential_id },
            )
            .map_err(|error| error.to_string())
            .and_then(|result| {
                if result.found {
                    result
                        .password
                        .map(Some)
                        .ok_or_else(|| "iOS credential response omitted the password".to_string())
                } else {
                    Ok(None)
                }
            })
    }

    fn delete_credential(&self, credential_id: String) -> Result<(), String> {
        self.handle
            .run_mobile_plugin("deleteCredential", CredentialIdRequest { credential_id })
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "ios")]
pub fn read_clipboard_image<R: Runtime, M: Manager<R>>(
    manager: &M,
    staging_directory: String,
) -> Result<ClipboardImageResult, String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .read_clipboard_image(staging_directory)
}

#[cfg(target_os = "ios")]
pub fn set_keep_screen_on<R: Runtime, M: Manager<R>>(
    manager: &M,
    enabled: bool,
) -> Result<(), String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .set_keep_screen_on(enabled)
}

#[cfg(target_os = "ios")]
pub fn set_keyboard_visible<R: Runtime, M: Manager<R>>(
    manager: &M,
    visible: bool,
) -> Result<(), String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .set_keyboard_visible(visible)
}

#[cfg(target_os = "ios")]
pub fn check_voice_input_permissions<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> Result<VoicePermissionStates, String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .check_voice_input_permissions()
}

#[cfg(target_os = "ios")]
pub fn request_voice_input_permissions<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> Result<VoicePermissionStates, String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .request_voice_input_permissions()
}

#[cfg(target_os = "ios")]
pub fn list_voice_input_languages<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> Result<Vec<VoiceInputLanguage>, String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .list_voice_input_languages()
}

#[cfg(target_os = "ios")]
pub fn start_voice_input<R: Runtime, M: Manager<R>>(
    manager: &M,
    language_tag: String,
) -> Result<(), String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .start_voice_input(language_tag)
}

#[cfg(target_os = "ios")]
pub fn stop_voice_input<R: Runtime, M: Manager<R>>(manager: &M) -> Result<(), String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .stop_voice_input()
}

#[cfg(target_os = "ios")]
pub fn cancel_voice_input<R: Runtime, M: Manager<R>>(manager: &M) -> Result<(), String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .cancel_voice_input()
}

#[cfg(target_os = "ios")]
pub fn store_credential<R: Runtime, M: Manager<R>>(
    manager: &M,
    credential_id: String,
    password: String,
) -> Result<(), String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .store_credential(credential_id, password)
}

#[cfg(target_os = "ios")]
pub fn get_credential<R: Runtime, M: Manager<R>>(
    manager: &M,
    credential_id: String,
) -> Result<Option<String>, String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .get_credential(credential_id)
}

#[cfg(target_os = "ios")]
pub fn delete_credential<R: Runtime, M: Manager<R>>(
    manager: &M,
    credential_id: String,
) -> Result<(), String> {
    manager
        .state::<RedtermIosNative<R>>()
        .inner()
        .delete_credential(credential_id)
}

#[cfg(target_os = "ios")]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("redterm-ios-native")
        .setup(|app, api| {
            let handle = api.register_ios_plugin(init_plugin_redterm_ios_native)?;
            app.manage(RedtermIosNative { handle });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_command_payloads_match_swift_argument_names() {
        assert_eq!(
            serde_json::to_value(ClipboardImageRequest {
                staging_directory: "/cache/clipboard-paste".to_string(),
            })
            .unwrap(),
            serde_json::json!({ "stagingDirectory": "/cache/clipboard-paste" })
        );
        assert_eq!(
            serde_json::to_value(KeepScreenOnRequest { enabled: true }).unwrap(),
            serde_json::json!({ "enabled": true })
        );
        assert_eq!(
            serde_json::to_value(KeyboardVisibilityRequest { visible: false }).unwrap(),
            serde_json::json!({ "visible": false })
        );
        assert_eq!(
            serde_json::to_value(VoiceInputRequest::new("ko-KR")).unwrap(),
            serde_json::json!({ "languageTag": "ko-KR" })
        );
        assert_eq!(
            serde_json::to_value(CredentialIdRequest {
                credential_id: "connection-1".to_string(),
            })
            .unwrap(),
            serde_json::json!({ "credentialId": "connection-1" })
        );
        assert_eq!(
            serde_json::to_value(CredentialWriteRequest {
                credential_id: "connection-1".to_string(),
                password: "secret".to_string(),
            })
            .unwrap(),
            serde_json::json!({ "credentialId": "connection-1", "password": "secret" })
        );
    }
}
