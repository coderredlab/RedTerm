use tauri::AppHandle;

#[cfg(not(target_os = "ios"))]
use tauri_plugin_redterm_android_paste::{
    cancel_voice_input as cancel_native_voice_input,
    check_voice_input_permissions as check_native_voice_input_permissions,
    list_voice_input_languages as list_native_voice_input_languages,
    request_voice_input_permissions as request_native_voice_input_permissions,
    start_voice_input as start_native_voice_input, stop_voice_input as stop_native_voice_input,
    VoiceInputLanguage, VoicePermissionStates,
};
#[cfg(target_os = "ios")]
use tauri_plugin_redterm_ios_native::{
    cancel_voice_input as cancel_native_voice_input,
    check_voice_input_permissions as check_native_voice_input_permissions,
    list_voice_input_languages as list_native_voice_input_languages,
    request_voice_input_permissions as request_native_voice_input_permissions,
    start_voice_input as start_native_voice_input, stop_voice_input as stop_native_voice_input,
    VoiceInputLanguage, VoicePermissionStates,
};

#[tauri::command]
pub async fn check_voice_input_permissions(
    app: AppHandle,
) -> Result<VoicePermissionStates, String> {
    check_native_voice_input_permissions(&app)
}

#[tauri::command]
pub async fn request_voice_input_permissions(
    app: AppHandle,
) -> Result<VoicePermissionStates, String> {
    request_native_voice_input_permissions(&app)
}

#[tauri::command]
pub async fn list_voice_input_languages(app: AppHandle) -> Result<Vec<VoiceInputLanguage>, String> {
    list_native_voice_input_languages(&app)
}

#[tauri::command]
pub async fn start_voice_input(app: AppHandle, language_tag: String) -> Result<(), String> {
    start_native_voice_input(&app, language_tag)
}

#[tauri::command]
pub async fn stop_voice_input(app: AppHandle) -> Result<(), String> {
    stop_native_voice_input(&app)
}

#[tauri::command]
pub async fn cancel_voice_input(app: AppHandle) -> Result<(), String> {
    cancel_native_voice_input(&app)
}
