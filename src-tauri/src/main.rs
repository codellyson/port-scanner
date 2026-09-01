#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;
mod state;
mod tray;

use rand::distributions::Alphanumeric;
use rand::Rng;
use tauri::{Manager, RunEvent};

use state::AppState;

fn generate_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new(generate_token()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(all(desktop, not(debug_assertions)))]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

            // The tray comes up first so the very first thing the server does
            // — including failing to start — has somewhere to be reported.
            tray::build(app.handle())?;
            sidecar::spawn(app.handle());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // Quit runs a graceful stop before calling exit, so anything left
            // here is an exit we did not initiate. Take what is left, hard.
            let taken = app.state::<AppState>().take_child();
            if let Some(child) = taken {
                let _ = child.kill();
            }
        }
    });
}
