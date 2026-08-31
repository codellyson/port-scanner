#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use rand::distributions::Alphanumeric;
use rand::Rng;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_opener::OpenerExt;
use std::path::PathBuf;

use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct AppState {
    url: Mutex<Option<String>>,
    token: String,
    child: Mutex<Option<CommandChild>>,
}

fn generate_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn parse_ready_line(line: &str) -> Option<String> {
    // Format: "READY http://host:port token=..."
    let mut parts = line.split_whitespace();
    if parts.next()? != "READY" {
        return None;
    }
    parts.next().map(str::to_string)
}

fn dashboard_url(state: &AppState) -> Option<String> {
    let url = state.url.lock().ok()?.clone()?;
    Some(format!("{}/?token={}", url, state.token))
}

/// Path to the project's compiled entry point. In debug builds we resolve
/// it relative to CARGO_MANIFEST_DIR so `cargo tauri dev` finds it; release
/// builds will need a bundled sidecar (TODO: wire when packaging lands).
fn dev_node_entry() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("CARGO_MANIFEST_DIR has no parent")
        .join("dist")
        .join("index.js")
}

fn spawn_sidecar(app: &AppHandle) {
    let token = {
        let state = app.state::<AppState>();
        state.token.clone()
    };
    let handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let entry = dev_node_entry();
        if !entry.exists() {
            eprintln!(
                "Server entry not found at {}. Run `npm run build` first.",
                entry.display()
            );
            return;
        }

        let result = handle
            .shell()
            .command("node")
            .args([
                entry.to_string_lossy().as_ref(),
                "web",
                "--port",
                "0",
                "--token",
                &token,
                "--emit-ready",
            ])
            .spawn();

        let (mut rx, child) = match result {
            Ok(pair) => pair,
            Err(err) => {
                eprintln!("Failed to spawn ports-server sidecar: {err}");
                return;
            }
        };

        {
            let state = handle.state::<AppState>();
            *state.child.lock().unwrap() = Some(child);
        }

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(url) = parse_ready_line(&line) {
                        let state = handle.state::<AppState>();
                        *state.url.lock().unwrap() = Some(url);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("sidecar: {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(_) => {
                    let state = handle.state::<AppState>();
                    *state.url.lock().unwrap() = None;
                    *state.child.lock().unwrap() = None;
                    break;
                }
                _ => {}
            }
        }
    });
}

fn main() {
    let token = generate_token();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            url: Mutex::new(None),
            token,
            child: Mutex::new(None),
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            spawn_sidecar(app.handle());

            let open_item =
                MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            let icon = app
                .default_window_icon()
                .expect("default window icon configured in tauri.conf.json")
                .clone();

            TrayIconBuilder::with_id("main")
                .tooltip("Port Scanner")
                .icon(icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        let state = app.state::<AppState>();
                        match dashboard_url(&state) {
                            Some(url) => {
                                if let Err(err) = app.opener().open_url(url, None::<&str>) {
                                    eprintln!("Failed to open dashboard: {err}");
                                }
                            }
                            None => {
                                eprintln!("Dashboard URL not ready yet");
                            }
                        }
                    }
                    "quit" => {
                        let state = app.state::<AppState>();
                        let taken = state.child.lock().unwrap().take();
                        if let Some(child) = taken {
                            let _ = child.kill();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api: _, .. } = event {
            let state = app.state::<AppState>();
            let taken = state.child.lock().unwrap().take();
            if let Some(child) = taken {
                let _ = child.kill();
            }
        }
    });
}

