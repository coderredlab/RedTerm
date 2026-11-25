use std::{mem, ptr};

use dwrote::{Font, FontCollection, FontStretch, FontStyle, FontWeight};

pub(super) fn retain_monospace(families: &mut Vec<String>) {
    if families.is_empty() {
        return;
    }
    // A collection failure propagates from the blocking task, not as an empty catalog.
    let collection = FontCollection::system();
    let (weight, stretch, style) = (FontWeight::Regular, FontStretch::Normal, FontStyle::Normal);
    let mut wide_name = Vec::new();
    families.retain(|name| {
        wide_name.clear();
        for unit in name.encode_utf16() {
            if unit == 0 {
                return false; // FindFamilyName would match only the prefix.
            }
            wide_name.push(unit);
        }
        wide_name.push(0);
        let mut index = 0;
        let mut found = 0;
        // SAFETY: the collection is live and wide_name is NUL-terminated for this call.
        let status = unsafe {
            (*collection.as_ptr()).FindFamilyName(wide_name.as_ptr(), &mut index, &mut found)
        };
        if status < 0 || found == 0 {
            return false;
        }
        let Ok(family) = collection.font_family(index) else {
            return false;
        };
        let Ok(font) = family.first_matching_font(weight, stretch, style) else {
            return false;
        };
        // Match the regular CSS request, including a family's closest available style.
        has_monospace_advances(&font)
    });
}

fn has_monospace_advances(font: &Font) -> bool {
    const CHARS: [u32; 2] = [b'i' as u32, b'M' as u32];
    let mut face = ptr::null_mut();
    // SAFETY: font owns the live IDWriteFont. A successful CreateFontFace returns
    // one owned reference, released after the queries. Each buffer holds two glyphs.
    unsafe {
        // dwrote's create_font_face asserts on failure (e.g. an unavailable font file).
        if (*font.as_ptr()).CreateFontFace(&mut face) < 0 || face.is_null() {
            return false;
        }
        let mut glyphs = [0; CHARS.len()];
        let mut metrics = [mem::zeroed(); CHARS.len()];
        let mut font_metrics = mem::zeroed();
        let measured =
            (*face).GetGlyphIndices(CHARS.as_ptr(), CHARS.len() as u32, glyphs.as_mut_ptr()) >= 0
                && !glyphs.contains(&0)
                && (*face).GetDesignGlyphMetrics(
                    glyphs.as_ptr(),
                    glyphs.len() as u32,
                    metrics.as_mut_ptr(),
                    0,
                ) >= 0;
        if measured {
            (*face).GetMetrics(&mut font_metrics);
        }
        (*face).Release();

        let [narrow, wide] = metrics.map(|glyph| glyph.advanceWidth);
        // Eight glyphs at 16px: abs(delta) * 8 * 16 / units_per_em < 0.5px.
        measured
            && narrow > 0
            && wide > 0
            && u64::from(narrow.abs_diff(wide)) * (8 * 16 * 2)
                < u64::from(font_metrics.designUnitsPerEm)
    }
}
