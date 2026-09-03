//! The menu bar item and its menu.
//!
//! The menu is the app's entire interface, so it carries the state instead of
//! hiding it: the first two lines say what the server and the tunnel edge are
//! actually doing, and every action that cannot work right now is disabled
//! rather than failing silently when clicked.

use std::path::Path;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::sidecar;
use crate::state::AppState;
use crate::updater;

const TRAY_ID: &str = "main";

/// Menu entries the app updates after creation.
pub struct MenuHandles {
    status: MenuItem<Wry>,
    tunnels: MenuItem<Wry>,
    open: MenuItem<Wry>,
    copy: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    update: MenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();

    let status = MenuItem::with_id(
        app,
        "status",
        state
            .server
            .lock()
            .map(|s| s.status_line())
            .unwrap_or_else(|_| "Status unavailable".into()),
        false,
        None::<&str>,
    )?;
    let tunnels = MenuItem::with_id(
        app,
        "tunnels",
        sidecar::edge_config(app).status_line(),
        false,
        None::<&str>,
    )?;

    let open = MenuItem::with_id(app, "open", "Open Dashboard", false, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy", "Copy Dashboard URL", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Server", true, None::<&str>)?;
    let edge = MenuItem::with_id(app, "edge", "Edit Edge Config…", true, None::<&str>)?;

    // A dev build registers whatever binary cargo just produced, which is not
    // something anyone wants surviving in their login items.
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        if cfg!(debug_assertions) {
            "Start at Login (release builds only)"
        } else {
            "Start at Login"
        },
        !cfg!(debug_assertions),
        autostart_enabled(app),
        None::<&str>,
    )?;

    let (update_label, update_enabled) = update_menu_item(app);
    let update = MenuItem::with_id(app, "update", update_label, update_enabled, None::<&str>)?;

    let quit = MenuItem::with_id(app, "quit", "Quit Port Scanner", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status,
            &tunnels,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &copy,
            &PredefinedMenuItem::separator(app)?,
            &restart,
            &edge,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &update,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    // macOS tints template images from their alpha channel, so tray.png is a
    // black glyph. Windows and Linux draw the pixels as-is, so they get the
    // coloured variant instead of an invisible black-on-dark smudge.
    let icon = if cfg!(target_os = "macos") {
        Image::from_bytes(include_bytes!("../icons/tray.png"))?
    } else {
        Image::from_bytes(include_bytes!("../icons/tray-color.png"))?
    };

    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(
            state
                .server
                .lock()
                .map(|s| s.tooltip())
                .unwrap_or_else(|_| "Port Scanner".into()),
        )
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .build(app)?;

    drop(state);

    let handles = MenuHandles {
        status,
        tunnels,
        open,
        copy,
        autostart,
        update,
    };
    let _ = app.state::<AppState>().menu.set(handles);

    Ok(())
}

/// Repaints the menu from the current state. Safe to call from any thread, and
/// a no-op until [`build`] has run.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(menu) = state.menu.get() else {
        return;
    };

    // Read everything out and drop the lock before touching a menu API. Those
    // calls hand the work to the main thread and block until it finishes, and
    // the main thread may itself be inside a menu handler waiting on this very
    // lock — holding it across the call would deadlock both.
    let (status_line, tooltip, ready) = {
        let Ok(server) = state.server.lock() else {
            return;
        };
        (
            server.status_line(),
            server.tooltip(),
            server.ready_url().is_some(),
        )
    };

    let _ = menu.status.set_text(status_line);
    let _ = menu.tunnels.set_text(sidecar::edge_config(app).status_line());
    let _ = menu.open.set_enabled(ready);
    let _ = menu.copy.set_enabled(ready);

    let (update_label, update_enabled) = update_menu_item(app);
    let _ = menu.update.set_text(update_label);
    let _ = menu.update.set_enabled(update_enabled);

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        "open" => match app.state::<AppState>().dashboard_url() {
            Some(url) => {
                if let Err(err) = app.opener().open_url(url, None::<&str>) {
                    eprintln!("Failed to open dashboard: {err}");
                }
            }
            // The item is disabled until READY, so this is unreachable in
            // practice; refresh rather than pretending something happened.
            None => refresh(app),
        },

        "copy" => match app.state::<AppState>().dashboard_url() {
            Some(url) => {
                if let Err(err) = app.clipboard().write_text(url) {
                    eprintln!("Failed to copy dashboard URL: {err}");
                }
            }
            None => refresh(app),
        },

        "restart" => sidecar::restart(app),

        "edge" => match sidecar::ensure_edge_env_file(app) {
            Ok(path) => open_in_text_editor(app, &path),
            Err(err) => eprintln!("Failed to create edge config: {err}"),
        },

        "autostart" => toggle_autostart(app),

        "update" => updater::on_menu_click(app),

        "quit" => sidecar::quit(app),

        _ => {}
    }
}

/// Opens `edge.env` for editing. Nothing claims the `.env` extension on macOS
/// (and usually nothing on Windows), so a plain "open" fails — and in a tray
/// app a failure that only reaches stderr looks exactly like a click that
/// did nothing. Ask for the text editor instead, and if even that fails,
/// reveal the file so there is at least something on screen.
fn open_in_text_editor(app: &AppHandle, path: &Path) {
    #[cfg(target_os = "macos")]
    {
        // `open -t` uses whatever the user picked for plain-text files.
        let status = std::process::Command::new("open")
            .arg("-t")
            .arg(path)
            .status();
        if matches!(status, Ok(s) if s.success()) {
            return;
        }
    }

    let with: Option<&str> = if cfg!(windows) { Some("notepad") } else { None };
    if let Err(err) = app.opener().open_path(path.to_string_lossy(), with) {
        eprintln!("Failed to open edge config in an editor: {err}");
        if let Err(err) = app.opener().reveal_item_in_dir(path) {
            eprintln!("Failed to reveal edge config: {err}");
        }
    }
}

/// Label and enabled flag for the updater item. The lock is released before
/// this returns, so callers can hand the result to a menu API safely.
fn update_menu_item(app: &AppHandle) -> (String, bool) {
    if !updater::SUPPORTED {
        return ("Check for Updates (release builds only)".into(), false);
    }
    let version = app.package_info().version.to_string();
    app.state::<AppState>()
        .update
        .lock()
        .map(|update| update.menu_item(&version))
        .unwrap_or_else(|_| ("Check for Updates…".into(), false))
}

#[cfg(all(desktop, not(debug_assertions)))]
fn autostart_enabled(app: &AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(not(all(desktop, not(debug_assertions))))]
fn autostart_enabled(_app: &AppHandle) -> bool {
    false
}

#[cfg(all(desktop, not(debug_assertions)))]
fn toggle_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);
    let result = if enabled {
        manager.disable()
    } else {
        manager.enable()
    };

    if let Err(err) = result {
        eprintln!("Failed to change login item: {err}");
    }

    // muda already flipped the check mark on click, so re-read the truth
    // instead of trusting it — a failed enable must not look like a success.
    if let Some(menu) = app.state::<AppState>().menu.get() {
        let _ = menu
            .autostart
            .set_checked(manager.is_enabled().unwrap_or(false));
    }
}

#[cfg(not(all(desktop, not(debug_assertions))))]
fn toggle_autostart(app: &AppHandle) {
    if let Some(menu) = app.state::<AppState>().menu.get() {
        let _ = menu.autostart.set_checked(false);
    }
}
