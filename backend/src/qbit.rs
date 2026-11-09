use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
mod activity;
use walkdir::WalkDir;
use crate::{allocation_files_after_moves, authenticated_user, finalize_storage_reservation, hidden_async_command, launch_local_helper, magnet_display_name, magnet_info_hash, organize_completed_episode, read_libraries, read_storage_ledger, read_users, reconcile_storage_ledger, release_season_from_name, release_storage_reservation, replace_private_file, reserve_storage, safe_relative_path, supervise, unix_now, write_storage_ledger, AppState, LibraryConfig, MagnetControlRequest, MagnetDownloadRequest, MagnetPrepareRequest, MagnetStatusQuery, StoredUser, ZeroProgressObservation};

// A tracked download that cannot reach qBittorrent, or which has not received
// a single byte, is not a normal slow transfer.  Surface and recover it
// promptly; leaving the card at "Connecting" for minutes makes an outage look
// like ordinary peer discovery.
pub const QBIT_ZERO_PROGRESS_RECOVERY_AFTER: Duration = Duration::from_secs(10);
pub const QBIT_RECOVERY_COOLDOWN: Duration = Duration::from_secs(300);
pub const QBIT_WATCHER_INTERVAL: Duration = Duration::from_secs(2);
pub const QBIT_STATUS_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
pub const QBIT_RELAUNCH_WAIT: Duration = Duration::from_secs(12);
pub const QBIT_RELAUNCH_CONNECT_TIMEOUT: Duration = Duration::from_millis(1_500);
#[cfg(windows)]
pub const QBITTORRENT_RESTART_TASK: &str = "TMS qBittorrent";


#[derive(Clone, Deserialize)]
pub struct QbittorrentTorrent {
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub progress: f64,
    #[serde(default)]
    pub dlspeed: u64,
    #[serde(default)]
    pub dl_limit: i64,
    #[serde(default)]
    pub upspeed: u64,
    #[serde(default)]
    pub eta: u64,
    #[serde(default)]
    pub completed: u64,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub amount_left: u64,
    #[serde(default)]
    pub num_seeds: u64,
    #[serde(default)]
    pub num_leechs: u64,
    #[serde(default)]
    pub added_on: u64,
    #[serde(default)]
    pub save_path: String,
    #[serde(default)]
    pub content_path: String,
    #[serde(default)]
    pub category: String,
}


 impl MagnetStatusQuery {
    pub(crate) fn should_check_route(&self) -> bool {
        self.check_route.as_deref().is_some_and(|value| {
            value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
        })
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct MagnetJob {
    pub hash: String,
    pub user_id: u64,
    pub user_name: String,
    pub destination_path: String,
    pub reservation_id: String,
    pub reserved_bytes: u64,
    #[serde(default)]
    pub request_budget_bytes: Option<u64>,
    #[serde(default)]
    pub speed_cap_enabled: Option<bool>,
    #[serde(default)]
    pub quota_override: bool,
    pub status: String,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl MagnetJob {
    pub(crate) fn uses_speed_cap(&self, users: &[StoredUser]) -> bool {
        self.speed_cap_enabled.unwrap_or_else(|| {
            !users.iter().any(|user| user.id == self.user_id && user.is_admin)
        })
    }
}

#[derive(Default, Deserialize, Serialize)]
pub struct MagnetJobs {
    #[serde(default)]
    pub jobs: Vec<MagnetJob>,
}

#[derive(Serialize)]
struct MagnetSafetyCheck {
    id: &'static str,
    label: &'static str,
    ready: bool,
    detail: String,
}


#[derive(Serialize)]
struct MagnetDownloadItem {
    hash: String,
    name: String,
    state: String,
    progress: f64,
    download_speed: u64,
    upload_speed: u64,
    eta: u64,
    completed: u64,
    total: u64,
    amount_left: u64,
    added_on: u64,
    complete: bool,
    stopped: bool,
    speed_cap_enabled: Option<bool>,
}

#[derive(Serialize)]
pub struct MagnetDownloadStatus {
    pub  configured: bool,
    pub  connected: bool,
    pub  vpn_connected: bool,
    pub binding_verified: bool,
    pub  ready: bool,
    pub required_interface: Option<String>,
    pub   bound_interface: Option<String>,
    pub   message: String,
    pub   checks: Vec<MagnetSafetyCheck>,
    pub   downloads: Vec<MagnetDownloadItem>,
    /// False when qBittorrent was skipped because no TMS download is active,
    /// so `connected: false` does not mean qBittorrent is down.
    pub qbittorrent_checked: bool,
}

#[derive(Serialize)]
pub struct MagnetDownloadResponse {
    pub queued: bool,
    pub message: String,
    pub hash: Option<String>,
}


#[derive(Clone)]
pub struct QbittorrentSession {
    pub base_url: String,
    pub cookie: Option<String>,
    pub bound_interface: String,
}

pub async fn qbittorrent_preferences(
    state: &AppState,
    base_url: &str,
    cookie: Option<&str>,
) -> Result<Value, String> {
    let mut request = state
        .qbittorrent_http
        .get(format!("{base_url}/api/v2/app/preferences"))
        .header(reqwest::header::REFERER, base_url);
    if let Some(cookie) = cookie {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Could not reach the qBittorrent Web UI.".to_owned())?;
    if !response.status().is_success() {
        return Err("qBittorrent Web UI authentication is required.".to_owned());
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| "qBittorrent returned invalid preferences.".to_owned())
}

pub async fn connect_qbittorrent(state: &AppState) -> Result<QbittorrentSession, String> {
    let Some(base_url) = state.qbittorrent_url.as_ref() else {
        return Err("Set TMS_QBITTORRENT_URL to the qBittorrent Web UI address.".to_owned());
    };
    let _session_guard = state.qbittorrent_session_lock.lock().await;
    // Bind the cookie first: a guard in the `if let` scrutinee would stay
    // alive for the whole block and deadlock the stale-cookie reset below.
    let cached_cookie = state.qbittorrent_cookie.lock().await.clone();
    if let Some(cookie) = cached_cookie {
        if let Ok(preferences) = qbittorrent_preferences(state, base_url, Some(&cookie)).await {
            repair_stale_vpn_interface(state, base_url, Some(&cookie), &preferences).await;
            return Ok(QbittorrentSession {
                base_url: base_url.clone(),
                cookie: Some(cookie),
                bound_interface: qbittorrent_bound_interface(&preferences),
            });
        }
        *state.qbittorrent_cookie.lock().await = None;
    }
    let cookie = if state.qbittorrent_username.is_some() || state.qbittorrent_password.is_some() {
        let username = state.qbittorrent_username.as_deref().unwrap_or("");
        let password = state.qbittorrent_password.as_deref().unwrap_or("");
        let response = state
            .qbittorrent_http
            .post(format!("{base_url}/api/v2/auth/login"))
            .header(reqwest::header::REFERER, base_url)
            .form(&[("username", username), ("password", password)])
            .send()
            .await
            .map_err(|_| "Could not reach the qBittorrent Web UI.".to_owned())?;
        let login_status = response.status();
        if !login_status.is_success() {
            return Err("qBittorrent rejected the Web UI login.".to_owned());
        }
        let cookie = response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::to_owned);
        let body = response.text().await.unwrap_or_default();
        if login_status != StatusCode::NO_CONTENT && body.trim() != "Ok." {
            return Err("qBittorrent rejected the Web UI login.".to_owned());
        }
        *state.qbittorrent_cookie.lock().await = cookie.clone();
        cookie
    } else {
        None
    };
    let preferences = qbittorrent_preferences(state, base_url, cookie.as_deref()).await?;
    repair_stale_vpn_interface(state, base_url, cookie.as_deref(), &preferences).await;
    Ok(QbittorrentSession {
        base_url: base_url.clone(),
        cookie,
        bound_interface: qbittorrent_bound_interface(&preferences),
    })
}

/// Returns the current ID of the required VPN adapter when qBittorrent still
/// names that adapter but is bound to an ID it no longer has.
pub fn stale_vpn_interface_replacement(
    preferences: &Value,
    interfaces: &[Value],
    required: &str,
) -> Option<String> {
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).unwrap_or("").trim().to_owned();
    if !text(preferences, "current_interface_name").eq_ignore_ascii_case(required) {
        return None;
    }
    let bound_id = text(preferences, "current_network_interface");
    let current_id = interfaces
        .iter()
        .find(|interface| text(interface, "name").eq_ignore_ascii_case(required))
        .map(|interface| text(interface, "value"))
        .filter(|id| !id.is_empty())?;
    (!current_id.eq_ignore_ascii_case(&bound_id)).then_some(current_id)
}

/// Proton recreates its WireGuard adapter on reconnect with a new interface
/// ID. qBittorrent keeps the saved adapter name but binds to the vanished ID,
/// so it has no network while the name-based binding check still passes and
/// every download freezes at zero. Restarting qBittorrent cannot fix that, so
/// rebind it to the adapter's current ID.
async fn repair_stale_vpn_interface(
    state: &AppState,
    base_url: &str,
    cookie: Option<&str>,
    preferences: &Value,
) {
    let Some(required) = state.vpn_interface.as_deref() else {
        return;
    };
    let mut request = state
        .qbittorrent_http
        .get(format!("{base_url}/api/v2/app/networkInterfaceList"))
        .header(reqwest::header::REFERER, base_url);
    if let Some(cookie) = cookie {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let Ok(response) = request.send().await else {
        return;
    };
    let Ok(interfaces) = response.json::<Vec<Value>>().await else {
        return;
    };
    let Some(current_id) = stale_vpn_interface_replacement(preferences, &interfaces, required) else {
        return;
    };
    let payload = serde_json::json!({ "current_network_interface": current_id }).to_string();
    let mut update = state
        .qbittorrent_http
        .post(format!("{base_url}/api/v2/app/setPreferences"))
        .header(reqwest::header::REFERER, base_url)
        .form(&[("json", payload)]);
    if let Some(cookie) = cookie {
        update = update.header(reqwest::header::COOKIE, cookie);
    }
    let stale_id = preferences.get("current_network_interface").and_then(Value::as_str).unwrap_or("");
    if update.send().await.is_ok_and(|response| response.status().is_success()) {
        tracing::warn!(interface = required, stale_id, %current_id, "Rebound qBittorrent to the recreated VPN adapter");
    } else {
        tracing::error!(interface = required, stale_id, %current_id, "Could not rebind qBittorrent to the recreated VPN adapter");
    }
}

pub fn qbittorrent_bound_interface(preferences: &Value) -> String {
    ["current_interface_name", "current_network_interface"]
        .into_iter()
        .filter_map(|key| preferences.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|interface| !interface.is_empty())
        .unwrap_or("")
        .to_owned()
}

pub fn vpn_binding_error(state: &AppState, bound_interface: &str) -> Option<String> {
    let Some(required) = state.vpn_interface.as_deref() else {
        return Some("Set TMS_VPN_INTERFACE to the VPN interface qBittorrent must use.".to_owned());
    };
    if bound_interface.is_empty() {
        return Some("qBittorrent is currently bound to all network interfaces.".to_owned());
    }
    if !bound_interface.eq_ignore_ascii_case(required) {
        return Some(format!(
            "qBittorrent is bound to {bound_interface}, not the required VPN interface {required}."
        ));
    }
    None
}

#[cfg(windows)]
pub async fn vpn_interface_is_up(interface_name: &str) -> bool {
    use windows_sys::Win32::{
        Foundation::ERROR_BUFFER_OVERFLOW,
        NetworkManagement::{
            IpHelper::{
                GAA_FLAG_INCLUDE_ALL_INTERFACES, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
                GAA_FLAG_SKIP_MULTICAST, GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::AF_UNSPEC,
    };

    unsafe fn wide_string(value: *const u16) -> String {
        if value.is_null() {
            return String::new();
        }
        let mut length = 0;
        while unsafe { *value.add(length) } != 0 {
            length += 1;
        }
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, length) })
    }

    let flags = GAA_FLAG_INCLUDE_ALL_INTERFACES
        | GAA_FLAG_SKIP_ANYCAST
        | GAA_FLAG_SKIP_MULTICAST
        | GAA_FLAG_SKIP_DNS_SERVER;
    let mut byte_count = 0_u32;
    let sizing_result = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut byte_count,
        )
    };
    if sizing_result != ERROR_BUFFER_OVERFLOW || byte_count == 0 {
        return false;
    }

    // A usize buffer keeps the linked adapter structures correctly aligned.
    let word_count = (byte_count as usize).div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0_usize; word_count];
    let adapters = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    let result = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            std::ptr::null(),
            adapters,
            &mut byte_count,
        )
    };
    if result != 0 {
        return false;
    }

    let mut current = adapters;
    while !current.is_null() {
        let adapter = unsafe { &*current };
        if unsafe { wide_string(adapter.FriendlyName) }.eq_ignore_ascii_case(interface_name) {
            return adapter.OperStatus == IfOperStatusUp;
        }
        current = adapter.Next;
    }
    false
}

