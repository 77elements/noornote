#[cfg(desktop)]
mod key_signer;
#[cfg(desktop)]
mod icloud_check;

#[cfg(desktop)]
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
#[cfg(mobile)]
#[allow(unused_imports)]
use tauri::Manager;

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
use tauri_plugin_log::{Target, TargetKind};

/// Write diagnostic info to accessible locations on Android.
#[cfg(target_os = "android")]
fn write_crash_log(msg: &str) {
  for path in [
    "/sdcard/Download/noornote-crash.log",
    "/storage/emulated/0/Download/noornote-crash.log",
  ] {
    let _ = std::fs::write(path, msg);
  }
  eprintln!("NOORNOTE CRASH: {msg}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  #[cfg(target_os = "android")]
  {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
      let msg = format!("PANIC: {info}");
      for path in [
        "/sdcard/Download/noornote-crash.log",
        "/storage/emulated/0/Download/noornote-crash.log",
      ] {
        let _ = std::fs::write(path, &msg);
      }
      default_hook(info);
    }));
  }

  // LogDir path resolution can fail on Android; use Stdout only on mobile.
  #[cfg(desktop)]
  let log_targets = vec![
    Target::new(TargetKind::Stdout),
    Target::new(TargetKind::LogDir { file_name: None }),
  ];
  #[cfg(mobile)]
  let log_targets = vec![Target::new(TargetKind::Stdout)];

  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(
      tauri_plugin_log::Builder::new()
        .targets(log_targets)
        .level(log::LevelFilter::Info)
        .build(),
    );

  #[cfg(desktop)]
  {
    builder = builder
      .plugin(tauri_plugin_keyring::init())
      .plugin(tauri_plugin_shell::init())
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
        key_signer::ensure_noorsigner_installed,
        key_signer::add_account_via_cli,
        key_signer::launch_daemon_silent,
        key_signer::has_noorsigner_accounts,
        key_signer::launch_daemon_with_password,
        key_signer::prepare_daemon_for_unlock,
        key_signer::submit_daemon_password,
        key_signer::remove_noorsigner_account,
        icloud_check::check_icloud_keychain
      ]);
  }

  #[cfg(target_os = "android")]
  {
    builder = builder.plugin(tauri_plugin_amber::init());
  }

  let app = builder
    .setup(|_app| {
      #[cfg(desktop)]
      if cfg!(debug_assertions) {
        let window = _app.get_webview_window("main").unwrap();
        let dev_mode = std::env::var("TAURI_DEV_MODE").unwrap_or_default();

        match dev_mode.as_str() {
          "wide" => {
            #[cfg(target_os = "macos")]
            if let Some(monitor) = window.current_monitor().ok().flatten() {
              let size = monitor.size();
              let position = monitor.position();
              let window_width = size.width - 50;
              let window_height = 1200;
              let x = position.x + ((size.width as i32 - window_width as i32) / 2) + 15;
              let y = position.y;
              let _ = window.set_size(tauri::PhysicalSize::new(window_width, window_height));
              let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
            #[cfg(target_os = "linux")]
            let _ = window.maximize();
            window.open_devtools();
          }
          "clean" => {}
          _ => {
            #[cfg(target_os = "linux")]
            let _ = window.maximize();
            window.open_devtools();
          }
        }
      }
      Ok(())
    })
    .build(tauri::generate_context!());

  match app {
    Ok(app) => {
      app.run(|_app_handle, _event| {
        #[cfg(desktop)]
        match &_event {
          RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } => {
            #[cfg(target_os = "macos")]
            {
              if let Some(window) = _app_handle.get_webview_window(label) {
                let _ = window.minimize();
                api.prevent_close();
              }
            }
            #[cfg(not(target_os = "macos"))]
            {
              let _ = (label, api);
              _app_handle.exit(0);
            }
          }
          #[cfg(target_os = "macos")]
          RunEvent::Reopen { .. } => {
            if let Some(window) = _app_handle.get_webview_window("main") {
              let _ = window.unminimize();
              let _ = window.set_focus();
            }
          }
          _ => {}
        }
      });
    }
    Err(e) => {
      let msg = format!("Tauri build failed: {e}\nDebug: {e:?}");
      eprintln!("NOORNOTE FATAL: {msg}");
      #[cfg(target_os = "android")]
      write_crash_log(&msg);
    }
  }
}
