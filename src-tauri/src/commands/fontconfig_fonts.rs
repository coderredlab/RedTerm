use std::borrow::Cow;

use font_kit::{
    font::Font,
    handle::Handle,
    properties::{Properties, Style},
    source::SystemSource,
};

// font-kit passes this value to FcNameParse, not a literal family lookup.
fn family_pattern(name: &str) -> Cow<'_, str> {
    let generic = matches!(name, "serif" | "monospace" | "cursive" | "fantasy");
    let escape = |c: char| matches!(c, '-' | ':' | ',' | '\\');
    let escapes = name.chars().filter(|&c| escape(c)).count();
    if !generic && escapes == 0 {
        return Cow::Borrowed(name);
    }
    let mut pattern = String::with_capacity(name.len() + escapes + usize::from(generic));
    if generic {
        pattern.push('\\');
    }
    for c in name.chars() {
        if escape(c) {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    Cow::Owned(pattern)
}

fn regular_face(handles: &[Handle]) -> Option<Font> {
    let mut best = None;
    for handle in handles {
        let Ok(font) = handle.load() else { continue };
        let props = font.properties();
        if props == Properties::new() {
            return Some(font);
        }
        // CSS normal face: match stretch, then style, then weight. Keep the
        // measured face itself; unreadable siblings must not shift its index.
        let stretch = props.stretch.0;
        let style = match props.style {
            Style::Normal => 0,
            Style::Oblique => 1,
            Style::Italic => 2,
        };
        let weight = props.weight.0;
        let weight_group = if weight > 500.0 {
            2
        } else if weight < 400.0 {
            1
        } else {
            0
        };
        let rank = (
            stretch > 1.0,
            (stretch - 1.0).abs(),
            style,
            weight_group,
            (weight - 400.0).abs(),
        );
        if best.as_ref().is_none_or(|(current, _)| rank < *current) {
            best = Some((rank, font));
        }
    }
    best.map(|(_, font)| font)
}

fn is_monospace(font: &Font) -> bool {
    let advance = |ch| {
        let glyph = font.glyph_for_char(ch).filter(|&id| id != 0)?;
        font.advance(glyph).ok().map(|v| v.x())
    };
    let (Some(narrow), Some(wide)) = (advance('i'), advance('M')) else {
        return false;
    };
    // The worker compares eight glyphs at 16px, within half a pixel.
    narrow > 0.0
        && wide > 0.0
        && (narrow == wide || (narrow - wide).abs() * 256.0 < font.metrics().units_per_em as f32)
}

pub(super) fn retain_monospace(source: &SystemSource, families: &mut Vec<String>) {
    families.retain(|name| {
        source
            .select_family_by_name(&family_pattern(name))
            .ok()
            .and_then(|family| regular_face(family.fonts()))
            .is_some_and(|font| is_monospace(&font))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn broken_style_before_a_readable_monospace_face_does_not_hide_the_family() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let faces = [
            Handle::from_path(root.join("Cargo.toml"), 0),
            Handle::from_path(
                root.join("../static/fonts/sarasa-term-k-regular-nerd-font.ttf"),
                0,
            ),
        ];
        assert!(regular_face(&faces).is_some_and(|font| is_monospace(&font)));
    }
}