pub async fn connect_qbittorrent_for_status(state: &AppState) -> Result<QbittorrentSession, String> {
    tokio::time::timeout(QBIT_STATUS_CONNECT_TIMEOUT, connect_qbittorrent(state))
        .await
        .unwrap_or_else(|_| Err("The qBittorrent Web UI check timed out.".to_owned()))
}

#[cfg(not(windows))]
async fn vpn_interface_is_up(_interface_name: &str) -> bool {
    false
}

pub async fn qbittorrent_torrents(
    state: &AppState,
    session: &QbittorrentSession,
) -> Result<Vec<QbittorrentTorrent>, String> {
    let mut request = state
        .qbittorrent_http
        .get(format!("{}/api/v2/torrents/info", session.base_url))
        .header(reqwest::header::REFERER, &session.base_url)
        .query(&[("category", "TMS")]);
    if let Some(cookie) = session.cookie.as_ref() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "qBittorrent stopped responding.".to_owned())?;
    if !response.status().is_success() {
        return Err("qBittorrent could not return download progress.".to_owned());
    }
    response
        .json::<Vec<QbittorrentTorrent>>()
        .await
        .map_err(|_| "qBittorrent returned invalid download progress.".to_owned())
}

pub async fn qbittorrent_all_torrents(
    state: &AppState,
    session: &QbittorrentSession,
) -> Result<Vec<QbittorrentTorrent>, String> {
    let mut request = state
        .qbittorrent_http
        .get(format!("{}/api/v2/torrents/info", session.base_url))
        .header(reqwest::header::REFERER, &session.base_url);
    if let Some(cookie) = session.cookie.as_ref() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "qBittorrent stopped responding.".to_owned())?;
    if !response.status().is_success() {
        return Err("qBittorrent could not verify the submitted download.".to_owned());
    }
    response
        .json::<Vec<QbittorrentTorrent>>()
        .await
        .map_err(|_| "qBittorrent returned invalid download progress.".to_owned())
}

pub async fn ensure_qbittorrent_category(
    state: &AppState,
    session: &QbittorrentSession,
) -> Result<(), String> {
    let mut list_request = state
        .qbittorrent_http
        .get(format!("{}/api/v2/torrents/categories", session.base_url))
        .header(reqwest::header::REFERER, &session.base_url);
    if let Some(cookie) = session.cookie.as_ref() {
        list_request = list_request.header(reqwest::header::COOKIE, cookie);
    }
    let categories = list_request
        .send()
        .await
        .map_err(|_| "qBittorrent stopped responding while checking TMS downloads.".to_owned())?;
    if !categories.status().is_success() {
        return Err("qBittorrent could not check its download categories.".to_owned());
    }
    if categories
        .json::<Value>()
        .await
        .ok()
        .and_then(|value| value.get("TMS").cloned())
        .is_some()
    {
        return Ok(());
    }

    let mut create_request = state
        .qbittorrent_http
        .post(format!(
            "{}/api/v2/torrents/createCategory",
            session.base_url
        ))
        .header(reqwest::header::REFERER, &session.base_url)
        .form(&[("category", "TMS"), ("savePath", "")]);
    if let Some(cookie) = session.cookie.as_ref() {
        create_request = create_request.header(reqwest::header::COOKIE, cookie);
    }
    let response = create_request
        .send()
        .await
        .map_err(|_| "qBittorrent stopped responding while preparing TMS downloads.".to_owned())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err("qBittorrent could not prepare the TMS download category.".to_owned())
    }
}

pub fn qbittorrent_torrent_is_complete(torrent: &QbittorrentTorrent) -> bool {
    torrent.progress >= 0.999_999
        || (torrent.size > 0 && torrent.amount_left == 0 && torrent.completed >= torrent.size)
}

pub fn qbittorrent_torrent_is_stopped(torrent: &QbittorrentTorrent) -> bool {
    matches!(
        torrent.state.to_ascii_lowercase().as_str(),
        "stoppedup" | "pausedup" | "stoppeddl" | "pauseddl"
    )
}


pub async fn stop_qbittorrent_torrent(
    state: &AppState,
    session: &QbittorrentSession,
    hash: &str,
) -> bool {
    for endpoint in ["stop", "pause"] {
        let mut request = state
            .qbittorrent_http
            .post(format!("{}/api/v2/torrents/{endpoint}", session.base_url))
            .header(reqwest::header::REFERER, &session.base_url)
            .form(&[("hashes", hash)]);
        if let Some(cookie) = session.cookie.as_ref() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        if request
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            tracing::info!(torrent_hash = hash, "Completed TMS torrent stopped");
            return true;
        }
    }
    tracing::warn!(torrent_hash = hash, "Could not stop completed TMS torrent");
    false
}

pub async fn resume_qbittorrent_torrent(
    state: &AppState,
    session: &QbittorrentSession,
    hash: &str,
) -> bool {
    for endpoint in ["start", "resume"] {
        let mut request = state
            .qbittorrent_http
            .post(format!("{}/api/v2/torrents/{endpoint}", session.base_url))
            .header(reqwest::header::REFERER, &session.base_url)
            .form(&[("hashes", hash)]);
        if let Some(cookie) = session.cookie.as_ref() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        if request
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return true;
        }
    }
    false
}

