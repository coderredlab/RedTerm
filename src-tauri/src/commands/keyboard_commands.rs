use serde::Serialize;
use std::collections::HashMap;

pub const KEYBOARD_LAYOUT_CHANGED_EVENT: &str = "keyboard-layout-changed";

#[derive(Clone, Debug, Serialize)]
pub struct KeyboardLayoutEntry {
    pub unshifted: String,
    pub shifted: Option<String>,
    pub alt_gr: Option<String>,
    pub shifted_alt_gr: Option<String>,
    pub other: Vec<String>,
}

pub type KeyboardLayoutMap = HashMap<String, Vec<KeyboardLayoutEntry>>;

#[tauri::command]
pub fn get_keyboard_layout_map() -> KeyboardLayoutMap {
    platform::current_keyboard_layout_map()
}

pub fn install_keyboard_layout_change_listener(app: &tauri::AppHandle) {
    platform::install_keyboard_layout_change_listener(app);
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{KeyboardLayoutEntry, KeyboardLayoutMap, KEYBOARD_LAYOUT_CHANGED_EVENT};
    use std::ffi::c_void;
    use std::sync::{Once, OnceLock};
    use tauri::Emitter;

    const DOM_KEY_CODES: &[(&str, u16)] = &[
        ("KeyA", 0),
        ("KeyS", 1),
        ("KeyD", 2),
        ("KeyF", 3),
        ("KeyH", 4),
        ("KeyG", 5),
        ("KeyZ", 6),
        ("KeyX", 7),
        ("KeyC", 8),
        ("KeyV", 9),
        ("IntlBackslash", 10),
        ("KeyB", 11),
        ("KeyQ", 12),
        ("KeyW", 13),
        ("KeyE", 14),
        ("KeyR", 15),
        ("KeyY", 16),
        ("KeyT", 17),
        ("Digit1", 18),
        ("Digit2", 19),
        ("Digit3", 20),
        ("Digit4", 21),
        ("Digit6", 22),
        ("Digit5", 23),
        ("Equal", 24),
        ("Digit9", 25),
        ("Digit7", 26),
        ("Minus", 27),
        ("Digit8", 28),
        ("Digit0", 29),
        ("BracketRight", 30),
        ("KeyO", 31),
        ("KeyU", 32),
        ("BracketLeft", 33),
        ("KeyI", 34),
        ("KeyP", 35),
        ("KeyL", 37),
        ("KeyJ", 38),
        ("Quote", 39),
        ("KeyK", 40),
        ("Semicolon", 41),
        ("Backslash", 42),
        ("Comma", 43),
        ("Slash", 44),
        ("KeyN", 45),
        ("KeyM", 46),
        ("Period", 47),
        ("Space", 49),
        ("Backquote", 50),
        ("NumpadDecimal", 65),
        ("NumpadMultiply", 67),
        ("NumpadAdd", 69),
        ("NumpadDivide", 75),
        ("NumpadSubtract", 78),
        ("NumpadEqual", 81),
        ("Numpad0", 82),
        ("Numpad1", 83),
        ("Numpad2", 84),
        ("Numpad3", 85),
        ("Numpad4", 86),
        ("Numpad5", 87),
        ("Numpad6", 88),
        ("Numpad7", 89),
        ("Numpad8", 91),
        ("Numpad9", 92),
        ("IntlYen", 93),
        ("IntlRo", 94),
    ];

    type NotificationCallback = unsafe extern "C" fn(
        *const c_void,
        *mut c_void,
        *const c_void,
        *const c_void,
        *const c_void,
    );

    static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
    static INSTALL_LISTENER: Once = Once::new();

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        static kTISPropertyUnicodeKeyLayoutData: *const c_void;
        static kTISNotifySelectedKeyboardInputSourceChanged: *const c_void;
        fn TISCopyCurrentKeyboardLayoutInputSource() -> *const c_void;
        fn TISGetInputSourceProperty(
            input_source: *const c_void,
            property_key: *const c_void,
        ) -> *const c_void;
        fn LMGetKbdType() -> u8;
        fn UCKeyTranslate(
            keyboard_layout: *const c_void,
            virtual_key_code: u16,
            key_action: u16,
            modifier_key_state: u32,
            keyboard_type: u32,
            key_translate_options: u32,
            dead_key_state: *mut u32,
            max_string_length: usize,
            actual_string_length: *mut usize,
            unicode_string: *mut u16,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        fn CFNotificationCenterGetDistributedCenter() -> *const c_void;
        fn CFNotificationCenterAddObserver(
            center: *const c_void,
            observer: *const c_void,
            callback: Option<NotificationCallback>,
            name: *const c_void,
            object: *const c_void,
            suspension_behavior: i32,
        );
        fn CFRelease(value: *const c_void);
    }

    fn translate_key(
        keyboard_layout: *const c_void,
        virtual_key: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
    ) -> Option<String> {
        let mut utf16 = [0u16; 8];
        let mut length = 0usize;
        let mut dead_key_state = 0u32;
        let status = unsafe {
            UCKeyTranslate(
                keyboard_layout,
                virtual_key,
                0,
                modifier_key_state,
                keyboard_type,
                1,
                &mut dead_key_state,
                utf16.len(),
                &mut length,
                utf16.as_mut_ptr(),
            )
        };
        if status != 0 {
            return None;
        }

        let value = String::from_utf16(utf16.get(..length)?).ok()?;
        let mut characters = value.chars();
        let character = characters.next()?;
        (characters.next().is_none() && !character.is_control()).then_some(value)
    }

    pub fn current_keyboard_layout_map() -> KeyboardLayoutMap {
        let mut layout = KeyboardLayoutMap::with_capacity(DOM_KEY_CODES.len());
        let input_source = unsafe { TISCopyCurrentKeyboardLayoutInputSource() };
        if input_source.is_null() {
            return layout;
        }

        let layout_data =
            unsafe { TISGetInputSourceProperty(input_source, kTISPropertyUnicodeKeyLayoutData) };
        if layout_data.is_null() {
            unsafe { CFRelease(input_source) };
            return layout;
        }

        let keyboard_layout = unsafe { CFDataGetBytePtr(layout_data) }.cast::<c_void>();
        if keyboard_layout.is_null() {
            unsafe { CFRelease(input_source) };
            return layout;
        }

        let keyboard_type = unsafe { LMGetKbdType() } as u32;
        for &(code, virtual_key) in DOM_KEY_CODES {
            let Some(unshifted) = translate_key(keyboard_layout, virtual_key, 0, keyboard_type)
            else {
                continue;
            };
            let shifted = translate_key(keyboard_layout, virtual_key, 2, keyboard_type);
            layout.insert(
                code.to_owned(),
                vec![KeyboardLayoutEntry {
                    unshifted,
                    shifted,
                    alt_gr: None,
                    shifted_alt_gr: None,
                    other: Vec::new(),
                }],
            );
        }

        unsafe { CFRelease(input_source) };
        layout
    }

    unsafe extern "C" fn keyboard_layout_changed(
        _center: *const c_void,
        observer: *mut c_void,
        _name: *const c_void,
        _object: *const c_void,
        _user_info: *const c_void,
    ) {
        let app = unsafe { &*(observer.cast::<tauri::AppHandle>()) };
        let _ = app.emit(KEYBOARD_LAYOUT_CHANGED_EVENT, current_keyboard_layout_map());
    }

    pub fn install_keyboard_layout_change_listener(app: &tauri::AppHandle) {
        let app = APP_HANDLE.get_or_init(|| app.clone());
        INSTALL_LISTENER.call_once(|| unsafe {
            CFNotificationCenterAddObserver(
                CFNotificationCenterGetDistributedCenter(),
                std::ptr::from_ref(app).cast::<c_void>(),
                Some(keyboard_layout_changed),
                kTISNotifySelectedKeyboardInputSourceChanged,
                std::ptr::null(),
                4,
            );
        });
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{KeyboardLayoutEntry, KeyboardLayoutMap, KEYBOARD_LAYOUT_CHANGED_EVENT};
    use gdk::{Display, Keymap};
    use std::collections::BTreeMap;
    use tauri::Emitter;

    const DOM_KEY_CODES: &[(&str, u32)] = &[
        ("Digit1", 10),
        ("Digit2", 11),
        ("Digit3", 12),
        ("Digit4", 13),
        ("Digit5", 14),
        ("Digit6", 15),
        ("Digit7", 16),
        ("Digit8", 17),
        ("Digit9", 18),
        ("Digit0", 19),
        ("Minus", 20),
        ("Equal", 21),
        ("KeyQ", 24),
        ("KeyW", 25),
        ("KeyE", 26),
        ("KeyR", 27),
        ("KeyT", 28),
        ("KeyY", 29),
        ("KeyU", 30),
        ("KeyI", 31),
        ("KeyO", 32),
        ("KeyP", 33),
        ("BracketLeft", 34),
        ("BracketRight", 35),
        ("KeyA", 38),
        ("KeyS", 39),
        ("KeyD", 40),
        ("KeyF", 41),
        ("KeyG", 42),
        ("KeyH", 43),
        ("KeyJ", 44),
        ("KeyK", 45),
        ("KeyL", 46),
        ("Semicolon", 47),
        ("Quote", 48),
        ("Backquote", 49),
        ("Backslash", 51),
        ("KeyZ", 52),
        ("KeyX", 53),
        ("KeyC", 54),
        ("KeyV", 55),
        ("KeyB", 56),
        ("KeyN", 57),
        ("KeyM", 58),
        ("Comma", 59),
        ("Period", 60),
        ("Slash", 61),
        ("NumpadMultiply", 63),
        ("Space", 65),
        ("Numpad7", 79),
        ("Numpad8", 80),
        ("Numpad9", 81),
        ("NumpadSubtract", 82),
        ("Numpad4", 83),
        ("Numpad5", 84),
        ("Numpad6", 85),
        ("NumpadAdd", 86),
        ("Numpad1", 87),
        ("Numpad2", 88),
        ("Numpad3", 89),
        ("Numpad0", 90),
        ("NumpadDecimal", 91),
        ("IntlBackslash", 94),
        ("NumpadDivide", 106),
        ("NumpadEqual", 125),
        ("IntlRo", 97),
        ("IntlYen", 132),
    ];

    fn printable_key_value(keyval: u32) -> Option<String> {
        let character = gdk::keys::Key::from(keyval).to_unicode()?;
        (!character.is_control()).then(|| character.to_string())
    }

    pub fn current_keyboard_layout_map() -> KeyboardLayoutMap {
        let Some(display) = Display::default() else {
            return KeyboardLayoutMap::new();
        };
        let Some(keymap) = Keymap::for_display(&display) else {
            return KeyboardLayoutMap::new();
        };
        let mut layout = KeyboardLayoutMap::with_capacity(DOM_KEY_CODES.len());

        for &(code, hardware_keycode) in DOM_KEY_CODES {
            let mut groups: BTreeMap<i32, Vec<Option<String>>> = BTreeMap::new();
            for (key, keyval) in keymap.entries_for_keycode(hardware_keycode) {
                let level = key.level();
                if level < 0 {
                    continue;
                }
                let levels = groups.entry(key.group()).or_default();
                levels.resize(levels.len().max(level as usize + 1), None);
                levels[level as usize] = printable_key_value(keyval);
            }

            let entries = groups
                .into_values()
                .filter_map(|levels| {
                    let mut levels = levels.into_iter();
                    let unshifted = levels.next().flatten()?;
                    Some(KeyboardLayoutEntry {
                        unshifted,
                        shifted: levels.next().flatten(),
                        alt_gr: levels.next().flatten(),
                        shifted_alt_gr: levels.next().flatten(),
                        other: levels.flatten().collect(),
                    })
                })
                .collect::<Vec<_>>();
            if !entries.is_empty() {
                layout.insert(code.to_owned(), entries);
            }
        }

        layout
    }

    fn emit_layout_change(app: &tauri::AppHandle) {
        let _ = app.emit(KEYBOARD_LAYOUT_CHANGED_EVENT, current_keyboard_layout_map());
    }

    pub fn install_keyboard_layout_change_listener(app: &tauri::AppHandle) {
        let Some(display) = Display::default() else {
            return;
        };
        let Some(keymap) = Keymap::for_display(&display) else {
            return;
        };

        let keys_app = app.clone();
        keymap.connect_keys_changed(move |_| emit_layout_change(&keys_app));
        let state_app = app.clone();
        keymap.connect_state_changed(move |_| emit_layout_change(&state_app));
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{KeyboardLayoutEntry, KeyboardLayoutMap, KEYBOARD_LAYOUT_CHANGED_EVENT};
    use std::sync::OnceLock;
    use tauri::{Emitter, Manager};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyboardLayout, MapVirtualKeyExW, ToUnicodeEx, HKL, MAPVK_VSC_TO_VK_EX, VK_CONTROL,
        VK_MENU, VK_SHIFT,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{WM_INPUTLANGCHANGE, WM_NCDESTROY};

    const SUBCLASS_ID: usize = 0x5245_4454;
    const DOM_KEY_CODES: &[(&str, u32)] = &[
        ("Digit1", 0x02),
        ("Digit2", 0x03),
        ("Digit3", 0x04),
        ("Digit4", 0x05),
        ("Digit5", 0x06),
        ("Digit6", 0x07),
        ("Digit7", 0x08),
        ("Digit8", 0x09),
        ("Digit9", 0x0a),
        ("Digit0", 0x0b),
        ("Minus", 0x0c),
        ("Equal", 0x0d),
        ("KeyQ", 0x10),
        ("KeyW", 0x11),
        ("KeyE", 0x12),
        ("KeyR", 0x13),
        ("KeyT", 0x14),
        ("KeyY", 0x15),
        ("KeyU", 0x16),
        ("KeyI", 0x17),
        ("KeyO", 0x18),
        ("KeyP", 0x19),
        ("BracketLeft", 0x1a),
        ("BracketRight", 0x1b),
        ("KeyA", 0x1e),
        ("KeyS", 0x1f),
        ("KeyD", 0x20),
        ("KeyF", 0x21),
        ("KeyG", 0x22),
        ("KeyH", 0x23),
        ("KeyJ", 0x24),
        ("KeyK", 0x25),
        ("KeyL", 0x26),
        ("Semicolon", 0x27),
        ("Quote", 0x28),
        ("Backquote", 0x29),
        ("Backslash", 0x2b),
        ("KeyZ", 0x2c),
        ("KeyX", 0x2d),
        ("KeyC", 0x2e),
        ("KeyV", 0x2f),
        ("KeyB", 0x30),
        ("KeyN", 0x31),
        ("KeyM", 0x32),
        ("Comma", 0x33),
        ("Period", 0x34),
        ("Slash", 0x35),
        ("Space", 0x39),
        ("IntlBackslash", 0x56),
        ("IntlRo", 0x73),
        ("IntlYen", 0x7d),
    ];

    static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

    fn translate_key(layout: HKL, scan_code: u32, shift: bool, alt_graph: bool) -> Option<String> {
        let virtual_key = unsafe { MapVirtualKeyExW(scan_code, MAPVK_VSC_TO_VK_EX, Some(layout)) };
        if virtual_key == 0 {
            return None;
        }

        let mut keyboard_state = [0u8; 256];
        if shift {
            keyboard_state[VK_SHIFT.0 as usize] = 0x80;
        }
        if alt_graph {
            keyboard_state[VK_CONTROL.0 as usize] = 0x80;
            keyboard_state[VK_MENU.0 as usize] = 0x80;
        }
        let mut utf16 = [0u16; 8];
        let length = unsafe {
            ToUnicodeEx(
                virtual_key,
                scan_code,
                &keyboard_state,
                &mut utf16,
                4,
                Some(layout),
            )
        };
        if length == 0 {
            return None;
        }

        let length = usize::try_from(length.unsigned_abs()).ok()?;
        let value = String::from_utf16(utf16.get(..length)?).ok()?;
        let mut characters = value.chars();
        let character = characters.next()?;
        (characters.next().is_none() && !character.is_control()).then_some(value)
    }

    pub fn current_keyboard_layout_map() -> KeyboardLayoutMap {
        let layout_handle = unsafe { GetKeyboardLayout(0) };
        if layout_handle.is_invalid() {
            return KeyboardLayoutMap::new();
        }

        let mut layout = KeyboardLayoutMap::with_capacity(DOM_KEY_CODES.len());
        for &(code, scan_code) in DOM_KEY_CODES {
            let Some(unshifted) = translate_key(layout_handle, scan_code, false, false) else {
                continue;
            };
            layout.insert(
                code.to_owned(),
                vec![KeyboardLayoutEntry {
                    unshifted,
                    shifted: translate_key(layout_handle, scan_code, true, false),
                    alt_gr: translate_key(layout_handle, scan_code, false, true),
                    shifted_alt_gr: translate_key(layout_handle, scan_code, true, true),
                    other: Vec::new(),
                }],
            );
        }
        layout
    }

    unsafe extern "system" fn window_subclass(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        reference_data: usize,
    ) -> LRESULT {
        if message == WM_INPUTLANGCHANGE {
            let app = unsafe { &*(reference_data as *const tauri::AppHandle) };
            let _ = app.emit(KEYBOARD_LAYOUT_CHANGED_EVENT, current_keyboard_layout_map());
        } else if message == WM_NCDESTROY {
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(window_subclass), SUBCLASS_ID) };
        }
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    pub fn install_keyboard_layout_change_listener(app: &tauri::AppHandle) {
        let app = APP_HANDLE.get_or_init(|| app.clone());
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let _ = unsafe {
            SetWindowSubclass(
                hwnd,
                Some(window_subclass),
                SUBCLASS_ID,
                std::ptr::from_ref(app) as usize,
            )
        };
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    use super::KeyboardLayoutMap;

    pub fn current_keyboard_layout_map() -> KeyboardLayoutMap {
        KeyboardLayoutMap::new()
    }

    pub fn install_keyboard_layout_change_listener(_app: &tauri::AppHandle) {}
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::get_keyboard_layout_map;

    #[test]
    fn resolves_printable_keys_from_the_active_macos_layout() {
        const REQUIRED_CODES: &[&str] = &["KeyA", "Digit2", "Space"];
        let layout = get_keyboard_layout_map();

        for code in REQUIRED_CODES {
            let entries = layout
                .get(*code)
                .unwrap_or_else(|| panic!("missing layout value for {code}"));
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].unshifted.chars().count(), 1);
            assert_eq!(
                entries[0]
                    .shifted
                    .as_ref()
                    .map(|value| value.chars().count()),
                Some(1)
            );
        }
    }
}
