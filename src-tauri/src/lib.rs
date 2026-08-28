use std::sync::Arc;
use uuid::Uuid;

mod commands;
mod ssh;
mod storage;

use commands::{
    cancel_voice_input, check_voice_input_permissions, delete_known_host, get_runtime_instance_id,
    list_known_hosts, list_voice_input_languages, read_clipboard_image,
    request_voice_input_permissions, set_keep_screen_on, set_keyboard_visible, ssh_check_host_key,
    ssh_connect, ssh_disconnect, ssh_get_session_output, ssh_get_session_snapshot, ssh_resize,
    ssh_session_exists, ssh_store_session_snapshot, ssh_trust_host_key, ssh_upload_clipboard_image,
    ssh_upload_clipboard_image_from_local_path, ssh_write, start_voice_input, stop_voice_input,
    HostKeyChallengeStore, RuntimeState, SessionManager,
};
use storage::{
    delete_connection, delete_uploaded_ssh_key, load_connections, save_connection, upload_ssh_key,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session_manager = Arc::new(SessionManager::new());
    let runtime_state = Arc::new(RuntimeState {
        instance_id: Uuid::new_v4().to_string(),
    });
    let host_key_challenges = Arc::new(HostKeyChallengeStore::default());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_redterm_android_paste::init());

    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_redterm_ios_native::init());

    builder
        .manage(session_manager)
        .manage(runtime_state)
        .manage(host_key_challenges)
        .invoke_handler(tauri::generate_handler![
            get_runtime_instance_id,
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
