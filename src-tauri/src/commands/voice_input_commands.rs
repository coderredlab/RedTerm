use tauri::AppHandle;

use tauri_plugin_redterm_android_paste::{
    cancel_voice_input as cancel_android_voice_input,
    check_voice_input_permissions as check_android_voice_input_permissions,
    list_voice_input_languages as list_android_voice_input_languages,
    request_voice_input_permissions as request_android_voice_input_permissions,
    start_voice_input as start_android_voice_input, stop_voice_input as stop_android_voice_input,
    VoiceInputLanguage, VoicePermissionStates,
};

#[tauri::command]
pub async fn check_voice_input_permissions(
    app: AppHandle,
) -> Result<VoicePermissionStates, String> {
    check_android_voice_input_permissions(&app)
}

#[tauri::command]
pub async fn request_voice_input_permissions(
    app: AppHandle,
) -> Result<VoicePermissionStates, String> {
    request_android_voice_input_permissions(&app)
}

#[tauri::command]
pub async fn list_voice_input_languages(app: AppHandle) -> Result<Vec<VoiceInputLanguage>, String> {
    list_android_voice_input_languages(&app)
}

#[tauri::command]
pub async fn start_voice_input(app: AppHandle, language_tag: String) -> Result<(), String> {
    start_android_voice_input(&app, language_tag)
}

#[tauri::command]
pub async fn stop_voice_input(app: AppHandle) -> Result<(), String> {
    stop_android_voice_input(&app)
}

#[tauri::command]
pub async fn cancel_voice_input(app: AppHandle) -> Result<(), String> {
    cancel_android_voice_input(&app)
}
