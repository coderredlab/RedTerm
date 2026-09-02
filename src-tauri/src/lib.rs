use std::sync::Arc;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};
use uuid::Uuid;

mod commands;
mod ssh;
mod storage;
// Every editor backend shares this compare-and-replace critical section.
pub(crate) static FILE_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use commands::DesktopClipboardState;
use commands::{
    cancel_voice_input, check_voice_input_permissions, delete_known_host, exit_application,
    get_keyboard_layout_map, get_runtime_instance_id, install_keyboard_layout_change_listener,
    list_known_hosts, list_voice_input_languages, local_download_file, local_download_to_dir,
    local_home_dir, local_list_dir, local_read_file, local_shell_disconnect,
    local_shell_get_output, local_shell_resize, local_shell_start, local_shell_write,
    local_write_file, preview_cache_acquire, preview_cache_release, read_clipboard_image,
    read_clipboard_text, request_voice_input_permissions, set_keep_screen_on, set_keyboard_visible,
    sftp_download_file, sftp_download_to_dir, sftp_home_dir, sftp_list_dir, sftp_read_file,
    sftp_write_file, ssh_check_host_key, ssh_connect, ssh_disconnect, ssh_get_session_output,
    ssh_get_session_snapshot, ssh_resize, ssh_session_exists, ssh_store_session_snapshot,
    ssh_trust_host_key, ssh_upload_clipboard_image, ssh_upload_clipboard_image_from_local_path,
    ssh_write, start_voice_input, stop_voice_input, write_clipboard_text, HostKeyChallengeStore,
    LocalShellManager, RuntimeState, SessionManager,
};

use storage::{
    acknowledge_uploaded_ssh_key, delete_connection, delete_uploaded_ssh_key,
    list_pending_uploaded_ssh_keys, load_connections, save_connection, upload_ssh_key,
};

#[cfg(any(target_os = "macos", test))]
fn should_confirm_app_exit(code: Option<i32>) -> bool {
    code.is_none()
}

