use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};
use uuid::Uuid;

mod commands;
mod ssh;
mod storage;
// Every editor backend shares this compare-and-replace critical section.
pub(crate) static FILE_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub(crate) static EXIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
const APP_EXIT_REQUESTED_EVENT: &str = "app-exit-requested";
#[cfg(target_os = "macos")]
const CONFIRM_QUIT_MENU_ID: &str = "redterm-confirm-quit";

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use commands::DesktopClipboardState;
use commands::{
    cancel_voice_input, check_voice_input_permissions, delete_known_host, exit_application,
    get_keyboard_layout_map, get_runtime_instance_id, install_keyboard_layout_change_listener,
    list_known_hosts, list_system_fonts, list_voice_input_languages, local_create_dir,
    local_create_file, local_download_file, local_download_to_dir, local_home_dir, local_list_dir,
    local_read_file, local_remove_path, local_shell_disconnect, local_shell_get_output,
    local_shell_resize, local_shell_start, local_shell_write, local_write_file,
    preview_cache_acquire, preview_cache_release, read_clipboard_image, read_clipboard_text,
    request_voice_input_permissions, restart_application, set_keep_screen_on, set_keyboard_visible,
    sftp_create_dir, sftp_create_file, sftp_download_file, sftp_download_to_dir, sftp_home_dir,
    sftp_list_dir, sftp_read_file, sftp_remove_path, sftp_write_file, ssh_check_host_key,
    ssh_connect, ssh_disconnect, ssh_get_session_output, ssh_get_session_snapshot, ssh_resize,
    ssh_session_exists, ssh_store_session_snapshot, ssh_trust_host_key, ssh_upload_clipboard_image,
    ssh_upload_clipboard_image_from_local_path, ssh_write, start_voice_input, stop_voice_input,
    write_clipboard_text, HostKeyChallengeStore, LocalShellManager, RuntimeState, SessionManager,
};

use storage::{
    acknowledge_uploaded_ssh_key, delete_connection, delete_uploaded_ssh_key,
    list_pending_uploaded_ssh_keys, load_connections, save_connection, upload_ssh_key,
};

#[cfg(any(target_os = "macos", test))]
fn should_confirm_app_exit(exit_confirmed: bool) -> bool {
    !exit_confirmed
}

#[cfg(target_os = "macos")]
fn request_app_exit_confirmation(app_handle: &tauri::AppHandle) {
    if app_handle.get_webview_window("main").is_none() {
        return;
    }
    if let Err(error) = app_handle.emit(APP_EXIT_REQUESTED_EVENT, ()) {
        eprintln!("failed to request application exit confirmation: {error}");
    }
}

#[cfg(target_os = "macos")]
fn handle_run_event(app_handle: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested { api, .. } = event {
        let exit_confirmed = EXIT_CONFIRMED.swap(false, Ordering::AcqRel);
        if should_confirm_app_exit(exit_confirmed)
            && app_handle.get_webview_window("main").is_some()
        {
            api.prevent_exit();
            request_app_exit_confirmation(app_handle);
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

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) =
                menu.items()?.into_iter().next()
            {
                let item_count = app_menu.items()?.len();
                if item_count > 0 {
                    app_menu.remove_at(item_count - 1)?;
                }
                let quit_item = tauri::menu::MenuItem::with_id(
                    app,
                    CONFIRM_QUIT_MENU_ID,
                    "Quit RedTerm",
                    true,
                    Some("Cmd+Q"),
                )?;
                app_menu.append(&quit_item)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == CONFIRM_QUIT_MENU_ID {
                request_app_exit_confirmation(app);
            }
        });

    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_redterm_ios_native::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(DesktopClipboardState::default());
    builder
        .setup(|app| {
            install_keyboard_layout_change_listener(app.handle());
            // The window config keeps native decorations so macOS can pair
            // titleBarStyle Overlay with working traffic lights (their
            // position contract requires decorated windows). Windows and
            // Linux drop decorations here so the app-owned tab strip is the
            // only title bar; wry re-attaches its undecorated resize
            // borders when this call flips the flag.
            #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
            {
                use tauri::Manager as _;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }
            Ok(())
        })
        .manage(session_manager)
        .manage(local_shell_manager)
        .manage(runtime_state)
        .manage(host_key_challenges)
        .invoke_handler(tauri::generate_handler![
            exit_application,
            restart_application,
            list_system_fonts,
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
            sftp_create_dir,
            sftp_create_file,
            sftp_remove_path,
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
            local_create_dir,
            local_create_file,
            local_remove_path,
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
        assert!(super::should_confirm_app_exit(false));
        assert!(!super::should_confirm_app_exit(true));
    }

    #[test]
    fn desktop_version_is_independent_from_mobile_version() {
        let desktop: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.desktop.conf.json"))
                .expect("desktop Tauri config must be valid JSON");
        let mobile: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("mobile Tauri config must be valid JSON");

        assert_eq!(desktop["version"], "1.7.15");
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
