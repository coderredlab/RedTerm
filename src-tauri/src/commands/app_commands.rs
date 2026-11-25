use std::sync::atomic::Ordering;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use font_kit::source::SystemSource;

#[tauri::command]
pub fn exit_application(app: tauri::AppHandle) {
    crate::EXIT_CONFIRMED.store(true, Ordering::Release);
    app.exit(0);
}
#[tauri::command]
pub fn restart_application(app: tauri::AppHandle) {
    crate::EXIT_CONFIRMED.store(true, Ordering::Release);
    app.restart();
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn load_system_font_families(monospace_only: bool) -> Result<Vec<String>, String> {
    let source = SystemSource::new();
    let mut families = source
        .all_families()
        .map_err(|error| format!("Failed to enumerate system fonts: {error}"))?;
    families.retain(|family| !family.trim().is_empty());
    families.sort_unstable();
    families.dedup();
    if monospace_only {
        #[cfg(target_os = "macos")]
        super::macos_fonts::retain_monospace(&mut families);
        #[cfg(target_os = "windows")]
        super::windows_fonts::retain_monospace(&mut families);
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        super::fontconfig_fonts::retain_monospace(&source, &mut families);
    }
    Ok(families)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn list_system_fonts(monospace_only: Option<bool>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_system_font_families(monospace_only.unwrap_or(false))
    })
    .await
    .map_err(|error| format!("Failed to enumerate system fonts: {error}"))?
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::load_system_font_families;

    #[test]
    fn system_font_families_are_available_sorted_and_unique() {
        let families = load_system_font_families(false).expect("system fonts should be available");

        assert!(!families.is_empty());
        assert!(families.windows(2).all(|pair| pair[0] < pair[1]));
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    Err("System font selection is only available on desktop".to_string())
}