async fn reannounce_qbittorrent_torrent(
    state: &AppState,
    session: &QbittorrentSession,
    hash: &str,
) -> bool {
    let mut request = state
        .qbittorrent_http
        .post(format!("{}/api/v2/torrents/reannounce", session.base_url))
        .header(reqwest::header::REFERER, &session.base_url)
        .form(&[("hashes", hash)]);
    if let Some(cookie) = session.cookie.as_ref() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    request
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

pub fn is_qbit_zero_progress_failure(torrent: &QbittorrentTorrent) -> bool {
    matches!(
        torrent.state.to_ascii_lowercase().as_str(),
        // A magnet can be broken before qBittorrent knows its size. These
        // metadata states are the common zero-percent freeze and must be
        // recoverable just like a transfer that never receives its first byte.
        "metadl" | "forcedmetadl" | "downloading" | "forceddl"
    ) && torrent.progress <= f64::EPSILON
        && torrent.completed == 0
        && torrent.dlspeed == 0
}

pub fn is_recoverable_qbittorrent_connection_failure(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("could not reach")
        || message.contains("stopped responding")
        || message.contains("timed out")
}

pub async fn kill_and_relaunch_qbittorrent(
    state: &AppState,
    session: Option<&QbittorrentSession>,
) -> bool {
    if let Some(session) = session {
        let mut shutdown = state
            .qbittorrent_http
            .post(format!("{}/api/v2/app/shutdown", session.base_url))
            .header(reqwest::header::REFERER, &session.base_url);
        if let Some(cookie) = session.cookie.as_ref() {
            shutdown = shutdown.header(reqwest::header::COOKIE, cookie);
        }
        let _ = shutdown.send().await;
    }

    #[cfg(windows)]
    {
        let _ = hidden_async_command("taskkill")
            .args(["/IM", "qbittorrent.exe", "/F"])
            .creation_flags(0x0800_0000)
            .status()
            .await;
    }

    tokio::time::sleep(Duration::from_millis(750)).await;
    *state.qbittorrent_cookie.lock().await = None;
    if let Err(error) = launch_qbittorrent(state).await {
        // The persistent user-session watchdog may already be running and
        // will notice the missing process itself. A SYSTEM task-launch denial
        // must not make recovery fail before that independent path can act.
        tracing::warn!(%error, "Could not wake the qBittorrent watchdog; waiting for its health loop");
    }

    let started = Instant::now();
    while started.elapsed() < QBIT_RELAUNCH_WAIT {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if matches!(
            tokio::time::timeout(QBIT_RELAUNCH_CONNECT_TIMEOUT, connect_qbittorrent(state)).await,
            Ok(Ok(_))
        ) {
            return true;
        }
    }
    false
}

async fn clear_failed_qbittorrent_recovery(state: &AppState, started: Instant) {
    let mut last_recovery = state.qbit_last_recovery.lock().await;
    if last_recovery.is_some_and(|saved| saved == started) {
        *last_recovery = None;
    }
}

pub async fn restart_qbittorrent_after_zero_progress(
    state: &AppState,
    session: Option<&QbittorrentSession>,
    hashes: &[String],
) -> bool {
    let _restart_guard = state.qbit_restart_lock.lock().await;
    let recovery_started = Instant::now();
    {
        let mut last_recovery = state.qbit_last_recovery.lock().await;
        if last_recovery.is_some_and(|last| last.elapsed() < QBIT_RECOVERY_COOLDOWN) {
            return false;
        }
        *last_recovery = Some(recovery_started);
    }

    tracing::warn!(
        torrent_hashes = ?hashes,
        stalled_for_seconds = QBIT_ZERO_PROGRESS_RECOVERY_AFTER.as_secs(),
        "Restarting qBittorrent after tracked TMS downloads stopped making progress"
    );

    if !kill_and_relaunch_qbittorrent(state, session).await {
        tracing::error!(torrent_hashes = ?hashes, "qBittorrent did not return after zero-progress recovery");
        return false;
    }

    if let Ok(reconnected) = connect_qbittorrent(state).await {
        for hash in hashes {
            let resumed = resume_qbittorrent_torrent(state, &reconnected, hash).await;
            let reannounced = reannounce_qbittorrent_torrent(state, &reconnected, hash).await;
            if !resumed || !reannounced {
                tracing::warn!(
                    torrent_hash = %hash,
                    resumed,
                    reannounced,
                    "qBittorrent returned but the stalled torrent recovery commands were incomplete"
                );
            }
        }
        tracing::info!(torrent_hashes = ?hashes, "qBittorrent zero-progress recovery completed");
        return true;
    }
    tracing::error!(torrent_hashes = ?hashes, "qBittorrent did not return after zero-progress recovery");
    false
}

async fn restart_unavailable_qbittorrent(state: &AppState) -> bool {
    let _restart_guard = state.qbit_restart_lock.lock().await;
    // Another recovery may have completed while this request waited for the
    // restart lock. Do not bounce a qBittorrent instance that is responsive now.
    if matches!(
        tokio::time::timeout(QBIT_RELAUNCH_CONNECT_TIMEOUT, connect_qbittorrent(state)).await,
        Ok(Ok(_))
    ) {
        return true;
    }

    let recovery_started = Instant::now();
    {
        let mut last_recovery = state.qbit_last_recovery.lock().await;
        // Readiness preparation is an explicit repair request. It must not be
        // skipped because the background zero-progress watcher restarted qBit
        // recently and set its loop-prevention cooldown.
        *last_recovery = Some(recovery_started);
    }

    tracing::warn!("Restarting qBittorrent after the download readiness check could not reach it");
    let restarted = kill_and_relaunch_qbittorrent(state, None).await;
    if !restarted {
        clear_failed_qbittorrent_recovery(state, recovery_started).await;
    }
    restarted
}

async fn recover_qbit_zero_progress_if_needed(
    state: &AppState,
    session: &QbittorrentSession,
    torrents: &[QbittorrentTorrent],
    tracked: &BTreeSet<String>,
) -> bool {
    let failing_hashes = torrents
        .iter()
        .filter(|torrent| tracked.contains(&torrent.hash) && is_qbit_zero_progress_failure(torrent))
        .map(|torrent| torrent.hash.clone())
        .collect::<BTreeSet<_>>();
    let mut observations = state.qbit_zero_progress.lock().await;
    observations.retain(|hash, _| failing_hashes.contains(hash));
    let now = Instant::now();
    for hash in &failing_hashes {
        if let std::collections::hash_map::Entry::Vacant(entry) = observations.entry(hash.clone()) {
            let torrent_state = torrents
                .iter()
                .find(|torrent| torrent.hash.eq_ignore_ascii_case(hash))
                .map(|torrent| torrent.state.as_str())
                .unwrap_or("unknown");
            tracing::warn!(
                torrent_hash = %hash,
                state = torrent_state,
                recovery_after_seconds = QBIT_ZERO_PROGRESS_RECOVERY_AFTER.as_secs(),
                "Tracked qBittorrent download is at zero progress; recovery timer started"
            );
            entry.insert(ZeroProgressObservation { first_seen: now });
        }
    }
    let ready = failing_hashes
        .iter()
        .filter(|hash| {
            observations.get(*hash).is_some_and(|observation| {
                observation.first_seen.elapsed() >= QBIT_ZERO_PROGRESS_RECOVERY_AFTER
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    drop(observations);
    if ready.is_empty() {
        return false;
    }
    let recovered = restart_qbittorrent_after_zero_progress(state, Some(session), &ready).await;
    if recovered {
        state.qbit_zero_progress.lock().await.clear();
    }
    recovered
}

async fn recover_unavailable_qbittorrent_if_needed(
    state: &AppState,
    tracked: &BTreeSet<String>,
    error: &str,
) -> bool {
    if !is_recoverable_qbittorrent_connection_failure(error) {
        return false;
    }
    let mut observations = state.qbit_zero_progress.lock().await;
    observations.retain(|hash, _| tracked.contains(hash));
    let now = Instant::now();
    for hash in tracked {
        if let std::collections::hash_map::Entry::Vacant(entry) = observations.entry(hash.clone()) {
            tracing::warn!(
                torrent_hash = %hash,
                error,
                recovery_after_seconds = QBIT_ZERO_PROGRESS_RECOVERY_AFTER.as_secs(),
                "qBittorrent is unavailable for a tracked download; recovery timer started"
            );
            entry.insert(ZeroProgressObservation { first_seen: now });
        }
    }
    let ready = tracked
        .iter()
        .filter(|hash| {
            observations.get(*hash).is_some_and(|observation| {
                observation.first_seen.elapsed() >= QBIT_ZERO_PROGRESS_RECOVERY_AFTER
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    drop(observations);
    if ready.is_empty() {
        return false;
    }
    let recovered = restart_qbittorrent_after_zero_progress(state, None, &ready).await;
    if recovered {
        state.qbit_zero_progress.lock().await.clear();
    }
    recovered
}

async fn prune_stale_active_downloads(
    state: &AppState,
    torrents: &[QbittorrentTorrent],
    tracked: &BTreeSet<String>,
) {
    let present = torrents
        .iter()
        .map(|torrent| torrent.hash.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let missing = tracked
        .iter()
        .filter(|hash| !present.contains(&hash.to_ascii_lowercase()))
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return;
    }
    let jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
    let now = unix_now();
    let mut active = state.active_downloads.lock().await;
    for hash in missing {
        let stale = jobs
            .jobs
            .iter()
            .find(|job| job.hash.eq_ignore_ascii_case(&hash))
            .map(|job| job.status != "cancel_pending" && now.saturating_sub(job.updated_at) > 60)
            .unwrap_or(true);
        if stale {
            active.remove(&hash);
        }
    }
}

async fn remove_qbittorrent_torrent_with_files(
    state: &AppState,
    session: &QbittorrentSession,
    hash: &str,
) -> bool {
    let mut request = state
        .qbittorrent_http
        .post(format!("{}/api/v2/torrents/delete", session.base_url))
        .header(reqwest::header::REFERER, &session.base_url)
        .form(&[("hashes", hash), ("deleteFiles", "true")]);
    if let Some(cookie) = session.cookie.as_ref() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    request
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

pub async fn remove_completed_qbittorrent_torrent(
    state: &AppState,
    session: &QbittorrentSession,
    hash: &str,
) -> bool {
    let mut request = state
        .qbittorrent_http
        .post(format!("{}/api/v2/torrents/delete", session.base_url))
        .header(reqwest::header::REFERER, &session.base_url)
        .form(&[("hashes", hash), ("deleteFiles", "false")]);
    if let Some(cookie) = session.cookie.as_ref() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    if request
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
    {
        tracing::info!(
            torrent_hash = hash,
            "Completed TMS torrent removed from qBittorrent"
        );
        return true;
    }
    tracing::warn!(
        torrent_hash = hash,
        "Could not remove completed TMS torrent from qBittorrent"
    );
    false
}

fn magnet_download_item(torrent: QbittorrentTorrent, speed_cap_enabled: Option<bool>) -> MagnetDownloadItem {
    let complete = qbittorrent_torrent_is_complete(&torrent);
    let stopped = qbittorrent_torrent_is_stopped(&torrent);
    MagnetDownloadItem {
        hash: torrent.hash,
        name: torrent.name,
        state: torrent.state,
        progress: torrent.progress.clamp(0.0, 1.0),
        download_speed: torrent.dlspeed,
        upload_speed: torrent.upspeed,
        eta: torrent.eta,
        completed: torrent.completed,
        total: torrent.size,
        amount_left: torrent.amount_left,
        added_on: torrent.added_on,
        complete,
        stopped,
        speed_cap_enabled,
    }
}

fn torrent_library_name(state: &AppState, torrent: &QbittorrentTorrent) -> Option<String> {
    Path::new(&torrent.save_path)
        .strip_prefix(&state.library_root)
        .ok()?
        .components()
        .next()?
        .as_os_str()
        .to_str()
        .map(str::to_owned)
}

pub fn can_view_torrent_library(
    user: &StoredUser,
    libraries: &BTreeMap<String, LibraryConfig>,
    library_name: &str,
) -> bool {
    user.is_admin
        || libraries.get(library_name).is_some_and(|library| {
        library
            .members
            .iter()
            .any(|member| member.can_view && member.name.eq_ignore_ascii_case(&user.name))
    })
}

pub async fn build_magnet_status(
    state: &AppState,
    user: &StoredUser,
    check_route: bool,
    include_downloads: bool,
) -> MagnetDownloadStatus {
    let configured = state.qbittorrent_url.is_some() && state.vpn_interface.is_some();
    let has_active_downloads = !state.active_downloads.lock().await.is_empty();
    let should_check_qbittorrent = check_route || has_active_downloads;
    // Adapter discovery and qBittorrent are independent checks. Running them
    // together avoids turning two healthy local services into a cumulative
    // timeout, while the explicit qBittorrent deadline also includes time
    // spent waiting for the shared login/session lock.
    let vpn_check = async {
        match state.vpn_interface.as_deref() {
            Some(interface) => vpn_interface_is_up(interface).await,
            None => false,
        }
    };
    let qbit_check = async {
        if !should_check_qbittorrent {
            return None;
        }
        Some(
            tokio::time::timeout(
                Duration::from_secs(8),
                connect_qbittorrent_for_status(state),
            )
                .await
                .unwrap_or_else(|_| Err("The qBittorrent Web UI check timed out.".to_owned())),
        )
    };
    let (vpn_connected, qbit_result) = tokio::join!(vpn_check, qbit_check);
    let mut connected = false;
    let mut binding_verified = false;
    let mut bound_interface = None;
    let mut qbit_message = if should_check_qbittorrent {
        "Could not reach the qBittorrent Web UI.".to_owned()
    } else {
        "qBittorrent is checked only while a TMS download is active.".to_owned()
    };
    let mut downloads = Vec::new();

    if let Some(qbit_result) = qbit_result {
        match qbit_result {
            Ok(session) => {
                connected = true;
                bound_interface =
                    (!session.bound_interface.is_empty()).then(|| session.bound_interface.clone());
                binding_verified = vpn_binding_error(state, &session.bound_interface).is_none();
                qbit_message = if binding_verified {
                    "qBittorrent is locked to the required VPN interface.".to_owned()
                } else {
                    vpn_binding_error(state, &session.bound_interface).unwrap_or_else(|| {
                        "qBittorrent VPN binding could not be verified.".to_owned()
                    })
                };
                if include_downloads {
                    let torrents = tokio::time::timeout(
                        Duration::from_secs(3),
                        qbittorrent_torrents(state, &session),
                    )
                        .await;
                    if let Ok(Ok(mut torrents)) = torrents {
                        torrents.sort_by(|left, right| right.added_on.cmp(&left.added_on));
                        let libraries = read_libraries(state).await;
                        let jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
                        let users = read_users(&state.users_path).await;
                        downloads = torrents
                            .into_iter()
                            .filter(|torrent| {
                                torrent_library_name(state, torrent).is_some_and(|library_name| {
                                    can_view_torrent_library(user, &libraries, &library_name)
                                })
                            })
                            .map(|torrent| {
                                let cap = jobs.jobs.iter().find(|job| job.hash.eq_ignore_ascii_case(&torrent.hash))
                                    .map(|job| job.uses_speed_cap(&users));
                                magnet_download_item(torrent, cap)
                            })
                            .collect();
                    }
                }
            }
            Err(message) => qbit_message = message,
        }
    }

    let ready = configured && vpn_connected && connected && binding_verified;
    let message = if !configured {
        "qBittorrent and VPN settings are incomplete in password.md.".to_owned()
    } else if !vpn_connected {
        "Proton VPN is not connected. TMS has opened Proton and is waiting for the VPN interface."
            .to_owned()
    } else if !connected {
        qbit_message.clone()
    } else if !binding_verified {
        qbit_message.clone()
    } else {
        "Secure route ready. Only qBittorrent can use this download path.".to_owned()
    };
    let checks = vec![
        MagnetSafetyCheck {
            id: "configuration",
            label: "Local credentials",
            ready: configured,
            detail: if configured {
                "password.md loaded".to_owned()
            } else {
                "Complete password.md and restart TMS".to_owned()
            },
        },
        MagnetSafetyCheck {
            id: "vpn",
            label: "Proton VPN",
            ready: vpn_connected,
            detail: state
                .vpn_interface
                .as_ref()
                .map(|interface| {
                    if vpn_connected {
                        format!("{interface} is online")
                    } else {
                        format!("Waiting for {interface}")
                    }
                })
                .unwrap_or_else(|| "VPN interface is not configured".to_owned()),
        },
        MagnetSafetyCheck {
            id: "qbittorrent",
            label: "qBittorrent",
            ready: connected && binding_verified,
            detail: if connected && binding_verified {
                format!(
                    "Web API connected and bound to {}",
                    bound_interface.as_deref().unwrap_or("the VPN interface")
                )
            } else {
                qbit_message.clone()
            },
        },
    ];

    MagnetDownloadStatus {
        configured,
        connected,
        vpn_connected,
        binding_verified,
        ready,
        required_interface: state.vpn_interface.clone(),
        bound_interface,
        message,
        checks,
        downloads,
        qbittorrent_checked: should_check_qbittorrent,
    }
}

pub async fn magnet_download_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MagnetStatusQuery>,
) -> Result<Json<MagnetDownloadStatus>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    tokio::time::timeout(
        Duration::from_secs(9),
        build_magnet_status(&state, &user, query.should_check_route(), true),
    )
        .await
        .map(Json)
        .map_err(|_| StatusCode::GATEWAY_TIMEOUT)
}


pub async fn launch_qbittorrent(state: &AppState) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::{
            RemoteDesktop::ProcessIdToSessionId, Threading::GetCurrentProcessId,
        };

        let mut session_id = 0_u32;
        let in_boot_session = unsafe {
            ProcessIdToSessionId(GetCurrentProcessId(), &mut session_id) != 0 && session_id == 0
        };
        if in_boot_session {
            let result = hidden_async_command("schtasks.exe")
                .args(["/Run", "/TN", QBITTORRENT_RESTART_TASK])
                .creation_flags(0x0800_0000)
                .output()
                .await
                .map_err(|_| "Could not invoke the TMS qBittorrent restart task.".to_owned())?;
            if result.status.success() {
                tracing::info!(
                    task = QBITTORRENT_RESTART_TASK,
                    session_id,
                    "Requested the user-session qBittorrent watchdog"
                );
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&result.stderr).trim().to_owned();
            let stdout = String::from_utf8_lossy(&result.stdout).trim().to_owned();
            return Err(format!(
                "The TMS qBittorrent watchdog could not be started (status: {}; output: {}).",
                result.status,
                if stderr.is_empty() { stdout } else { stderr }
            ));
        }
    }
    launch_local_helper(&state.qbittorrent_exe, &[]).await
}

pub async fn validate_magnet_destination(
    state: &AppState,
    user: &StoredUser,
    raw_destination_path: &str,
) -> Result<(String, PathBuf), (StatusCode, String)> {
    let destination_path = raw_destination_path.trim().replace('\\', "/");
    if !safe_relative_path(&destination_path) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose a valid library destination.".to_owned(),
        ));
    }
    let Some(library_path) = destination_path
        .split('/')
        .next()
        .filter(|part| !part.is_empty())
    else {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose a valid library destination.".to_owned(),
        ));
    };
    let libraries = read_libraries(state).await;
    let Some(library) = libraries.get(library_path) else {
        return Err((
            StatusCode::NOT_FOUND,
            "The selected library no longer exists.".to_owned(),
        ));
    };
    if library.folder_structure_static {
        return Err((
            StatusCode::FORBIDDEN,
            "Static libraries accept direct file uploads only.".to_owned(),
        ));
    }
    let allowed = user.is_admin
        || library
        .members
        .iter()
        .any(|member| member.can_download && member.name.eq_ignore_ascii_case(&user.name));
    if !allowed {
        return Err((
            StatusCode::FORBIDDEN,
            "You do not have permission to download into this library.".to_owned(),
        ));
    }
    let destination = state.library_root.join(&destination_path);
    if !destination.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            "The selected destination folder no longer exists.".to_owned(),
        ));
    }
    Ok((destination_path, destination))
}

