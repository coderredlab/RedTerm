pub mod connections;

pub use connections::*;

/// The original name first, then "name (1).ext", "name (2).ext", and so on.
/// Callers must claim a candidate exclusively, not check then overwrite it.
pub(crate) fn unique_destination_names(file_name: &str) -> impl Iterator<Item = String> {
    let path = std::path::Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .to_string();
    let extension = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    std::iter::once(file_name.to_string())
        .chain((1..1000u32).map(move |index| format!("{} ({}){}", stem, index, extension)))
}