#[cfg(target_os = "macos")]
fn handle_run_event(app_handle: &tauri::AppHandle, event: tauri::RunEvent) {
    const APP_EXIT_REQUESTED_EVENT: &str = "app-exit-requested";

    if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
        if should_confirm_app_exit(code) && app_handle.get_webview_window("main").is_some() {
            api.prevent_exit();
            if let Err(error) = app_handle.emit(APP_EXIT_REQUESTED_EVENT, ()) {
                eprintln!("failed to request application exit confirmation: {error}");
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn handle_run_event(_: &tauri::AppHandle, _: tauri::RunEvent) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session_manager = Arc::new(SessionManager::new());
    let local_shell_manager = Arc::new(LocalShellManager::new());
    let runtime_state = Arc::new(RuntimeState {
        instance_id: Uuid::new_v4().to_string(),
    });
    let host_key_challenges = Arc::new(HostKeyChallengeStore::default());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_redterm_android_paste::init());

    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_redterm_ios_native::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.manage(DesktopClipboardState::default());

    builder
        .setup(|app| {
            install_keyboard_layout_change_listener(app.handle());
            Ok(())
        })
        .manage(session_manager)
        .manage(local_shell_manager)
        .manage(runtime_state)
        .manage(host_key_challenges)
        .invoke_handler(tauri::generate_handler![
            exit_application,
            get_runtime_instance_id,
            get_keyboard_layout_map,
            check_voice_input_permissions,
            request_voice_input_permissions,
            list_voice_input_languages,
            start_voice_input,
            stop_voice_input,
            cancel_voice_input,
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_get_session_output,
            ssh_get_session_snapshot,
            ssh_session_exists,
            ssh_store_session_snapshot,
            ssh_upload_clipboard_image,
            sftp_list_dir,
            sftp_read_file,
            sftp_write_file,
            sftp_download_file,
            sftp_download_to_dir,
            sftp_home_dir,
            preview_cache_acquire,
            preview_cache_release,
            read_clipboard_text,
            write_clipboard_text,
            local_shell_start,
            local_shell_write,
            local_shell_resize,
            local_shell_disconnect,
            local_shell_get_output,
            local_home_dir,
            local_list_dir,
            local_read_file,
            local_write_file,
            local_download_file,
            local_download_to_dir,
            ssh_upload_clipboard_image_from_local_path,
            read_clipboard_image,
            set_keyboard_visible,
            set_keep_screen_on,
            load_connections,
            ssh_check_host_key,
            save_connection,
            delete_uploaded_ssh_key,
            list_pending_uploaded_ssh_keys,
            acknowledge_uploaded_ssh_key,
            delete_connection,
            ssh_trust_host_key,
            list_known_hosts,
            delete_known_host,
            upload_ssh_key,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

#[cfg(test)]
mod tests {
    #[test]
    fn local_shell_and_file_write_permissions_are_desktop_only() {
        let desktop: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop-local-shell.json"))
                .expect("desktop capability must be valid JSON");
        let desktop_permissions = desktop["permissions"]
            .as_array()
            .expect("desktop capability permissions must be an array");

        assert_eq!(
            desktop["platforms"],
            serde_json::json!(["linux", "macOS", "windows"])
        );
        for permission in [
            "allow-local-shell-get-output",
            "allow-local-write-file",
            "allow-sftp-write-file",
            "allow-preview-cache-acquire",
            "allow-preview-cache-release",
        ] {
            assert!(desktop_permissions
                .iter()
                .any(|candidate| candidate == permission));
        }

        let default: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability must be valid JSON");
        let default_permissions = default["permissions"]
            .as_array()
            .expect("default capability permissions must be an array");
        for permission in [
            "allow-local-shell-get-output",
            "allow-local-write-file",
            "allow-sftp-write-file",
            "allow-preview-cache-acquire",
            "allow-preview-cache-release",
        ] {
            assert!(!default_permissions
                .iter()
                .any(|candidate| candidate == permission));
        }
    }
    #[test]
    fn native_confirmation_permissions_cover_desktop_close_paths() {
        let default: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability must be valid JSON");
        let default_permissions = default["permissions"]
            .as_array()
            .expect("default capability permissions must be an array");
        assert!(default_permissions
            .iter()
            .any(|candidate| candidate == "dialog:allow-message"));
        assert!(default_permissions
            .iter()
            .any(|candidate| candidate == "allow-exit-application"));

        let desktop: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop-local-shell.json"))
                .expect("desktop capability must be valid JSON");
        let desktop_permissions = desktop["permissions"]
            .as_array()
            .expect("desktop capability permissions must be an array");
        assert!(desktop_permissions
            .iter()
            .any(|candidate| candidate == "core:window:allow-destroy"));
    }

    #[test]
    fn native_exit_requires_confirmation_but_confirmed_exit_does_not() {
        assert!(super::should_confirm_app_exit(None));
        assert!(!super::should_confirm_app_exit(Some(0)));
    }

    #[test]
    fn desktop_version_is_independent_from_mobile_version() {
        let desktop: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.desktop.conf.json"))
                .expect("desktop Tauri config must be valid JSON");
        let mobile: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("mobile Tauri config must be valid JSON");

        assert_eq!(desktop["version"], "1.7.7");
        assert_eq!(mobile["version"], "1.7.4");
    }

    #[test]
    fn desktop_bundle_is_ad_hoc_signed_for_local_builds() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.desktop.conf.json"))
                .expect("desktop Tauri config must be valid JSON");
        assert_eq!(config["bundle"]["macOS"]["signingIdentity"], "-");
    }

    #[test]
    fn pdf_asset_protocols_are_allowed_in_frames() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("Tauri config must be valid JSON");
        assert_eq!(
            config["app"]["security"]["csp"]["frame-src"],
            "'self' asset: http://asset.localhost"
        );
    }
}
