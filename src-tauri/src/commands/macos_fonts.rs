use core_foundation::{base::TCFType, dictionary::CFDictionary, string::CFString};
use core_text::{
    font::new_from_descriptor,
    font_descriptor::{
        kCTFontFamilyNameAttribute, kCTFontOrientationHorizontal, new_from_attributes,
    },
};

pub(super) fn retain_monospace(families: &mut Vec<String>) {
    // Keep matching and measuring in CoreText: installed faces need not be
    // standalone OpenType files that a separate file loader can reopen.
    // SAFETY: CoreText owns this constant for the lifetime of the process.
    let family_key = unsafe { CFString::wrap_under_get_rule(kCTFontFamilyNameAttribute) };
    families.retain(|name| {
        let attrs = CFDictionary::from_CFType_pairs(&[(
            family_key.clone(),
            CFString::new(name).as_CFType(),
        )]);
        let font = new_from_descriptor(&new_from_attributes(&attrs), 16.0);
        let chars = [u16::from(b'i'), u16::from(b'M')];
        let mut glyphs = [0; 2];
        let mut advances = [Default::default(); 2];
        // SAFETY: both calls read and write exactly two stack array elements.
        unsafe {
            if !font.get_glyphs_for_characters(chars.as_ptr(), glyphs.as_mut_ptr(), 2)
                || glyphs.contains(&0)
            {
                return false;
            }
            font.get_advances_for_glyphs(
                kCTFontOrientationHorizontal,
                glyphs.as_ptr(),
                advances.as_mut_ptr(),
                2,
            );
        }
        let [narrow, wide] = advances;
        narrow.width > 0.0 && wide.width > 0.0 && (narrow.width - wide.width).abs() * 8.0 < 0.5
    });
}