pub async fn prepare_secure_magnet_route(
    state: &AppState,
    user: &StoredUser,
) -> Result<MagnetDownloadStatus, (StatusCode, String)> {
    tokio::time::timeout(Duration::from_secs(24), async {
        // First return immediately when the route is already healthy. The old
        // flow connected once, slept, then connected and listed torrents a
        // second time, so lock contention or a slow progress query could make
        // a verified route look unsafe.
        let initial = build_magnet_status(state, user, true, false).await;
        if initial.ready {
            return initial;
        }
        if !initial.vpn_connected {
            let _ = launch_local_helper(&state.proton_launcher_path, &[]).await;
        }
        if initial.configured
            && initial.vpn_connected
            && !initial.connected
            && is_recoverable_qbittorrent_connection_failure(&initial.message)
        {
            let _ = restart_unavailable_qbittorrent(state).await;
        }
        tokio::time::sleep(Duration::from_millis(650)).await;
        build_magnet_status(state, user, true, false).await
    })
        .await
        .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "The secure-route check timed out. Verify Proton VPN and the qBittorrent Web UI, then retry.".to_owned()))
}

pub async fn prepare_magnet_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<MagnetPrepareRequest>,
) -> Result<Json<MagnetDownloadStatus>, (StatusCode, Json<Value>)> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "message": "Sign in to prepare a download." })),
        ));
    };
    validate_magnet_destination(&state, &user, &request.destination_path)
        .await
        .map_err(|(status, message)| (status, Json(serde_json::json!({ "message": message }))))?;

    let status = prepare_secure_magnet_route(&state, &user)
        .await
        .map_err(|(status, message)| (status, Json(serde_json::json!({ "message": message }))))?;
    Ok(Json(status))
}

