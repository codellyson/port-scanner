use std::sync::atomic::{AtomicU32, AtomicU64};
use std::sync::{Mutex, OnceLock};

use tauri_plugin_shell::process::CommandChild;

use crate::tray::MenuHandles;

/// What the server is actually doing, as far as the tray knows. Every variant
/// is something the menu can say out loud — the tray never shows a state it
/// cannot explain, and never claims "running" while the sidecar is dead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerState {
    /// Spawned, no READY line yet.
    Starting,
    /// READY seen. `url` is the origin the server bound to, e.g. `http://localhost:53421`.
    Ready { url: String },
    /// Exited on its own; a respawn is queued.
    Restarting { in_seconds: u64, reason: String },
    /// Gave up — either the binary is missing or it exited too many times.
    Failed { reason: String },
}

impl ServerState {
    /// The disabled first line of the menu.
    pub fn status_line(&self) -> String {
        match self {
            ServerState::Starting => "Starting server…".into(),
            ServerState::Ready { url } => format!("Running · {}", strip_scheme(url)),
            ServerState::Restarting { in_seconds, reason } => {
                format!("{reason} · retrying in {in_seconds}s")
            }
            ServerState::Failed { reason } => format!("Stopped · {reason}"),
        }
    }

    /// The tray tooltip. Same truth, prefixed so it stands alone on hover.
    pub fn tooltip(&self) -> String {
        format!("Port Scanner — {}", self.status_line())
    }

    pub fn ready_url(&self) -> Option<&str> {
        match self {
            ServerState::Ready { url } => Some(url),
            _ => None,
        }
    }
}

fn strip_scheme(url: &str) -> &str {
    url.strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url)
}

pub struct AppState {
    /// Bearer token minted once per app run and handed to the sidecar. Every
    /// restart reuses it, so a dashboard tab survives a restart.
    pub token: String,
    pub server: Mutex<ServerState>,
    pub child: Mutex<Option<CommandChild>>,
    /// Bumped on every spawn and every deliberate stop. A sidecar's event loop
    /// compares its own generation against this and goes quiet once it is
    /// stale, so a dying process cannot overwrite its replacement's state.
    pub generation: AtomicU64,
    /// Consecutive unexpected exits. Reset by a READY line.
    pub restarts: AtomicU32,
    pub menu: OnceLock<MenuHandles>,
}

impl AppState {
    pub fn new(token: String) -> Self {
        Self {
            token,
            server: Mutex::new(ServerState::Starting),
            child: Mutex::new(None),
            generation: AtomicU64::new(0),
            restarts: AtomicU32::new(0),
            menu: OnceLock::new(),
        }
    }

    pub fn set_child(&self, child: Option<CommandChild>) {
        if let Ok(mut slot) = self.child.lock() {
            *slot = child;
        }
    }

    pub fn take_child(&self) -> Option<CommandChild> {
        self.child.lock().ok().and_then(|mut slot| slot.take())
    }

    /// The dashboard URL with the token attached, or `None` until READY.
    pub fn dashboard_url(&self) -> Option<String> {
        let state = self.server.lock().ok()?;
        let url = state.ready_url()?;
        Some(format!("{}/?token={}", url, self.token))
    }
}
