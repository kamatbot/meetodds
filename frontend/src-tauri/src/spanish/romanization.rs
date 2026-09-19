//! Display-only transliteration. The returned string must NEVER replace the
//! canonical text passed to the tutor, practice scorer or speech command.
//! Apple Core Foundation runs locally; no model, network or developer tools.

pub fn display_text(language: &str, text: &str) -> Result<String, String> {
    super::speech::validate_input(text)?;
    if !super::speech::contains_native_script(language, text) {
        return Ok(text.to_owned());
    }
    transliterate(text, language == "zh")
}

#[cfg(not(target_os = "macos"))]
fn transliterate(_text: &str, _mandarin: bool) -> Result<String, String> {
    Err("Local script transliteration is available on macOS.".into())
}

#[cfg(target_os = "macos")]
fn transliterate(text: &str, mandarin: bool) -> Result<String, String> {
    use std::{ffi::c_void, ptr};
    type CFStringRef = *const c_void;
    type CFMutableStringRef = *mut c_void;
    #[repr(C)]
    struct CFRange { location: isize, length: isize }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateMutable(allocator: *const c_void, capacity: isize) -> CFMutableStringRef;
        fn CFStringAppendCharacters(string: CFMutableStringRef, chars: *const u16, length: isize);
        fn CFStringTransform(string: CFMutableStringRef, range: *mut CFRange, transform: CFStringRef, reverse: u8) -> u8;
        fn CFStringGetLength(string: CFStringRef) -> isize;
        fn CFStringGetCharacters(string: CFStringRef, range: CFRange, buffer: *mut u16);
        fn CFRelease(value: *const c_void);
        static kCFStringTransformToLatin: CFStringRef;
        static kCFStringTransformMandarinLatin: CFStringRef;
    }
    struct OwnedString(CFMutableStringRef);
    impl Drop for OwnedString {
        fn drop(&mut self) {
            // SAFETY: a non-null Create-rule object, released exactly once.
            unsafe { CFRelease(self.0) };
        }
    }
    let utf16: Vec<u16> = text.encode_utf16().collect();
    // SAFETY: all pointers are valid for the synchronous calls. The CF object
    // is local to this thread, owns its characters, and is released via RAII.
    unsafe {
        let string = CFStringCreateMutable(ptr::null(), 0);
        if string.is_null() { return Err("Could not prepare readable text.".into()); }
        let string = OwnedString(string);
        CFStringAppendCharacters(string.0, utf16.as_ptr(), utf16.len() as isize);
        let transform = if mandarin { kCFStringTransformMandarinLatin } else { kCFStringTransformToLatin };
        if CFStringTransform(string.0, ptr::null_mut(), transform, 0) == 0 {
            return Err("Could not transliterate this phrase.".into());
        }
        let length = CFStringGetLength(string.0);
        if length <= 0 || length > 32768 { return Err("Invalid transliteration length.".into()); }
        let mut output = vec![0u16; length as usize];
        CFStringGetCharacters(string.0, CFRange { location: 0, length }, output.as_mut_ptr());
        String::from_utf16(&output).map_err(|_| "Invalid transliteration text.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn latin_text_is_never_rewritten() {
        for (lang, text) in [("hi", "Aap kaise hain?"), ("es", "¿Cómo estás?"), ("fr", "Ça va ?")] {
            assert_eq!(display_text(lang, text).unwrap(), text);
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_scripts_get_readable_display_without_changing_source() {
        let chinese = "你好";
        assert_eq!(display_text("zh", chinese).unwrap(), "nǐ hǎo");
        assert_eq!(chinese, "你好");
        let hindi = display_text("hi", "आप कैसे हैं?").unwrap();
        assert!(!super::super::speech::contains_native_script("hi", &hindi));
        assert!(hindi.chars().any(|c| c.is_ascii_alphabetic()));
    }
}