pub async fn control_magnet_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<MagnetControlRequest>,
) -> (StatusCode, Json<Value>) {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "message": "Sign in to control downloads." })),
        );
    };
    let hash = request.hash.trim().to_ascii_lowercase();
    if hash.len() != 40 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "message": "Invalid torrent identifier." })),
        );
    }
    let _operation = state.magnet_operation_lock.lock().await;
    if matches!(request.action.as_str(), "cap" | "uncap") {
        if !user.is_admin {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "message": "Only a full administrator can change download speed caps." })));
        }
        let enabled = request.action == "cap";
        {
            let _guard = state.persistence_lock.lock().await;
            let mut jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
            let Some(job) = jobs.jobs.iter_mut().find(|job| job.hash.eq_ignore_ascii_case(&hash)) else {
                return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "message": "This TMS download no longer exists." })));
            };
            if !matches!(job.status.as_str(), "metadata" | "downloading") {
                return (StatusCode::CONFLICT, Json(serde_json::json!({ "message": "This download is no longer active." })));
            }
            job.speed_cap_enabled = Some(enabled);
            job.updated_at = unix_now();
            if write_magnet_jobs(&state.magnet_jobs_path, &jobs).await.is_err() {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "message": "Could not save the download speed setting. Please retry." })));
            }
        }
        tracing::info!(event = "magnet_download_control", user = %user.name, action = %request.action, torrent_hash = %hash, "Download speed preference saved");
        state.active_downloads.lock().await.insert(hash.clone());
        let applied = tokio::time::timeout(Duration::from_secs(8), async {
            let session = connect_qbittorrent(&state).await?;
            let torrents = qbittorrent_torrents(&state, &session).await?;
            if !torrents.iter().any(|torrent| torrent.hash.eq_ignore_ascii_case(&hash)) {
                return Err("The torrent is not available yet.".to_owned());
            }
            let tracked = state.active_downloads.lock().await.clone();
            activity::apply_limits(&state, &session, &torrents, &tracked).await
        }).await.is_ok_and(|result| result.is_ok());
        return (
            if applied { StatusCode::OK } else { StatusCode::ACCEPTED },
            Json(serde_json::json!({ "message": if !applied {
                "Speed setting saved. It will apply when qBittorrent is reachable."
            } else if enabled {
                "Speed cap enabled while the PC is unlocked; full speed while locked."
            } else {
                "Download speed uncapped."
            } })),
        );
    }
    // Persist cancellation before contacting the client so an outage cannot lose it.
    if request.action == "cancel" {
        let job = {
            let _guard = state.persistence_lock.lock().await;
            let mut jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
            let Some(job) = jobs.jobs.iter_mut().find(|job| job.hash.eq_ignore_ascii_case(&hash)) else {
                return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "message": "This TMS download no longer exists." })));
            };
            if !user.is_admin && job.user_id != user.id {
                return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "message": "You can control only your own server downloads." })));
            }
            if job.status == "completed" {
                return (StatusCode::CONFLICT, Json(serde_json::json!({ "message": "This download is complete. Remove its files from the library instead." })));
            }
            if job.status == "cancelled" {
                return (StatusCode::OK, Json(serde_json::json!({ "message": "Download already cancelled." })));
            }
            job.status = "cancel_pending".to_owned();
            job.error = None;
            job.updated_at = unix_now();
            let job = job.clone();
            if write_magnet_jobs(&state.magnet_jobs_path, &jobs).await.is_err() {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "message": "Could not save cancellation. Please retry." })));
            }
            job
        };
        state.active_downloads.lock().await.insert(hash.clone());
        let result = match tokio::time::timeout(Duration::from_secs(8), connect_qbittorrent(&state)).await {
            Ok(Ok(session)) => finish_pending_magnet_cancel(&state, &session, &job).await,
            _ => Ok(false),
        };
        return match result {
            Ok(true) => (StatusCode::OK, Json(serde_json::json!({ "message": "Download cancelled and cleaned up." }))),
            _ => (StatusCode::ACCEPTED, Json(serde_json::json!({ "message": "Cancellation saved. Cleanup will retry when qBittorrent is reachable." }))),
        };
    }
    let session = match connect_qbittorrent(&state).await {
        Ok(session) => session,
        Err(message) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({ "message": message })),
            );
        }
    };
    let torrents = match qbittorrent_torrents(&state, &session).await {
        Ok(torrents) => torrents,
        Err(message) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "message": message })),
            );
        }
    };
    let Some(torrent) = torrents
        .iter()
        .find(|torrent| torrent.hash.eq_ignore_ascii_case(&hash))
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "message": "This TMS download no longer exists." })),
        );
    };
    let magnet_job = read_magnet_jobs(&state.magnet_jobs_path)
        .await
        .jobs
        .into_iter()
        .find(|job| job.hash.eq_ignore_ascii_case(&hash));
    if magnet_job
        .as_ref()
        .is_some_and(|job| !user.is_admin && job.user_id != user.id)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(
                serde_json::json!({ "message": "You can control only your own server downloads." }),
            ),
        );
    }
    if request.action == "resume"
        && magnet_job
        .as_ref()
        .is_some_and(|job| matches!(job.status.as_str(), "metadata" | "cancel_pending"))
    {
        return (
            StatusCode::CONFLICT,
            Json(
                serde_json::json!({ "message": "This download is waiting for metadata or cancellation cleanup." }),
            ),
        );
    }
    let libraries = read_libraries(&state).await;
    let allowed = torrent_library_name(&state, torrent)
        .is_some_and(|library_name| can_view_torrent_library(&user, &libraries, &library_name));
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "You do not have access to this download." })),
        );
    }

    let endpoints: &[&str] = match request.action.as_str() {
        "pause" => &["stop", "pause"],
        "resume" => &["start", "resume"],
        "cancel" => &["delete"],
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "message": "Unknown download action." })),
            );
        }
    };
    for endpoint in endpoints {
        let mut action_request = state
            .qbittorrent_http
            .post(format!("{}/api/v2/torrents/{endpoint}", session.base_url))
            .header(reqwest::header::REFERER, &session.base_url);
        if request.action == "cancel" {
            action_request =
                action_request.form(&[("hashes", hash.as_str()), ("deleteFiles", "true")]);
        } else {
            action_request = action_request.form(&[("hashes", hash.as_str())]);
        }
        if let Some(cookie) = session.cookie.as_ref() {
            action_request = action_request.header(reqwest::header::COOKIE, cookie);
        }
        if action_request
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            let message = match request.action.as_str() {
                "pause" => "Download paused.",
                "resume" => "Download resumed.",
                _ => "Download cancelled and partial files removed.",
            };
            tracing::info!(event = "magnet_download_control", user = %user.name, action = %request.action, torrent_hash = %hash, torrent_name = %torrent.name, "Magnet download controlled");
            return (
                StatusCode::OK,
                Json(serde_json::json!({ "message": message })),
            );
        }
    }
    (
        StatusCode::BAD_GATEWAY,
        Json(
            serde_json::json!({ "message": "qBittorrent could not complete that download action." }),
        ),
    )
}

// A successful DELETE only acknowledges a request. Verify absence before cleaning
// up the saved job and releasing its storage reservation.
async fn finish_pending_magnet_cancel(
    state: &AppState,
    session: &QbittorrentSession,
    job: &MagnetJob,
) -> Result<bool, String> {
    let torrents = qbittorrent_all_torrents(state, session).await?;
    if torrents.iter().any(|torrent| torrent.hash.eq_ignore_ascii_case(&job.hash)) {
        if !remove_qbittorrent_torrent_with_files(state, session, &job.hash).await {
            return Err("qBittorrent could not cancel the torrent.".to_owned());
        }
        if qbittorrent_all_torrents(state, session).await?.iter()
            .any(|torrent| torrent.hash.eq_ignore_ascii_case(&job.hash)) {
            return Ok(false);
        }
    }
    let _guard = state.persistence_lock.lock().await;
    let mut jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
    if !jobs.jobs.iter().any(|saved| saved.hash == job.hash && saved.status == "cancel_pending") {
        return Ok(false);
    }
    let trash_id = cleanup_cancelled_magnet_folder(state, job, &jobs).await?;
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    release_storage_reservation(&mut ledger, &job.reservation_id);
    if let Some(id) = trash_id { crate::mark_storage_trashed(&mut ledger, &job.destination_path, &id); }
    write_storage_ledger(&state.storage_path, &ledger).await
        .map_err(|_| "Could not release cancelled download storage.".to_owned())?;
    let saved = jobs.jobs.iter_mut().find(|saved| saved.hash == job.hash).unwrap();
    saved.status = "cancelled".to_owned();
    saved.reserved_bytes = 0;
    saved.error = None;
    saved.updated_at = unix_now();
    write_magnet_jobs(&state.magnet_jobs_path, &jobs).await
        .map_err(|_| "Could not save completed cancellation.".to_owned())?;
    state.active_downloads.lock().await.remove(&job.hash);
    crate::invalidate_library_cache(state).await;
    crate::clear_delete_requests_for_path(state, &job.destination_path).await;
    tracing::info!(torrent_hash = %job.hash, "Cancelled magnet cleaned up and removed from running work");
    Ok(true)
}

