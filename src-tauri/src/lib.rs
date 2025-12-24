mod key_signer;

use tauri::{Emitter, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_keyring::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_shell::init())
    // Log plugin for ALL builds (debug + release) - writes to OS log directory
    .plugin(
      tauri_plugin_log::Builder::new()
        .targets([
          Target::new(TargetKind::Stdout),
          Target::new(TargetKind::LogDir { file_name: None }),
        ])
        .level(log::LevelFilter::Info)
        .build(),
    )
    .plugin(
      tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
          if event.state == ShortcutState::Pressed {
            if shortcut.matches(Modifiers::SUPER, Code::Enter) {
              let _ = app.emit("global-shortcut", "search");
            } else if shortcut.matches(Modifiers::SUPER, Code::KeyK) {
              let _ = app.emit("global-shortcut", "search-alt");
            } else if shortcut.matches(Modifiers::SUPER, Code::ArrowLeft) {
              let _ = app.emit("global-shortcut", "navigate-back");
            } else if shortcut.matches(Modifiers::SUPER, Code::ArrowRight) {
              let _ = app.emit("global-shortcut", "navigate-forward");
            }
          }
        })
        .build()
    )
    .invoke_handler(tauri::generate_handler![
      key_signer::key_signer_request,
      key_signer::launch_key_signer,
      key_signer::check_trust_session,
      key_signer::cancel_key_signer_launch,
      key_signer::ensure_noorsigner_installed
    ])
    .setup(|app| {
      // Register global keyboard shortcuts
      // register_global_shortcuts(app)?;
      if cfg!(debug_assertions) {
        use tauri::Manager;
        let window = app.get_webview_window("main").unwrap();

        // Check TAURI_DEV_MODE environment variable
        let dev_mode = std::env::var("TAURI_DEV_MODE").unwrap_or_default();

        match dev_mode.as_str() {
          "wide" => {
            // Wide mode: Full screen width with DevTools open (minus 50px for macOS Dock)
            if let Some(monitor) = window.current_monitor().ok().flatten() {
              let size = monitor.size();
              let position = monitor.position();
              let window_width = size.width - 50;
              let window_height = 1200;

              // Center horizontally with 15px offset to avoid Dock
              let x = position.x + ((size.width as i32 - window_width as i32) / 2) + 15;
              let y = position.y;

              let _ = window.set_size(tauri::PhysicalSize::new(window_width, window_height));
              let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
            window.open_devtools();
          }
          "clean" => {
            // Clean mode: Normal size, no DevTools
            // Window size from tauri.conf.json (1400x1200)
          }
          _ => {
            // Default: Open DevTools (backwards compatible)
            window.open_devtools();
          }
        }
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      if let RunEvent::WindowEvent { event: WindowEvent::CloseRequested { .. }, .. } = event {
        // Properly exit the app when window close is requested
        app_handle.exit(0);
      }
    });
}
