#[tauri::command]
pub fn check_icloud_keychain() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        // Run: security list-keychains
        let output = Command::new("security")
            .arg("list-keychains")
            .output()
            .map_err(|e| format!("Failed to check keychains: {}", e))?;

        let keychains = String::from_utf8_lossy(&output.stdout);

        // Check if any iCloud keychain is present
        // iCloud keychains typically have long UUIDs or "iCloud" in path
        // More than 2 keychains usually indicates iCloud is active
        // (login.keychain + System.keychain = 2, anything more = likely iCloud)
        Ok(keychains.contains("iCloud") || keychains.lines().count() > 2)
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Not macOS - no iCloud
        Ok(false)
    }
}