async fn cleanup_cancelled_magnet_folder(state: &AppState, job: &MagnetJob, jobs: &MagnetJobs) -> Result<Option<String>, String> {
    if !safe_relative_path(&job.destination_path) {
        return Err("Invalid cancellation destination.".to_owned());
    }
    let target = state.library_root.join(&job.destination_path);
    let canonical = match tokio::fs::canonicalize(&target).await {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not inspect cancellation folder: {error}")),
    };
    let root = tokio::fs::canonicalize(&state.library_root).await.map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) || canonical == root || canonical != root.join(&job.destination_path) {
        return Err("Cancellation folder is outside the library.".to_owned());
    }
    // Remove empty dedicated folders. Preserve nonempty leftovers in recoverable
    // Trash, and never move a library root or a folder shared with another job.
    let mut entries = tokio::fs::read_dir(&canonical).await.map_err(|error| error.to_string())?;
    let nonempty = entries.next_entry().await.map_err(|error| error.to_string())?.is_some();
    let dedicated = cancellation_destination_is_dedicated(&job.destination_path, &job.hash, jobs);
    if !dedicated {
        return if nonempty { Err("Cancellation cleanup needs a dedicated download folder.".to_owned()) } else { Ok(None) };
    }
    if !nonempty {
        tokio::fs::remove_dir(&canonical).await.map_err(|error| error.to_string())?;
        return Ok(None);
    }
    crate::stop_transcodes_for_path(state, &job.destination_path).await;
    let entry = crate::move_to_trash(state, &canonical, &job.destination_path, "folder", job.user_id, None).await
        .ok_or_else(|| "Could not move cancelled download leftovers to Trash; cleanup will retry.".to_owned())?;
    Ok(Some(entry.id))
}

fn cancellation_destination_is_dedicated(path: &str, hash: &str, jobs: &MagnetJobs) -> bool {
    let path = path.replace('\\', "/").to_lowercase();
    safe_relative_path(&path) && path.split('/').count() >= 3 && !jobs.jobs.iter().any(|other| {
        if other.hash == hash || other.status == "cancelled" { return false; }
        let other_path = other.destination_path.replace('\\', "/").to_lowercase();
        other_path == path || other_path.starts_with(&format!("{path}/")) || (other_path.split('/').count() >= 2 && path.starts_with(&format!("{other_path}/")))
    })
}

pub fn magnet_response(
    status: StatusCode,
    queued: bool,
    message: impl Into<String>,
    hash: Option<String>,
) -> (StatusCode, Json<MagnetDownloadResponse>) {
    (
        status,
        Json(MagnetDownloadResponse {
            queued,
            message: message.into(),
            hash,
        }),
    )
}


fn transfer_discovery_budget(ledger: &mut crate::StorageLedger, user: &StoredUser, from: &str, to: &str, bytes: u64, quota_override: bool) -> bool {
    let original = ledger.clone();
    release_storage_reservation(ledger, from);
    if crate::reserve_storage_with_override(ledger, user, to, "magnet", bytes, quota_override) { true } else {
        *ledger = original;
        false
    }
}

fn magnet_record_failure_message(status: StatusCode) -> &'static str {
    if status == StatusCode::CONFLICT {
        "This download exceeds the requesting user's available storage quota. Free space or choose an admin quota option, then retry."
    } else {
        "TMS could not save the download's storage accounting. The download was stopped; please retry."
    }
}

pub async fn record_magnet_job(
    state: &AppState,
    user: &StoredUser,
    hash: &str,
    destination_path: &str,
    request_budget: Option<&(String, u64, u64)>,
    speed_cap_enabled: bool,
    quota_override: bool,
) -> Result<(), StatusCode> {
    let _guard = state.persistence_lock.lock().await;
    let mut jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
    if jobs
        .jobs
        .iter()
        .any(|job| job.hash.eq_ignore_ascii_case(hash))
    {
        return Ok(());
    }
    let reservation_id = format!("magnet:{hash}");
    let mut original_ledger = None;
    if let Some((discover_reservation, bytes, _)) = request_budget {
        let mut ledger = read_storage_ledger(&state.storage_path).await;
        original_ledger = Some(ledger.clone());
        if !transfer_discovery_budget(&mut ledger, user, discover_reservation, &reservation_id, *bytes, quota_override) {
            tracing::warn!(user_id = user.id, torrent_hash = hash, bytes, "Magnet storage reservation exceeds quota");
            return Err(StatusCode::CONFLICT);
        }
        write_storage_ledger(&state.storage_path, &ledger).await?;
    }
    let now = unix_now();
    jobs.jobs.push(MagnetJob {
        hash: hash.to_owned(),
        user_id: user.id,
        user_name: user.name.clone(),
        destination_path: destination_path.to_owned(),
        reservation_id,
        reserved_bytes: request_budget.map(|(_, bytes, _)| *bytes).unwrap_or(0),
        request_budget_bytes: request_budget.map(|(_, _, budget)| *budget),
        speed_cap_enabled: Some(speed_cap_enabled),
        quota_override,
        status: "metadata".to_owned(),
        error: None,
        created_at: now,
        updated_at: now,
    });
    if let Err(problem) = write_magnet_jobs(&state.magnet_jobs_path, &jobs).await {
        if let Some(ledger) = original_ledger { write_storage_ledger(&state.storage_path, &ledger).await?; }
        return Err(problem);
    }
    Ok(())
}

pub async fn queue_magnet_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<MagnetDownloadRequest>,
) -> (StatusCode, Json<MagnetDownloadResponse>) {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return magnet_response(
            StatusCode::UNAUTHORIZED,
            false,
            "Sign in to add a download.",
            None,
        );
    };
    queue_magnet_for_user(state, user, request, None, None, false, false).await
}

pub(crate) async fn queue_magnet_for_user(
    state: AppState,
    user: StoredUser,
    request: MagnetDownloadRequest,
    approved_destination: Option<(String, PathBuf)>,
    request_budget: Option<(String, u64, u64)>,
    queued_by_full_admin: bool,
    quota_override: bool,
) -> (StatusCode, Json<MagnetDownloadResponse>) {
    let speed_cap_enabled = !(user.is_admin || queued_by_full_admin);
    let magnet = request.magnet.trim();
    let Some(info_hash) = magnet_info_hash(magnet) else {
        return magnet_response(
            StatusCode::BAD_REQUEST,
            false,
            "Enter a valid BitTorrent magnet link with a v1 info hash.",
            None,
        );
    };
    let (selected_destination_path, selected_destination) =
        match if let Some(destination) = approved_destination {
            Ok(destination)
        } else {
            validate_magnet_destination(&state, &user, &request.destination_path).await
        } {
            Ok(destination) => destination,
            Err((status, message)) => {
                return magnet_response(status, false, message, None);
            }
        };
    // Use the human-readable torrent name immediately when it identifies a TV
    // season. This creates one stable show/season destination before any
    // payload bytes arrive, so later seasons of the same show share its folder.
    let (destination_path, destination) = magnet_display_name(magnet)
        .and_then(|name| release_season_from_name(&name))
        .map(|release| {
            let season = format!("Season {:02}", release.season);
            (
                format!("{}/{}/{}", selected_destination_path, release.title, season),
                selected_destination.join(release.title).join(season),
            )
        })
        .unwrap_or((selected_destination_path, selected_destination));
    if let Err(error) = tokio::fs::create_dir_all(&destination).await {
        return magnet_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            false,
            format!("Could not create the recognized download folder: {error}"),
            None,
        );
    }
    // Every submission, including a magnet chosen through Discover, uses the
    // same route recovery as Server Download. It starts Proton when needed
    // and relaunches qBittorrent after a recoverable Web UI failure.
    match prepare_secure_magnet_route(&state, &user).await {
        Ok(route) if route.ready => {}
        Ok(route) => {
            return magnet_response(StatusCode::SERVICE_UNAVAILABLE, false, route.message, None);
        }
        Err((status, message)) => return magnet_response(status, false, message, None),
    }
    let vpn_connected = match state.vpn_interface.as_deref() {
        Some(interface) => vpn_interface_is_up(interface).await,
        None => false,
    };
    if !vpn_connected {
        return magnet_response(
            StatusCode::SERVICE_UNAVAILABLE,
            false,
            "Proton VPN is not connected. The download was not submitted.",
            None,
        );
    }
    let session = match connect_qbittorrent(&state).await {
        Ok(session) => session,
        Err(message) => {
            return magnet_response(StatusCode::SERVICE_UNAVAILABLE, false, message, None);
        }
    };
    if let Some(message) = vpn_binding_error(&state, &session.bound_interface) {
        tracing::warn!(
            user = %user.name,
            bound_interface = %session.bound_interface,
            "Magnet download blocked by VPN safety check"
        );
        return magnet_response(StatusCode::SERVICE_UNAVAILABLE, false, message, None);
    }
    if let Ok(existing_torrents) = qbittorrent_all_torrents(&state, &session).await {
        if existing_torrents.iter().any(|torrent| {
            torrent.category == "TMS" && torrent.hash.eq_ignore_ascii_case(&info_hash)
        }) {
            state
                .active_downloads
                .lock()
                .await
                .insert(info_hash.clone());
            return magnet_response(
                StatusCode::ACCEPTED,
                true,
                "This magnet is already being tracked by qBittorrent.",
                Some(info_hash),
            );
        }
    }
    // Reject known quota failures before adding anything to qBittorrent. The
    // final handoff repeats this check under the persistence lock.
    if let Some((from, bytes, _)) = request_budget.as_ref() {
        let _guard = state.persistence_lock.lock().await;
        let mut ledger = read_storage_ledger(&state.storage_path).await;
        if !transfer_discovery_budget(&mut ledger, &user, from, &format!("magnet:{info_hash}"), *bytes, quota_override) {
            return magnet_response(StatusCode::CONFLICT, false,
                "This download exceeds the requesting user's available storage quota. Free space or choose an admin quota option, then retry.", None);
        }
    }
    if let Err(message) = ensure_qbittorrent_category(&state, &session).await {
        return magnet_response(StatusCode::BAD_GATEWAY, false, message, None);
    }
    let save_path = destination.to_string_lossy().replace('\\', "/");
    let form = reqwest::multipart::Form::new()
        .text("urls", magnet.to_owned())
        .text("savepath", save_path)
        .text("category", "TMS")
        .text("tags", format!("TMS,TMS-user-{}", user.id))
        .text("autoTMM", "false")
        .text("dlLimit", activity::initial_limit(speed_cap_enabled).to_string())
        .text("ratioLimit", "0")
        .text("seedingTimeLimit", "0")
        .text("paused", "false")
        .text("stopCondition", "MetadataReceived");
    let mut qbittorrent_request = state
        .qbittorrent_http
        .post(format!("{}/api/v2/torrents/add", session.base_url))
        .header(reqwest::header::REFERER, &session.base_url)
        .multipart(form);
    if let Some(cookie) = session.cookie.as_ref() {
        qbittorrent_request = qbittorrent_request.header(reqwest::header::COOKIE, cookie);
    }
    let response = match qbittorrent_request.send().await {
        Ok(response) => response,
        Err(_) => {
            return magnet_response(
                StatusCode::BAD_GATEWAY,
                false,
                "qBittorrent stopped responding before the download was added.",
                None,
            );
        }
    };
    let response_status = response.status();
    let response_body = response.text().await.unwrap_or_default();
    if !response_status.is_success()
        || (!response_body.trim().is_empty() && response_body.trim() != "Ok.")
    {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let torrent_exists =
            qbittorrent_all_torrents(&state, &session)
                .await
                .is_ok_and(|torrents| {
                    torrents.iter().any(|torrent| {
                        torrent.category == "TMS" && torrent.hash.eq_ignore_ascii_case(&info_hash)
                    })
                });
        if torrent_exists {
            if let Err(status) = record_magnet_job(&state, &user, &info_hash, &destination_path, request_budget.as_ref(), speed_cap_enabled, quota_override).await
            {
                let _ = remove_qbittorrent_torrent_with_files(&state, &session, &info_hash).await;
                return magnet_response(
                    status,
                    false,
                    magnet_record_failure_message(status),
                    None,
                );
            }
            state
                .active_downloads
                .lock()
                .await
                .insert(info_hash.clone());
            tracing::info!(
                user = %user.name,
                destination = %destination_path,
                torrent_hash = %info_hash,
                "qBittorrent reported rejection but the TMS torrent exists; treating submission as successful"
            );
            return magnet_response(
                StatusCode::ACCEPTED,
                true,
                "Download is active in qBittorrent.",
                Some(info_hash),
            );
        }
        tracing::warn!(
            status = %response_status,
            response = %response_body.trim(),
            torrent_hash = %info_hash,
            "qBittorrent rejected magnet submission"
        );
        return magnet_response(
            StatusCode::BAD_GATEWAY,
            false,
            "qBittorrent rejected the magnet link.",
            None,
        );
    }
    if let Err(status) = record_magnet_job(&state, &user, &info_hash, &destination_path, request_budget.as_ref(), speed_cap_enabled, quota_override).await
    {
        let _ = remove_qbittorrent_torrent_with_files(&state, &session, &info_hash).await;
        return magnet_response(
            status,
            false,
            magnet_record_failure_message(status),
            None,
        );
    }
    state
        .active_downloads
        .lock()
        .await
        .insert(info_hash.clone());
    tracing::info!(
        event = "magnet_download_queued",
        user = %user.name,
        destination = %destination_path,
        torrent_hash = %info_hash,
        vpn_interface = %session.bound_interface,
        "Magnet download queued"
    );
    magnet_response(
        StatusCode::ACCEPTED,
        true,
        "Download added to qBittorrent through the required VPN interface.",
        Some(info_hash),
    )
}

