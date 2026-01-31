/**
 * KeySigner Tauri Commands - Unix (Mac/Linux)
 * Handles communication with NoorSigner Unix socket daemon
 *
 * Windows: siehe key_signer_windows.rs
 */

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use tauri::command;

/// Get the base path for NoorNote data (~/.noornote/)
fn get_noornote_base_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "Failed to get HOME directory".to_string())?;
    Ok(PathBuf::from(home).join(".noornote"))
}

/// Get socket path - under ~/.noorsigner/
fn get_socket_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "Failed to get HOME directory".to_string())?;
    Ok(PathBuf::from(home).join(".noorsigner").join("noorsigner.sock"))
}

/// Get NoorSigner binary path - ~/.noornote/bin/noorsigner
fn get_noorsigner_path() -> Result<PathBuf, String> {
    Ok(get_noornote_base_path()?.join("bin").join("noorsigner"))
}

/// Get the sidecar binary path from the app bundle
fn get_sidecar_source_path() -> Result<PathBuf, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {}", e))?;

    let exe_dir = exe_path.parent()
        .ok_or_else(|| "Failed to get executable directory".to_string())?;

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let target_triple = "x86_64-unknown-linux-gnu";

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let target_triple = "aarch64-unknown-linux-gnu";

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let target_triple = "x86_64-apple-darwin";

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let target_triple = "aarch64-apple-darwin";

    let sidecar_with_triple = format!("noorsigner-{}", target_triple);
    let sidecar_simple = "noorsigner".to_string();

    let possible_paths = [
        exe_dir.join(&sidecar_simple),
        exe_dir.join(&sidecar_with_triple),
        exe_dir.join("../Resources").join(&sidecar_with_triple),
        exe_dir.join("../../binaries").join(&sidecar_with_triple),
    ];

    for path in &possible_paths {
        if path.exists() {
            return Ok(path.clone());
        }
    }

    Err(format!(
        "NoorSigner sidecar not found. Searched for '{}' or '{}' in: {:?}",
        sidecar_simple,
        sidecar_with_triple,
        possible_paths
    ))
}

/// Ensure NoorSigner is installed and up-to-date at ~/.noornote/bin/noorsigner
#[command]
pub async fn ensure_noorsigner_installed() -> Result<String, String> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let target_path = get_noorsigner_path()?;
    let target_dir = target_path.parent()
        .ok_or_else(|| "Failed to get target directory".to_string())?;

    if !target_dir.exists() {
        fs::create_dir_all(target_dir)
            .map_err(|e| format!("Failed to create directory {:?}: {}", target_dir, e))?;
    }

    let needs_install = if target_path.exists() {
        // Compare with sidecar to detect updates (different size = different version)
        match get_sidecar_source_path() {
            Ok(source) => {
                let source_len = fs::metadata(&source).map(|m| m.len()).unwrap_or(0);
                let target_len = fs::metadata(&target_path).map(|m| m.len()).unwrap_or(0);
                if source_len != target_len && source_len > 0 {
                    println!("NoorSigner update available ({} → {} bytes)", target_len, source_len);
                    let _ = fs::remove_file(&target_path);
                    true
                } else {
                    false
                }
            }
            Err(_) => false
        }
    } else {
        true
    };

    if !needs_install {
        return Ok(target_path.display().to_string());
    }

    let source_path = get_sidecar_source_path()?;

    fs::copy(&source_path, &target_path)
        .map_err(|e| format!("Failed to copy NoorSigner from {:?} to {:?}: {}", source_path, target_path, e))?;

    let mut perms = fs::metadata(&target_path)
        .map_err(|e| format!("Failed to get permissions: {}", e))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&target_path, perms)
        .map_err(|e| format!("Failed to set executable permission: {}", e))?;

    println!("NoorSigner installed/updated at: {:?}", target_path);
    Ok(target_path.display().to_string())
}

