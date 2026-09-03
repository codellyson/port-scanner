//! Spawning and supervising the `ports web` server process.
//!
//! The tray owns exactly one server process at a time. It is spawned from the
//! bundled sidecar in release builds and from `../dist/index.js` via `node`
//! during `cargo tauri dev`, restarted with backoff when it dies on its own,
//! and stopped SIGTERM-first so the server can close its tunnels on the way
//! out (see the `cleanup` handler in `src/web/server.ts`).

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{Command, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::state::{AppState, ServerState};
use crate::tray;

/// Matches the tunnel client's reconnect ladder in `src/web/tunnelManager.ts`.
const RESTART_DELAYS_SECS: [u64; 6] = [1, 2, 4, 8, 16, 30];
/// How long the server gets to close its tunnels on SIGTERM before SIGKILL.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const SIDECAR_NAME: &str = "ports-server";

/// Environment variables the tunnel feature needs. A tray app launched from
/// Finder or a login item inherits none of the user's shell exports, so these
/// come from a config file the tray can point the user at.
const EDGE_KEYS: [&str; 2] = ["EDGE_WS_URL", "EDGE_TOKEN"];

const EDGE_ENV_TEMPLATE: &str = "\
# Port Scanner — tunnel edge credentials.
#
# The tray app is launched by the OS, not by your shell, so it cannot see
# `export EDGE_TOKEN=...` from your profile. Put the values here instead.
# Read on every server start: edit this file, then pick Restart Server.
#
# EDGE_WS_URL is the agent endpoint of your edge deployment.
# EDGE_TOKEN is the shared secret from /etc/portscanner-edge.env on the VPS.
#
# A real environment variable of the same name still wins, so a terminal
# launch with EDGE_TOKEN exported keeps behaving the way it always has.

EDGE_WS_URL=
EDGE_TOKEN=
";

pub struct EdgeConfig {
    /// Values to hand the server process.
    pub vars: BTreeMap<String, String>,
    /// Keys that are still empty, in `EDGE_KEYS` order.
    pub missing: Vec<&'static str>,
}

impl EdgeConfig {
    /// The disabled tunnel line in the tray menu.
    pub fn status_line(&self) -> String {
        if self.missing.is_empty() {
            "Tunnels ready".into()
        } else {
            format!("Tunnels off · {} not set", self.missing.join(", "))
        }
    }
}

pub fn edge_env_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("edge.env"))
}

/// Creates `edge.env` with the commented template if it does not exist yet,
/// so "Edit Edge Config" always has something to open.
pub fn ensure_edge_env_file(app: &AppHandle) -> std::io::Result<PathBuf> {
    let path = edge_env_path(app).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no application config directory",
        )
    })?;
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, EDGE_ENV_TEMPLATE)?;
    }
    Ok(path)
}

/// Reads `edge.env` and merges it with the real environment. A non-empty
/// environment variable always wins, so running the tray from a terminal that
/// already exports these behaves exactly as it did before the file existed.
pub fn edge_config(app: &AppHandle) -> EdgeConfig {
    let from_file = edge_env_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| parse_env_file(&s))
        .unwrap_or_default();

    let mut vars = BTreeMap::new();
    let mut missing = Vec::new();

    for key in EDGE_KEYS {
        let value = std::env::var(key)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| from_file.get(key).cloned())
            .filter(|v| !v.trim().is_empty());

        match value {
            Some(value) => {
                vars.insert(key.to_string(), value);
            }
            None => missing.push(key),
        }
    }

    EdgeConfig { vars, missing }
}

/// `KEY=value` per line. Blank lines and `#` comments are skipped, a leading
/// `export ` is tolerated, and a single layer of matching quotes is stripped.
fn parse_env_file(contents: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        out.insert(key.to_string(), value.to_string());
    }
    out
}

/// The project's compiled entry point, resolved relative to the crate so
/// `cargo tauri dev` can run the server without packaging a sidecar first.
fn dev_node_entry() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("CARGO_MANIFEST_DIR has no parent")
        .join("dist")
        .join("index.js")
}

fn sidecar_command(app: &AppHandle) -> Result<Command, String> {
    app.shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|err| format!("no {SIDECAR_NAME} sidecar ({err})"))
}

fn node_command(app: &AppHandle) -> Result<Command, String> {
    let entry = dev_node_entry();
    if !entry.exists() {
        return Err(format!("no {}", entry.display()));
    }
    Ok(app
        .shell()
        .command("node")
        .args([entry.to_string_lossy().as_ref()]))
}

/// Debug builds run the checked-out `dist/` through `node`, so editing the
/// server is `npm run build` plus Restart Server rather than re-packaging the
/// sidecar. Release builds have no `dist/` to fall back to and run the bundled
/// sidecar. Either way the other one is the fallback.
fn server_command(app: &AppHandle) -> Result<Command, String> {
    let (preferred, fallback) = if cfg!(debug_assertions) {
        (node_command(app), sidecar_command(app))
    } else {
        (sidecar_command(app), node_command(app))
    };

    preferred.or_else(|first| fallback.map_err(|second| format!("{first}, {second}")))
}

fn parse_ready_line(line: &str) -> Option<String> {
    // Format: "READY http://host:port token=..."
    let mut parts = line.trim().split_whitespace();
    if parts.next()? != "READY" {
        return None;
    }
    parts.next().map(str::to_string)
}

