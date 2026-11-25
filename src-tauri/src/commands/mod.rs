pub mod app_commands;
#[cfg(not(any(
    target_os = "android",
    target_os = "ios",
    target_os = "macos",
    target_os = "windows"
)))]
mod fontconfig_fonts;
pub mod keyboard_commands;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod local_shell_commands;
#[cfg(target_os = "macos")]
mod macos_fonts;
pub mod ssh_commands;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod terminal_path_commands;
pub mod voice_input_commands;
#[cfg(target_os = "windows")]
mod windows_fonts;

pub use app_commands::*;
pub use keyboard_commands::*;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use local_shell_commands::*;
pub use ssh_commands::*;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use terminal_path_commands::*;
pub use voice_input_commands::*;