pub fn spawn_download_watcher(state: AppState) {
    supervise("magnet-download-watcher", move || {
        let state = state.clone();
        async move {
            let recoverable = read_magnet_jobs(&state.magnet_jobs_path).await;
            {
                let mut active = state.active_downloads.lock().await;
                for job in recoverable
                    .jobs
                    .into_iter()
                    .filter(|job| matches!(job.status.as_str(), "metadata" | "downloading" | "cancel_pending"))
                {
                    active.insert(job.hash);
                }
            }
            let mut interval = tokio::time::interval(QBIT_WATCHER_INTERVAL);
            loop {
                interval.tick().await;
                let tracked = state.active_downloads.lock().await.clone();
                if tracked.is_empty() {
                    continue;
                }
                let session = match connect_qbittorrent(&state).await {
                    Ok(session) => session,
                    Err(error) => {
                        recover_unavailable_qbittorrent_if_needed(&state, &tracked, &error).await;
                        continue;
                    }
                };
                let _operation = state.magnet_operation_lock.lock().await;
                let torrents = match qbittorrent_torrents(&state, &session).await {
                    Ok(torrents) => torrents,
                    Err(_) => continue,
                };
                prune_stale_active_downloads(&state, &torrents, &tracked).await;
                let _ = activity::apply_limits(&state, &session, &torrents, &tracked).await;
                let tracked = state.active_downloads.lock().await.clone();
                if tracked.is_empty() {
                    continue;
                }
                let pending = read_magnet_jobs(&state.magnet_jobs_path).await.jobs
                    .into_iter().filter(|job| job.status == "cancel_pending").collect::<Vec<_>>();
                for job in pending {
                    if let Err(error) = finish_pending_magnet_cancel(&state, &session, &job).await {
                        let _guard = state.persistence_lock.lock().await;
                        let mut jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
                        if let Some(saved) = jobs.jobs.iter_mut().find(|saved| saved.hash == job.hash && saved.status == "cancel_pending") {
                            let message = format!("Cancellation cleanup will retry: {error}");
                            if saved.error.as_deref() != Some(&message) {
                                tracing::warn!(torrent_hash = %job.hash, %error, "Magnet cancellation cleanup will retry");
                                saved.error = Some(message);
                                let _ = write_magnet_jobs(&state.magnet_jobs_path, &jobs).await;
                            }
                        }
                    }
                }
                let cancel_hashes = read_magnet_jobs(&state.magnet_jobs_path).await.jobs.into_iter()
                    .filter(|job| matches!(job.status.as_str(), "cancel_pending" | "cancelled"))
                    .map(|job| job.hash).collect::<BTreeSet<_>>();
                let recoverable_tracked = tracked.difference(&cancel_hashes).cloned().collect::<BTreeSet<_>>();
                if !recoverable_tracked.is_empty() && recover_qbit_zero_progress_if_needed(&state, &session, &torrents, &recoverable_tracked).await
                {
                    // The session/cookie was deliberately replaced during recovery;
                    // fetch fresh torrent state on the next watcher pass.
                    continue;
                }
                for torrent in torrents {
                    if !tracked.contains(&torrent.hash) {
                        continue;
                    }
                    let magnet_job = read_magnet_jobs(&state.magnet_jobs_path)
                        .await
                        .jobs
                        .into_iter()
                        .find(|job| job.hash.eq_ignore_ascii_case(&torrent.hash));
                    if magnet_job.as_ref().is_some_and(|job| matches!(job.status.as_str(), "cancel_pending" | "cancelled")) {
                        continue;
                    }
                    if let Some(job) = magnet_job.as_ref()
                        && job.status == "metadata"
                        && torrent.size > 0
                    {
                        let user = read_users(&state.users_path)
                            .await
                            .into_iter()
                            .find(|user| user.id == job.user_id);
                        let Some(user) = user else {
                            let _ = remove_qbittorrent_torrent_with_files(
                                &state,
                                &session,
                                &torrent.hash,
                            )
                                .await;
                            state.active_downloads.lock().await.remove(&torrent.hash);
                            continue;
                        };
                        let reserved = {
                            let _guard = state.persistence_lock.lock().await;
                            let mut ledger = read_storage_ledger(&state.storage_path).await;
                            reconcile_storage_ledger(&state, &mut ledger).await;
                            let mut jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
                            let fits_budget = job.request_budget_bytes.is_none_or(|budget| torrent.size <= budget);
                            let accepted = fits_budget && crate::reserve_storage_with_override(
                                &mut ledger,
                                &user,
                                &job.reservation_id,
                                "magnet",
                                torrent.size,
                                job.quota_override,
                            );
                            if let Some(saved) = jobs
                                .jobs
                                .iter_mut()
                                .find(|saved| saved.hash.eq_ignore_ascii_case(&torrent.hash))
                            {
                                saved.updated_at = unix_now();
                                if accepted {
                                    saved.status = "downloading".to_owned();
                                    saved.reserved_bytes = torrent.size;
                                    saved.error = None;
                                } else {
                                    saved.status = "failed".to_owned();
                                    release_storage_reservation(&mut ledger, &job.reservation_id);
                                    saved.error = Some(if fits_budget {
                                        "This torrent exceeds the submitting user's storage quota."
                                    } else {
                                        "This torrent exceeds the approved request budget."
                                    }.to_owned());
                                }
                            }
                            let persisted = write_storage_ledger(&state.storage_path, &ledger)
                                .await
                                .is_ok()
                                && write_magnet_jobs(&state.magnet_jobs_path, &jobs)
                                .await
                                .is_ok();
                            accepted && persisted
                        };
                        if !reserved {
                            let _ = remove_qbittorrent_torrent_with_files(
                                &state,
                                &session,
                                &torrent.hash,
                            )
                                .await;
                            state.active_downloads.lock().await.remove(&torrent.hash);
                            tracing::warn!(
                                torrent_hash = %torrent.hash,
                                user = %user.name,
                                torrent_size = torrent.size,
                                "Magnet rejected after metadata because storage quota was unavailable"
                            );
                            continue;
                        }
                        if !resume_qbittorrent_torrent(&state, &session, &torrent.hash).await {
                            tracing::warn!(
                                torrent_hash = %torrent.hash,
                                "Magnet storage was reserved but qBittorrent did not resume yet"
                            );
                        }
                        continue;
                    }
                    if !qbittorrent_torrent_is_complete(&torrent) {
                        continue;
                    }
                    let owned_job = magnet_job.filter(|job| job.status == "downloading");
                    let original_files = owned_job
                        .as_ref()
                        .map(|_| torrent_files(&state, &torrent))
                        .unwrap_or_default();
                    let stopped = qbittorrent_torrent_is_stopped(&torrent)
                        || stop_qbittorrent_torrent(&state, &session, &torrent.hash).await;
                    if !stopped {
                        continue;
                    }
                    if !remove_completed_qbittorrent_torrent(&state, &session, &torrent.hash).await
                    {
                        continue;
                    }
                    let canonical_destination = owned_job.as_ref().and_then(|job| {
                        safe_relative_path(&job.destination_path)
                            .then(|| state.library_root.join(&job.destination_path))
                    });
                    match organize_completed_episode(
                        &state,
                        &torrent,
                        canonical_destination.as_deref(),
                    )
                        .await
                    {
                        Ok(result) => {
                            if let Some(job) = owned_job.as_ref() {
                                let files = allocation_files_after_moves(
                                    &state,
                                    original_files,
                                    &result.moves,
                                );
                                finalize_magnet_download(&state, job, &files).await;
                            }
                            tracing::info!(torrent_hash = %torrent.hash, episodes = result.moved, "Completed download organized into the media library");
                        }
                        Err(error) => {
                            if error.retryable {
                                tracing::warn!(
                                    torrent_hash = %torrent.hash,
                                    error = %error.message,
                                    "Completed media is still locked after qBittorrent removal"
                                );
                            } else {
                                tracing::info!(
                                    torrent_hash = %torrent.hash,
                                    error = %error.message,
                                    "Completed download was not auto-organized"
                                );
                            }
                            if let Some(job) = owned_job.as_ref() {
                                let files =
                                    allocation_files_after_moves(&state, original_files, &[]);
                                finalize_magnet_download(&state, job, &files).await;
                            }
                        }
                    }
                    state.active_downloads.lock().await.remove(&torrent.hash);
                }
            }
        }
    });
}