fn set_state(app: &AppHandle, next: ServerState) {
    let state = app.state::<AppState>();
    if let Ok(mut server) = state.server.lock() {
        if *server == next {
            return;
        }
        *server = next;
    }
    tray::refresh(app);
}

/// Starts a new server process and supervises it until it exits or is
/// superseded. Any previously running process must already have been stopped.
pub fn spawn(app: &AppHandle) {
    let state = app.state::<AppState>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let token = state.token.clone();
    let edge = edge_config(app);
    drop(state);

    set_state(app, ServerState::Starting);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let command = match server_command(&app) {
            Ok(command) => command,
            Err(reason) => {
                set_state(&app, ServerState::Failed { reason });
                return;
            }
        };

        let result = command
            .envs(edge.vars)
            .args(["web", "--port", "0", "--token", &token, "--emit-ready"])
            .spawn();

        let (mut rx, child) = match result {
            Ok(pair) => pair,
            Err(err) => {
                set_state(
                    &app,
                    ServerState::Failed {
                        reason: format!("could not start server ({err})"),
                    },
                );
                return;
            }
        };

        if app.state::<AppState>().generation.load(Ordering::SeqCst) != generation {
            // Superseded while spawning — drop this process on the floor.
            let _ = child.kill();
            return;
        }
        app.state::<AppState>().set_child(Some(child));

        // Last line of stderr, so a crash can name its own cause.
        let mut last_error: Option<String> = None;

        while let Some(event) = rx.recv().await {
            if app.state::<AppState>().generation.load(Ordering::SeqCst) != generation {
                return;
            }

            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(url) = parse_ready_line(&line) {
                        app.state::<AppState>().restarts.store(0, Ordering::SeqCst);
                        set_state(&app, ServerState::Ready { url });
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    eprintln!("ports-server: {line}");
                    if !line.is_empty() {
                        last_error = Some(line);
                    }
                }
                CommandEvent::Error(err) => {
                    eprintln!("ports-server: {err}");
                    last_error = Some(err);
                }
                CommandEvent::Terminated(payload) => {
                    let reason = match (payload.code, payload.signal) {
                        (_, Some(signal)) => format!("Server killed by signal {signal}"),
                        (Some(code), _) if code != 0 => format!("Server exited ({code})"),
                        _ => "Server exited".to_string(),
                    };
                    handle_unexpected_exit(&app, generation, detail(reason, last_error));
                    return;
                }
                _ => {}
            }
        }

        // The event channel closed without a Terminated frame. The process is
        // gone either way, and leaving the menu on "Running" would be a lie.
        if app.state::<AppState>().generation.load(Ordering::SeqCst) == generation {
            handle_unexpected_exit(
                &app,
                generation,
                detail("Lost contact with server".to_string(), last_error),
            );
        }
    });
}

/// Appends the server's last words to an exit reason, if it had any.
fn detail(reason: String, last_error: Option<String>) -> String {
    match last_error {
        Some(line) => format!("{reason}: {}", truncate(&line, 60)),
        None => reason,
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{head}…")
}

/// Queues a respawn with backoff, or gives up once the ladder is exhausted.
fn handle_unexpected_exit(app: &AppHandle, generation: u64, reason: String) {
    let attempt = {
        let state = app.state::<AppState>();
        state.set_child(None);
        state.restarts.fetch_add(1, Ordering::SeqCst) as usize
    };

    let Some(delay) = RESTART_DELAYS_SECS.get(attempt).copied() else {
        set_state(
            app,
            ServerState::Failed {
                reason: format!("{reason}, gave up after {attempt} restarts"),
            },
        );
        return;
    };

    let app = app.clone();
    std::thread::spawn(move || {
        // Count down out loud rather than showing a number that goes stale.
        for remaining in (1..=delay).rev() {
            if app.state::<AppState>().generation.load(Ordering::SeqCst) != generation {
                return;
            }
            set_state(
                &app,
                ServerState::Restarting {
                    in_seconds: remaining,
                    reason: reason.clone(),
                },
            );
            std::thread::sleep(Duration::from_secs(1));
        }

        if app.state::<AppState>().generation.load(Ordering::SeqCst) == generation {
            spawn(&app);
        }
    });
}

/// Stops the running server, SIGTERM first so it can close its tunnels, then
/// SIGKILL. Blocks for up to [`SHUTDOWN_GRACE`]; never call it on the main
/// thread. Bumping the generation first silences the supervisor, so this does
/// not trip the auto-restart ladder.
pub fn stop_blocking(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.restarts.store(0, Ordering::SeqCst);

    let Some(child) = state.take_child() else {
        return;
    };

    #[cfg(unix)]
    {
        use std::time::Instant;

        let pid = child.pid() as libc::pid_t;
        // SAFETY: kill(2) with a pid we own; an already-reaped pid just errors.
        if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            while Instant::now() < deadline {
                // Signal 0 probes for existence without delivering anything.
                if unsafe { libc::kill(pid, 0) } != 0 {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    let _ = child.kill();
}

/// Menu action: stop, then start again, picking up any `edge.env` edits.
pub fn restart(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        stop_blocking(&app);
        spawn(&app);
    });
}

/// Menu action: stop the server, then exit once it is actually gone.
pub fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        stop_blocking(&app);
        app.exit(0);
    });
}