/// Send JSON-RPC request to KeySigner daemon via Unix socket
#[command]
pub async fn key_signer_request(request: String) -> Result<String, String> {
    use std::time::Duration;

    let socket_path = get_socket_path()?;

    let mut stream = UnixStream::connect(&socket_path)
        .map_err(|e| format!("Failed to connect to KeySigner daemon: {}. Is the daemon running?", e))?;

    stream.set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| format!("Failed to set read timeout: {}", e))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| format!("Failed to set write timeout: {}", e))?;

    let request_with_newline = format!("{}\n", request);
    stream.write_all(request_with_newline.as_bytes())
        .map_err(|e| format!("Failed to send request: {}", e))?;

    let mut reader = BufReader::new(&mut stream);
    let mut response = String::new();
    reader.read_line(&mut response)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock {
                "Request timed out - daemon may have crashed or is unresponsive".to_string()
            } else {
                format!("Failed to read response: {}", e)
            }
        })?;

    Ok(response.trim_end().to_string())
}

/// Check if Trust Mode session is valid
#[command]
pub async fn check_trust_session() -> Result<bool, String> {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    let home = std::env::var("HOME")
        .map_err(|_| "Failed to get HOME directory".to_string())?;
    let noorsigner_dir = PathBuf::from(&home).join(".noorsigner");

    // Try new multi-account path first: ~/.noorsigner/accounts/<npub>/trust_session
    let mut trust_session_path = noorsigner_dir.join("trust_session"); // fallback to old path

    let active_account_path = noorsigner_dir.join("active_account");
    if active_account_path.exists() {
        if let Ok(active_npub) = fs::read_to_string(&active_account_path) {
            let active_npub = active_npub.trim();
            if !active_npub.is_empty() {
                let new_path = noorsigner_dir
                    .join("accounts")
                    .join(active_npub)
                    .join("trust_session");
                if new_path.exists() {
                    trust_session_path = new_path;
                }
            }
        }
    }

    if !trust_session_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&trust_session_path)
        .map_err(|e| format!("Failed to read trust session: {}", e))?;

    let parts: Vec<&str> = content.split(':').collect();
    if parts.len() != 4 {
        return Ok(false);
    }

    let expires_unix: i64 = parts[1]
        .parse()
        .map_err(|_| "Invalid expiry timestamp".to_string())?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Failed to get current time".to_string())?
        .as_secs() as i64;

    Ok(now < expires_unix)
}

/// Cancel KeySigner launch by killing any running noorsigner daemon process
#[command]
pub async fn cancel_key_signer_launch() -> Result<(), String> {
    use std::process::Command;

    let output = Command::new("pkill")
        .arg("-f")
        .arg("noorsigner.*daemon")
        .output()
        .map_err(|e| format!("Failed to kill noorsigner process: {}", e))?;

    if output.status.success() {
        println!("Killed noorsigner daemon process - terminal should close");
    } else {
        println!("No noorsigner daemon process found to kill");
    }
    Ok(())
}

/// Add account via CLI with stdin (when daemon is not running)
/// Input: JSON string {"nsec": "...", "password": "..."}
/// Returns: JSON response from noorsigner
#[command]
pub async fn add_account_via_cli(json_input: String) -> Result<String, String> {
    use std::process::{Command, Stdio};

    ensure_noorsigner_installed().await?;
    let noorsigner_path = get_noorsigner_path()?;

    if !noorsigner_path.exists() {
        return Err(format!(
            "NoorSigner binary not found at: {}",
            noorsigner_path.display()
        ));
    }

    let mut child = Command::new(&noorsigner_path)
        .arg("add-account")
        .arg("--stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn noorsigner: {}", e))?;

    // Write JSON to stdin
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(json_input.as_bytes())
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
    }

    // Wait for completion and get output
    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to wait for noorsigner: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!("noorsigner failed: {} {}", stdout.trim(), stderr.trim()))
    }
}

