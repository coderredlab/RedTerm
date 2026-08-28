use serde::{Deserialize, Serialize};
use tauri::{plugin::TauriPlugin, Manager, Runtime};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.coderred.redterm.androidpaste";

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

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VoiceInputLanguagesPayload {
    languages: Vec<VoiceInputLanguage>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct KeepScreenOnPayload {
    enabled: bool,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct ForegroundServicePayload {
    #[serde(rename = "sessionCount")]
    session_count: usize,
    title: String,
    text: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct KeyboardPayload {
    visible: bool,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct VoiceInputPayload {
    #[serde(rename = "languageTag")]
    language_tag: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct CredentialIdPayload {
    #[serde(rename = "credentialId")]
    credential_id: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct CredentialWritePayload {
    #[serde(rename = "credentialId")]
    credential_id: String,
    password: String,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct CredentialReadResult {
    found: bool,
    password: Option<String>,
}

#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct VoicePermissionRequestPayload {
    permissions: [&'static str; 1],
}

#[cfg(any(target_os = "android", test))]
fn voice_permission_request_payload() -> VoicePermissionRequestPayload {
    VoicePermissionRequestPayload {
        permissions: ["microphone"],
    }
}

pub struct AndroidPaste<R: Runtime> {
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
    #[cfg(target_os = "android")]
    _android_plugin_handle: PluginHandle<R>,
}

impl<R: Runtime> AndroidPaste<R> {
    #[cfg(target_os = "android")]
    fn read_clipboard_image(&self) -> Result<ClipboardImageResult, String> {
        self._android_plugin_handle
            .run_mobile_plugin::<ClipboardImageResult>("readClipboardImage", ())
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "android"))]
    fn read_clipboard_image(&self) -> Result<ClipboardImageResult, String> {
        Ok(ClipboardImageResult {
            found: false,
            local_path: None,
        })
    }

    #[cfg(target_os = "android")]
    fn store_credential(&self, credential_id: String, password: String) -> Result<(), String> {
        self._android_plugin_handle
            .run_mobile_plugin::<()>(
                "storeCredential",
                CredentialWritePayload {
                    credential_id,
                    password,
                },
            )
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn get_credential(&self, credential_id: String) -> Result<Option<String>, String> {
        self._android_plugin_handle
            .run_mobile_plugin::<CredentialReadResult>(
                "getCredential",
                CredentialIdPayload { credential_id },
            )
            .map_err(|e| e.to_string())
            .and_then(|result| {
                if result.found {
                    result
                        .password
                        .map(Some)
                        .ok_or_else(|| "Android credential response omitted the password".to_string())
                } else {
                    Ok(None)
                }
            })
    }

    #[cfg(target_os = "android")]
    fn delete_credential(&self, credential_id: String) -> Result<(), String> {
        self._android_plugin_handle
            .run_mobile_plugin::<()>(
                "deleteCredential",
                CredentialIdPayload { credential_id },
            )
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn update_foreground_service(&self, session_count: usize) -> Result<(), String> {
        let payload = ForegroundServicePayload {
            session_count,
            title: if session_count > 1 {
                format!("RedTerm - {} connections active", session_count)
            } else {
                "RedTerm - Connection active".to_string()
            },
            text: if session_count > 1 {
                format!(
                    "{} SSH sessions kept alive in the background",
                    session_count
                )
            } else {
                "SSH session is kept alive in the background".to_string()
            },
        };

        self._android_plugin_handle
            .run_mobile_plugin::<()>("startForegroundService", payload)
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn stop_foreground_service(&self) -> Result<(), String> {
        self._android_plugin_handle
            .run_mobile_plugin::<()>("stopForegroundService", ())
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn set_keep_screen_on(&self, enabled: bool) -> Result<(), String> {
        self._android_plugin_handle
            .run_mobile_plugin::<()>("setKeepScreenOn", KeepScreenOnPayload { enabled })
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn set_keyboard_visible(&self, visible: bool) -> Result<(), String> {
        self._android_plugin_handle
            .run_mobile_plugin::<()>(
                if visible {
                    "showKeyboard"
                } else {
                    "hideKeyboard"
                },
                KeyboardPayload { visible },
            )
            .map_err(|e| e.to_string())
    }


    #[cfg(target_os = "android")]
    fn check_voice_input_permissions(&self) -> Result<VoicePermissionStates, String> {
        self._android_plugin_handle
            .run_mobile_plugin::<VoicePermissionStates>("checkPermissions", ())
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn request_voice_input_permissions(&self) -> Result<VoicePermissionStates, String> {
        self._android_plugin_handle
            .run_mobile_plugin::<VoicePermissionStates>(
                "requestPermissions",
                voice_permission_request_payload(),
            )
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn list_voice_input_languages(&self) -> Result<Vec<VoiceInputLanguage>, String> {
        self._android_plugin_handle
            .run_mobile_plugin::<VoiceInputLanguagesPayload>("listVoiceInputLanguages", ())
            .map(|payload| payload.languages)
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn start_voice_input(&self, language_tag: String) -> Result<(), String> {
        self._android_plugin_handle
            .run_mobile_plugin::<()>("startVoiceInput", VoiceInputPayload { language_tag })
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn stop_voice_input(&self) -> Result<(), String> {
        self._android_plugin_handle
            .run_mobile_plugin::<()>("stopVoiceInput", ())
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn cancel_voice_input(&self) -> Result<(), String> {
        self._android_plugin_handle
            .run_mobile_plugin::<()>("cancelVoiceInput", ())
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "android"))]
    fn set_keep_screen_on(&self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    fn set_keyboard_visible(&self, _visible: bool) -> Result<(), String> {
        Ok(())
    }


    #[cfg(not(target_os = "android"))]
    fn check_voice_input_permissions(&self) -> Result<VoicePermissionStates, String> {
        Ok(VoicePermissionStates {
            microphone: Some("denied".into()),
        })
    }

    #[cfg(not(target_os = "android"))]
    fn request_voice_input_permissions(&self) -> Result<VoicePermissionStates, String> {
        Ok(VoicePermissionStates {
            microphone: Some("denied".into()),
        })
    }

    #[cfg(not(target_os = "android"))]
    fn list_voice_input_languages(&self) -> Result<Vec<VoiceInputLanguage>, String> {
        Ok(Vec::new())
    }

    #[cfg(not(target_os = "android"))]
    fn start_voice_input(&self, _language_tag: String) -> Result<(), String> {
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    fn stop_voice_input(&self) -> Result<(), String> {
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    fn cancel_voice_input(&self) -> Result<(), String> {
        Ok(())
    }
}

pub fn read_clipboard_image<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> Result<ClipboardImageResult, String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .read_clipboard_image()
}

#[cfg(target_os = "android")]
pub fn store_credential<R: Runtime, M: Manager<R>>(
    manager: &M,
    credential_id: String,
    password: String,
) -> Result<(), String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .store_credential(credential_id, password)
}

#[cfg(target_os = "android")]
pub fn get_credential<R: Runtime, M: Manager<R>>(
    manager: &M,
    credential_id: String,
) -> Result<Option<String>, String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .get_credential(credential_id)
}

#[cfg(target_os = "android")]
pub fn delete_credential<R: Runtime, M: Manager<R>>(
    manager: &M,
    credential_id: String,
) -> Result<(), String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .delete_credential(credential_id)
}

#[cfg(target_os = "android")]
pub fn update_foreground_service<R: Runtime, M: Manager<R>>(
    manager: &M,
    session_count: usize,
) -> Result<(), String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .update_foreground_service(session_count)
}

pub fn set_keep_screen_on<R: Runtime, M: Manager<R>>(
    manager: &M,
    enabled: bool,
) -> Result<(), String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .set_keep_screen_on(enabled)
}

pub fn set_keyboard_visible<R: Runtime, M: Manager<R>>(
    manager: &M,
    visible: bool,
) -> Result<(), String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .set_keyboard_visible(visible)
}


pub fn check_voice_input_permissions<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> Result<VoicePermissionStates, String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .check_voice_input_permissions()
}

pub fn request_voice_input_permissions<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> Result<VoicePermissionStates, String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .request_voice_input_permissions()
}

pub fn list_voice_input_languages<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> Result<Vec<VoiceInputLanguage>, String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .list_voice_input_languages()
}

pub fn start_voice_input<R: Runtime, M: Manager<R>>(
    manager: &M,
    language_tag: String,
) -> Result<(), String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .start_voice_input(language_tag)
}

pub fn stop_voice_input<R: Runtime, M: Manager<R>>(manager: &M) -> Result<(), String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .stop_voice_input()
}

pub fn cancel_voice_input<R: Runtime, M: Manager<R>>(manager: &M) -> Result<(), String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .cancel_voice_input()
}

#[cfg(target_os = "android")]
pub fn stop_foreground_service<R: Runtime, M: Manager<R>>(manager: &M) -> Result<(), String> {
    manager
        .state::<AndroidPaste<R>>()
        .inner()
        .stop_foreground_service()
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("redterm-android-paste")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let handle =
                _api.register_android_plugin(PLUGIN_IDENTIFIER, "RedtermAndroidPastePlugin")?;

            app.manage(AndroidPaste {
                #[cfg(not(target_os = "android"))]
                _marker: std::marker::PhantomData::<fn() -> R>,
                #[cfg(target_os = "android")]
                _android_plugin_handle: handle,
            });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_permission_request_payload_targets_microphone_alias() {
        let payload = voice_permission_request_payload();

        assert_eq!(payload.permissions, ["microphone"]);
    }
}
