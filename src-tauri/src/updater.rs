//! Self-update from GitHub Releases.
//!
//! Same rule as the rest of the menu: one item, and its label is the state.
//! It reads "Check for Updates…" until asked, says what it found, and once a
//! release has been downloaded and verified the app restarts into it. Nothing
//! is installed without a click; the background schedule only *checks*.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::sidecar;
use crate::state::AppState;
use crate::tray;

/// A dev build is `target/debug/port-scanner-desktop`, not an installed
/// bundle, and there is nothing sensible for the updater to replace.
pub const SUPPORTED: bool = !cfg!(debug_assertions);

/// Let the sidecar settle before the first background check.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateState {
    Idle,
    Checking,
    UpToDate,
    Available { version: String },
    Downloading { version: String, percent: Option<u8> },
    Failed { reason: String },
}

impl UpdateState {
    /// Menu label and whether clicking it does anything.
    pub fn menu_item(&self, current_version: &str) -> (String, bool) {
        match self {
            UpdateState::Idle => ("Check for Updates…".into(), true),
            UpdateState::Checking => ("Checking for Updates…".into(), false),
            UpdateState::UpToDate => (format!("Up to Date · v{current_version}"), true),
            UpdateState::Available { version } => {
                (format!("Install v{version} and Restart"), true)
            }
            UpdateState::Downloading {
                version,
                percent: Some(percent),
            } => (format!("Downloading v{version}… {percent}%"), false),
            UpdateState::Downloading {
                version,
                percent: None,
            } => (format!("Downloading v{version}…"), false),
            UpdateState::Failed { reason } => (format!("Update failed · {reason}"), true),
        }
    }
}

fn set_state(app: &AppHandle, next: UpdateState) {
    if let Ok(mut slot) = app.state::<AppState>().update.lock() {
        *slot = next;
    }
    tray::refresh(app);
}

/// Asks GitHub whether a newer release exists. `quiet` marks the background
/// schedule: a failed check there (offline, rate-limited) goes back to Idle
/// instead of parking an error in the menu that nobody asked for.
pub fn check(app: &AppHandle, quiet: bool) {
    if !SUPPORTED {
        return;
    }
    {
        let state = app.state::<AppState>();
        let Ok(current) = state.update.lock() else {
            return;
        };
        match *current {
            UpdateState::Checking | UpdateState::Downloading { .. } => return,
            // Already know about one; don't flicker the label re-confirming it.
            UpdateState::Available { .. } if quiet => return,
            _ => {}
        }
    }
    set_state(app, UpdateState::Checking);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Windows hands over to the installer and exits from inside
        // `download_and_install`; this hook is the only chance to stop the
        // sidecar first. macOS and Linux return normally and stop it below.
        let before_exit = app.clone();
        let result: Result<Option<Update>, tauri_plugin_updater::Error> = async {
            let updater = app
                .updater_builder()
                .on_before_exit(move || sidecar::stop_blocking(&before_exit))
                .build()?;
            updater.check().await
        }
        .await;

        match result {
            Ok(Some(update)) => {
                let version = update.version.clone();
                if let Ok(mut slot) = app.state::<AppState>().pending_update.lock() {
                    *slot = Some(update);
                }
                set_state(&app, UpdateState::Available { version });
            }
            Ok(None) => set_state(&app, UpdateState::UpToDate),
            Err(err) => {
                eprintln!("Update check failed: {err}");
                let next = if quiet {
                    UpdateState::Idle
                } else {
                    UpdateState::Failed {
                        reason: sidecar::truncate(&err.to_string(), 60),
                    }
                };
                set_state(&app, next);
            }
        }
    });
}

/// Downloads the staged release, verifies its signature, swaps the bundle,
/// and restarts. The menu shows download progress while it runs.
pub fn install(app: &AppHandle) {
    let staged = app
        .state::<AppState>()
        .pending_update
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    let Some(update) = staged else {
        // The click raced a state change; find out what is true now.
        check(app, false);
        return;
    };

    let version = update.version.clone();
    set_state(
        app,
        UpdateState::Downloading {
            version: version.clone(),
            percent: None,
        },
    );

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let downloaded = Arc::new(AtomicU64::new(0));
        let shown = Arc::new(AtomicU64::new(u64::MAX));
        let progress_app = app.clone();
        let progress_version = version.clone();

        let result = update
            .download_and_install(
                move |chunk, total| {
                    let done = downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                    let Some(total) = total.filter(|t| *t > 0) else {
                        return;
                    };
                    let percent = (done * 100 / total).min(100);
                    // Each repaint round-trips to the main thread; only do it
                    // when the number actually changes.
                    if shown.swap(percent, Ordering::Relaxed) != percent {
                        set_state(
                            &progress_app,
                            UpdateState::Downloading {
                                version: progress_version.clone(),
                                percent: Some(percent as u8),
                            },
                        );
                    }
                },
                || {},
            )
            .await;

        match result {
            Ok(()) => {
                sidecar::stop_blocking(&app);
                app.restart();
            }
            Err(err) => {
                eprintln!("Update install failed: {err}");
                set_state(
                    &app,
                    UpdateState::Failed {
                        reason: sidecar::truncate(&err.to_string(), 60),
                    },
                );
            }
        }
    });
}

/// One check after the sidecar has settled, then every few hours.
pub fn schedule(app: &AppHandle) {
    if !SUPPORTED {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK_AFTER);
        loop {
            check(&app, true);
            thread::sleep(CHECK_EVERY);
        }
    });
}

/// The single menu item: check when idle, install when something is staged.
pub fn on_menu_click(app: &AppHandle) {
    let current = app
        .state::<AppState>()
        .update
        .lock()
        .map(|s| s.clone())
        .unwrap_or(UpdateState::Idle);
    match current {
        UpdateState::Available { .. } => install(app),
        UpdateState::Checking | UpdateState::Downloading { .. } => {}
        _ => check(app, false),
    }
}