/// Launch NoorSigner daemon silently in background (no terminal)
/// Used after adding account via CLI when trust session is already created
#[command]
pub async fn launch_daemon_silent() -> Result<(), String> {
    use std::process::Command;
    use std::os::unix::process::CommandExt;

    ensure_noorsigner_installed().await?;
    let noorsigner_path = get_noorsigner_path()?;

    if !noorsigner_path.exists() {
        return Err(format!(
            "NoorSigner binary not found at: {}",
            noorsigner_path.display()
        ));
    }

    let socket_path = get_socket_path()?;
    if socket_path.exists() {
        // Daemon already running
        return Ok(());
    }

    Command::new(&noorsigner_path)
        .arg("daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Failed to launch daemon: {}", e))?;

    // Wait for socket to appear
    use std::time::{Duration, Instant};
    let start = Instant::now();
    let timeout = Duration::from_secs(5);

    while start.elapsed() < timeout {
        if socket_path.exists() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    Ok(()) // Return OK even if socket doesn't appear - daemon might still be starting
}

/// Launch NoorSigner CLI binary
#[command]
pub async fn launch_key_signer(mode: String) -> Result<(), String> {
    use std::process::Command;
    use std::os::unix::process::CommandExt;

    ensure_noorsigner_installed().await?;

    let noorsigner_path = get_noorsigner_path()?;

    if !noorsigner_path.exists() {
        return Err(format!(
            "NoorSigner binary not found at: {}",
            noorsigner_path.display()
        ));
    }

    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&noorsigner_path)
            .map_err(|e| format!("Failed to get binary permissions: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&noorsigner_path, perms)
            .map_err(|e| format!("Failed to set binary permissions: {}", e))?;
    }

    let cmd = match mode.as_str() {
        "init" => "init",
        "daemon" => "daemon",
        "add-account" => "add-account",
        _ => return Err(format!("Invalid mode: {}", mode)),
    };

    println!("Launching NoorSigner: {} {}", noorsigner_path.display(), cmd);

    let has_trust_session = check_trust_session().await.unwrap_or(false);
    let socket_path = get_socket_path()?;
    let daemon_already_running = socket_path.exists();

    println!("Trust session valid: {}", has_trust_session);
    println!("Daemon already running: {}", daemon_already_running);

    if has_trust_session && !daemon_already_running && mode == "daemon" {
        println!("Trust session valid + daemon not running - attempting background launch...");

        Command::new(&noorsigner_path)
            .arg(cmd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("Failed to launch NoorSigner in background: {}", e))?;

        println!("Background daemon launched - waiting for socket to appear...");

        use std::time::{Duration, Instant};
        let start = Instant::now();
        let timeout = Duration::from_secs(3);

        while start.elapsed() < timeout {
            if socket_path.exists() {
                println!("Socket appeared - daemon started successfully!");
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        println!("Socket did not appear - trust session likely invalid, falling back to terminal launch");

        let home = std::env::var("HOME")
            .map_err(|_| "Failed to get HOME directory".to_string())?;
        let trust_session_path = PathBuf::from(home).join(".noorsigner").join("trust_session");

        if trust_session_path.exists() {
            let _ = std::fs::remove_file(&trust_session_path);
            println!("Removed invalid trust session file");
        }
    }

    println!("Launching in terminal for user input");

    #[cfg(target_os = "macos")]
    {
        let terminal_command = format!("{} {}", noorsigner_path.display(), cmd);
        let applescript = format!(
            "tell application \"Terminal\"\n\
             activate\n\
             do script \"{}\"\n\
             end tell",
            terminal_command
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&applescript)
            .output()
            .map_err(|e| format!("Failed to launch Terminal.app: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("osascript failed: {}", stderr));
        }
    }

    #[cfg(target_os = "linux")]
    {
        let terminals = ["gnome-terminal", "konsole", "xterm"];
        let mut launched = false;

        for terminal in &terminals {
            let result = if *terminal == "gnome-terminal" {
                Command::new(terminal)
                    .arg("--")
                    .arg(noorsigner_path.to_str().unwrap())
                    .arg(cmd)
                    .spawn()
            } else {
                Command::new(terminal)
                    .arg("-e")
                    .arg(format!("{} {}", noorsigner_path.display(), cmd))
                    .spawn()
            };

            if result.is_ok() {
                launched = true;
                break;
            }
        }

        if !launched {
            return Err("No terminal emulator found. Please install gnome-terminal, konsole, or xterm.".to_string());
        }
    }

    println!("NoorSigner launched successfully");
    Ok(())
}

/// Check if any NoorSigner accounts exist (~/.noorsigner/accounts/ has subdirectories)
#[command]
pub async fn has_noorsigner_accounts() -> Result<bool, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "Failed to get HOME directory".to_string())?;
    let accounts_dir = PathBuf::from(home).join(".noorsigner").join("accounts");

    if !accounts_dir.exists() {
        return Ok(false);
    }

    let entries = std::fs::read_dir(&accounts_dir)
        .map_err(|e| format!("Failed to read accounts directory: {}", e))?;

    for entry in entries {
        if let Ok(entry) = entry {
            if entry.path().is_dir() {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

/// Launch NoorSigner daemon with password piped via stdin (silent, no terminal)
/// Used when trust session is expired and silent mode is enabled
#[command]
pub async fn launch_daemon_with_password(password: String) -> Result<String, String> {
    use std::process::{Command, Stdio};

    ensure_noorsigner_installed().await?;
    let noorsigner_path = get_noorsigner_path()?;

    if !noorsigner_path.exists() {
        return Err(format!(
            "NoorSigner binary not found at: {}",
            noorsigner_path.display()
        ));
    }

    let socket_path = get_socket_path()?;
    if socket_path.exists() {
        // Daemon already running
        return Ok("already_running".to_string());
    }

    let mut child = Command::new(&noorsigner_path)
        .arg("daemon")
        .arg("--password-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch daemon: {}", e))?;

    // Write password to stdin
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let password_with_newline = format!("{}\n", password);
        stdin.write_all(password_with_newline.as_bytes())
            .map_err(|e| format!("Failed to write password: {}", e))?;
    }

    // Wait for socket to appear (daemon forks to background after password validation)
    use std::time::{Duration, Instant};
    let start = Instant::now();
    let timeout = Duration::from_secs(5);

    while start.elapsed() < timeout {
        if socket_path.exists() {
            return Ok("success".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // Socket didn't appear - check if process exited with error
    match child.try_wait() {
        Ok(Some(_status)) => {
            let output = child.wait_with_output()
                .map_err(|e| format!("Failed to read output: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("Invalid password") {
                return Err("invalid_password".to_string());
            }
            Err(format!("Daemon failed to start: {}", stdout.trim()))
        }
        _ => {
            Err("Daemon did not start within timeout".to_string())
        }
    }
}

/// Remove a NoorSigner account directory (~/.noorsigner/accounts/<npub>/)
/// Used during onboarding cancellation when no password has been set yet.
#[command]
pub async fn remove_noorsigner_account(npub: String) -> Result<(), String> {
    use std::fs;

    if npub.is_empty() || !npub.starts_with("npub1") {
        return Err("Invalid npub".to_string());
    }

    let home = std::env::var("HOME")
        .map_err(|_| "Failed to get HOME directory".to_string())?;
    let noorsigner_dir = PathBuf::from(&home).join(".noorsigner");
    let account_dir = noorsigner_dir.join("accounts").join(&npub);

    if account_dir.exists() {
        fs::remove_dir_all(&account_dir)
            .map_err(|e| format!("Failed to remove account directory: {}", e))?;
    }

    // Clear active_account if it points to the removed account
    let active_file = noorsigner_dir.join("active_account");
    if active_file.exists() {
        if let Ok(active_npub) = fs::read_to_string(&active_file) {
            if active_npub.trim() == npub {
                let _ = fs::remove_file(&active_file);
            }
        }
    }

    Ok(())
}
