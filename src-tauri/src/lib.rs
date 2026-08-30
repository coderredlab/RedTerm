use std::sync::Arc;
use uuid::Uuid;

mod commands;
mod ssh;
mod storage;

use commands::{
    cancel_voice_input, check_voice_input_permissions, delete_known_host, get_keyboard_layout_map,
    get_runtime_instance_id, install_keyboard_layout_change_listener, list_known_hosts,
    list_voice_input_languages, local_download_file, local_download_to_dir, local_home_dir,
    local_list_dir, local_read_file, local_shell_disconnect, local_shell_get_output,
    local_shell_resize, local_shell_start, local_shell_write, read_clipboard_image,
    read_clipboard_text, request_voice_input_permissions, set_keep_screen_on, set_keyboard_visible,
    sftp_download_file, sftp_download_to_dir, sftp_home_dir, sftp_list_dir, sftp_read_file,
    ssh_check_host_key, ssh_connect, ssh_disconnect, ssh_get_session_output,
    ssh_get_session_snapshot, ssh_resize, ssh_session_exists, ssh_store_session_snapshot,
    ssh_trust_host_key, ssh_upload_clipboard_image, ssh_upload_clipboard_image_from_local_path,
    ssh_write, start_voice_input, stop_voice_input, HostKeyChallengeStore, LocalShellManager,
    RuntimeState, SessionManager,
};
use storage::{
    delete_connection, delete_uploaded_ssh_key, load_connections, save_connection, upload_ssh_key,
};

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
            sftp_download_file,
            sftp_download_to_dir,
            sftp_home_dir,
            read_clipboard_text,
            local_shell_start,
            local_shell_write,
            local_shell_resize,
            local_shell_disconnect,
            local_shell_get_output,
            local_home_dir,
            local_list_dir,
            local_read_file,
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
            delete_connection,
            ssh_trust_host_key,
            list_known_hosts,
            delete_known_host,
            upload_ssh_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_capability_allows_local_shell_output_replay() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability must be valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("default capability permissions must be an array");

        assert!(permissions
            .iter()
            .any(|permission| permission == "allow-local-shell-get-output"));
    }
}