pub async fn finalize_magnet_download(state: &AppState, job: &MagnetJob, files: &[(String, u64)]) {
    let _guard = state.persistence_lock.lock().await;
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    finalize_storage_reservation(
        &mut ledger,
        &job.reservation_id,
        job.user_id,
        "magnet",
        Some(&job.hash),
        files,
    );
    let mut jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
    if let Some(saved) = jobs
        .jobs
        .iter_mut()
        .find(|saved| saved.hash.eq_ignore_ascii_case(&job.hash))
    {
        saved.status = "completed".to_owned();
        saved.reserved_bytes = 0;
        saved.error = None;
        saved.updated_at = unix_now();
    }
    if write_storage_ledger(&state.storage_path, &ledger)
        .await
        .is_err()
        || write_magnet_jobs(&state.magnet_jobs_path, &jobs)
        .await
        .is_err()
    {
        tracing::error!(torrent_hash = %job.hash, "Could not finalize magnet storage ownership");
    }
}

pub fn torrent_content_path(torrent: &QbittorrentTorrent) -> PathBuf {
    if !torrent.content_path.trim().is_empty() {
        PathBuf::from(&torrent.content_path)
    } else {
        PathBuf::from(&torrent.save_path).join(&torrent.name)
    }
}

#[cfg(test)]
pub fn valid_magnet_link(value: &str) -> bool {
    magnet_info_hash(value).is_some()
}

pub async fn read_magnet_jobs(path: &Path) -> MagnetJobs {
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub async fn write_magnet_jobs(path: &Path, jobs: &MagnetJobs) -> Result<(), StatusCode> {
    let previous = read_magnet_jobs(path).await;
    let now = unix_now();
    for job in jobs.jobs.iter().filter(|job| crate::is_finished_download_status(&job.status)) {
        if previous.jobs.iter().any(|old| old.hash == job.hash && old.status == job.status) {
            continue;
        }
        tracing::info!(
            target: "tms_server::server_metrics",
            event = "download_finished",
            source = "torrent",
            id = %job.hash,
            outcome = %job.status,
            at = now,
            duration_s = now.saturating_sub(job.created_at),
            bytes = job.reserved_bytes,
            "Download finished"
        );
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    let bytes = serde_json::to_vec_pretty(jobs).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    replace_private_file(&temporary, path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub fn torrent_files(state: &AppState, torrent: &QbittorrentTorrent) -> Vec<(PathBuf, u64)> {
    let content = torrent_content_path(torrent);
    if !content.starts_with(&state.library_root) {
        return Vec::new();
    }
    if content.is_file() {
        return std::fs::metadata(&content)
            .ok()
            .map(|metadata| vec![(content, metadata.len())])
            .unwrap_or_default();
    }
    WalkDir::new(content)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .map(|metadata| (entry.into_path(), metadata.len()))
        })
        .collect()
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    #[test]
    fn selected_release_fits_remaining_quota_without_reserving_full_service_budget() {
        let gib = 1024 * 1024 * 1024;
        let user: StoredUser = serde_json::from_value(serde_json::json!({"id":2,"name":"Family","created_at":0,"password_hash":null,"storage_quota_bytes":100 * gib})).unwrap();
        let mut ledger = crate::StorageLedger::default();
        assert!(reserve_storage(&mut ledger, &user, "discover:other", "discover", 60 * gib));
        let before = ledger.clone();
        assert!(!transfer_discovery_budget(&mut ledger, &user, "discover:selected", "magnet:hash", 50 * gib, false));
        assert_eq!(crate::storage_usage(&ledger, user.id), crate::storage_usage(&before, user.id));
        assert!(transfer_discovery_budget(&mut ledger, &user, "discover:selected", "magnet:hash", 7 * gib / 2, false));
        assert_eq!(crate::storage_usage(&ledger, user.id), (0, 60 * gib + 7 * gib / 2));
        assert!(magnet_record_failure_message(StatusCode::CONFLICT).contains("quota"));
        assert!(magnet_record_failure_message(StatusCode::INTERNAL_SERVER_ERROR).contains("save"));
    }
    #[test]
    fn discover_handoff_transfers_the_budget_without_double_counting_or_losing_it() {
        let bytes = 50 * 1024 * 1024 * 1024;
        let user: StoredUser = serde_json::from_value(serde_json::json!({"id":1,"name":"Requester","created_at":0,"password_hash":null,"storage_quota_bytes":bytes})).unwrap();
        let mut ledger = crate::StorageLedger::default();
        assert!(reserve_storage(&mut ledger, &user, "discover:request", "discover", bytes));
        assert!(transfer_discovery_budget(&mut ledger, &user, "discover:request", "magnet:hash", bytes, false));
        assert_eq!(crate::storage_usage(&ledger, user.id), (0, bytes));
        assert_eq!(ledger.reservations.len(), 1);
        assert_eq!(ledger.reservations[0].id, "magnet:hash");
        assert!(!reserve_storage(&mut ledger, &user, "discover:second", "discover", bytes));
        assert!(!transfer_discovery_budget(&mut ledger, &user, "magnet:hash", "magnet:oversized", bytes + 1, false));
        assert_eq!(crate::storage_usage(&ledger, user.id), (0, bytes));
        assert_eq!(ledger.reservations[0].id, "magnet:hash");
    }
    fn job(hash: &str, path: &str) -> MagnetJob {
        MagnetJob { hash: hash.to_owned(), user_id: 1, user_name: "Test".to_owned(),
            destination_path: path.to_owned(), reservation_id: hash.to_owned(), reserved_bytes: 10, request_budget_bytes: None, speed_cap_enabled: None, quota_override: false,
            status: "downloading".to_owned(), error: None, created_at: 0, updated_at: 0 }
    }
    #[test]
    fn quota_override_survives_handoff_and_metadata_without_changing_owner() {
        let user: StoredUser = serde_json::from_value(serde_json::json!({"id":1,"name":"Requester","created_at":0,"password_hash":null,"storage_quota_bytes":1})).unwrap();
        let mut ledger = crate::StorageLedger::default();
        assert!(!crate::reserve_storage_with_override(&mut ledger, &user, "discover:request", "discover", 100, false));
        assert!(crate::reserve_storage_with_override(&mut ledger, &user, "discover:request", "discover", 100, true));
        assert!(transfer_discovery_budget(&mut ledger, &user, "discover:request", "magnet:hash", 100, true));
        assert_eq!(ledger.reservations.len(), 1);
        assert_eq!(ledger.reservations[0].user_id, user.id);
        let mut stored_job = job("hash", "Library/Title");
        stored_job.quota_override = true;
        let stored_job: MagnetJob = serde_json::from_value(serde_json::to_value(stored_job).unwrap()).unwrap();
        assert!(crate::reserve_storage_with_override(&mut ledger, &user, "magnet:hash", "magnet", 80, stored_job.quota_override));
        assert_eq!(crate::storage_usage(&ledger, user.id), (0, 80));
        crate::finalize_storage_reservation(&mut ledger, "magnet:hash", user.id, "magnet", None, &[("Library/Title/file.mkv".into(), 80)]);
        assert_eq!(crate::storage_usage(&ledger, user.id), (80, 0));
    }
    #[test]
    fn magnet_cancel_cleanup_protects_shared_folders_and_library_roots() {
        let own = job("own", "Library/Show/Season 01");
        let mut jobs = MagnetJobs { jobs: vec![own.clone()] };
        assert!(cancellation_destination_is_dedicated(&own.destination_path, "own", &jobs));
        assert!(!cancellation_destination_is_dedicated("Library", "own", &jobs));
        assert!(!cancellation_destination_is_dedicated("Library/../Outside", "own", &jobs));
        jobs.jobs.push(job("at-library-root", "Library"));
        assert!(cancellation_destination_is_dedicated(&own.destination_path, "own", &jobs));
        jobs.jobs.pop();
        jobs.jobs.push(job("other", "library/show/season 01/Episode"));
        assert!(!cancellation_destination_is_dedicated(&own.destination_path, "own", &jobs));
        jobs.jobs[1].status = "cancelled".to_owned();
        assert!(cancellation_destination_is_dedicated(&own.destination_path, "own", &jobs));
        jobs.jobs[1] = job("other", "Library/Show");
        assert!(!cancellation_destination_is_dedicated(&own.destination_path, "own", &jobs));
    }
}
