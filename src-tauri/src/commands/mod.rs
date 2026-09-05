pub mod app_commands;
pub mod keyboard_commands;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod local_shell_commands;
pub mod ssh_commands;
pub mod voice_input_commands;

pub use app_commands::*;
pub use keyboard_commands::*;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use local_shell_commands::*;
pub use ssh_commands::*;
pub use voice_input_commands::*;
