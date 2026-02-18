use tauri::command;

const NOSTR_SCHEME: &str = "nostr";

#[cfg(target_os = "macos")]
const BUNDLE_ID: &str = "com.noornote.desktop";

#[cfg(target_os = "linux")]
const DESKTOP_FILE: &str = "Noornote.desktop";

// ─── macOS: Launch Services FFI ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::string::CFString;
    use core_foundation::base::TCFType;

    type CFStringRef = *const core_foundation::string::__CFString;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyDefaultHandlerForURLScheme(scheme: CFStringRef) -> CFStringRef;
        fn LSSetDefaultHandlerForURLScheme(scheme: CFStringRef, handler: CFStringRef) -> i32;
    }

    pub fn get_default_handler(scheme: &str) -> Option<String> {
        let cf_scheme = CFString::new(scheme);
        unsafe {
            let handler = LSCopyDefaultHandlerForURLScheme(cf_scheme.as_concrete_TypeRef());
            if handler.is_null() {
                return None;
            }
            let handler_str = CFString::wrap_under_create_rule(handler);
            Some(handler_str.to_string())
        }
    }

    pub fn set_default_handler(scheme: &str, bundle_id: &str) -> Result<(), String> {
        let cf_scheme = CFString::new(scheme);
        let cf_bundle = CFString::new(bundle_id);
        let result = unsafe {
            LSSetDefaultHandlerForURLScheme(
                cf_scheme.as_concrete_TypeRef(),
                cf_bundle.as_concrete_TypeRef(),
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(format!("LSSetDefaultHandlerForURLScheme returned error code {}", result))
        }
    }
}

// ─── Linux: xdg-mime ────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux {
    use std::process::Command;

    pub fn get_default_handler(scheme: &str) -> Option<String> {
        let output = Command::new("xdg-mime")
            .args(["query", "default", &format!("x-scheme-handler/{}", scheme)])
            .output()
            .ok()?;
        let handler = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if handler.is_empty() { None } else { Some(handler) }
    }

    pub fn set_default_handler(scheme: &str, desktop_file: &str) -> Result<(), String> {
        let output = Command::new("xdg-mime")
            .args(["default", desktop_file, &format!("x-scheme-handler/{}", scheme)])
            .output()
            .map_err(|e| format!("Failed to run xdg-mime: {}", e))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!("xdg-mime failed: {}", String::from_utf8_lossy(&output.stderr)))
        }
    }
}

// ─── Tauri Commands ─────────────────────────────────────────────────────────

#[command]
pub fn is_default_nostr_handler() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        match macos::get_default_handler(NOSTR_SCHEME) {
            Some(handler) => Ok(handler.eq_ignore_ascii_case(BUNDLE_ID)),
            None => Ok(false),
        }
    }

    #[cfg(target_os = "linux")]
    {
        match linux::get_default_handler(NOSTR_SCHEME) {
            Some(handler) => Ok(handler == DESKTOP_FILE),
            None => Ok(false),
        }
    }
}

#[command]
pub fn set_default_nostr_handler() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::set_default_handler(NOSTR_SCHEME, BUNDLE_ID)
    }

    #[cfg(target_os = "linux")]
    {
        linux::set_default_handler(NOSTR_SCHEME, DESKTOP_FILE)
    }
}
