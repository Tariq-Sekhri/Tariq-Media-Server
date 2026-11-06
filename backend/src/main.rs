#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{
    any::Any,
    collections::hash_map::DefaultHasher,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    env,
    future::Future,
    hash::{Hash, Hasher},
    io::{Read, Seek, SeekFrom},
    net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, Response as HttpResponse, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Redirect, Response},
    routing::{delete, get, post, put},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    cors::CorsLayer,
    services::ServeDir,
    set_header::SetResponseHeaderLayer,
    trace::{OnResponse, TraceLayer},
};
use walkdir::WalkDir;
mod discovery;
mod qbit;
mod uploads;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::StrCmpLogicalW;
#[cfg(windows)]
use windows_sys::Win32::{
    System::{
        SystemInformation::GetTickCount,
        Threading::{HIGH_PRIORITY_CLASS, IDLE_PRIORITY_CLASS},
    },
    UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
};
use crate::qbit::{connect_qbittorrent, connect_qbittorrent_for_status, control_magnet_download, magnet_download_status, magnet_response, prepare_magnet_download, qbittorrent_torrent_is_complete, qbittorrent_torrent_is_stopped, qbittorrent_torrents, queue_magnet_download, read_magnet_jobs, spawn_download_watcher, torrent_content_path, vpn_binding_error, MagnetDownloadResponse, QbittorrentSession, QbittorrentTorrent, QBIT_RELAUNCH_CONNECT_TIMEOUT, QBIT_RELAUNCH_WAIT};

#[derive(Clone)]
struct AppState {
    library_root: PathBuf,
    libraries_path: PathBuf,
    users_path: PathBuf,
    sessions_path: PathBuf,
    legacy_folder_types_path: PathBuf,
    logs_dir: PathBuf,
    user_state_path: PathBuf,
    folder_covers_path: PathBuf,
    automatic_folder_covers_path: PathBuf,
    folder_covers_dir: PathBuf,
    profile_avatars_dir: PathBuf,
    trash_dir: PathBuf,
    trash_path: PathBuf,
    delete_requests_path: PathBuf,
    storage_path: PathBuf,
    upload_sessions_path: PathBuf,
    uploads_dir: PathBuf,
    upload_sessions_lock: Arc<tokio::sync::Mutex<()>>,
    upload_write_locks: uploads::UploadWriteLocks,
    download_jobs_path: PathBuf,
    magnet_jobs_path: PathBuf,
    folder_downloads_dir: PathBuf,
    ytdlp_dir: PathBuf,
    ytdlp_path: PathBuf,
    ytdlp_staging_dir: PathBuf,
    ytdlp_settings_path: PathBuf,
    transcodes_dir: PathBuf,
    skip_segments_path: PathBuf,
    shared_todo_path: PathBuf,
    skip_fingerprints_dir: PathBuf,
    trickplay_dir: PathBuf,
    browser_media_dir: PathBuf,
    grid_thumbs_dir: PathBuf,
    title_metadata_dir: PathBuf,
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    qbittorrent_url: Option<String>,
    qbittorrent_username: Option<String>,
    qbittorrent_password: Option<String>,
    vpn_interface: Option<String>,
    wyzie_api_key: Option<String>,
    subdl_api_key: Option<String>,
    qbittorrent_exe: PathBuf,
    proton_launcher_path: PathBuf,
    qbittorrent_cookie: Arc<tokio::sync::Mutex<Option<String>>>,
    qbittorrent_session_lock: Arc<tokio::sync::Mutex<()>>,
    active_downloads: Arc<tokio::sync::Mutex<BTreeSet<String>>>,
    qbit_zero_progress: Arc<tokio::sync::Mutex<HashMap<String, ZeroProgressObservation>>>,
    qbit_last_recovery: Arc<tokio::sync::Mutex<Option<Instant>>>,
    qbit_restart_lock: Arc<tokio::sync::Mutex<()>>,
    ytdlp_tool: Arc<tokio::sync::Mutex<YtDlpToolStatus>>,
    ytdlp_notify: Arc<tokio::sync::Notify>,
    active_transcodes: Arc<tokio::sync::Mutex<BTreeMap<String, ActiveTranscode>>>,
    transcode_start_lock: Arc<tokio::sync::Mutex<()>>,
    http: reqwest::Client,
    // qBittorrent runs locally, so a long or unbounded request only leaves the
    // magnet safety screen spinning. Keep its health checks decisively bounded.
    qbittorrent_http: reqwest::Client,
    persistence_lock: Arc<tokio::sync::Mutex<()>>,
    magnet_operation_lock: Arc<tokio::sync::Mutex<()>>,
    discovery_lock: Arc<tokio::sync::Mutex<()>>,
    active_trickplay_libraries: Arc<tokio::sync::Mutex<BTreeMap<String, ActiveTrickplay>>>,
    finished_trickplay_libraries: Arc<tokio::sync::Mutex<BTreeMap<String, FinishedTrickplay>>>,
    trickplay_run_lock: Arc<tokio::sync::Mutex<()>>,
    trickplay_control_notify: Arc<tokio::sync::Notify>,
    active_thumbnail_libraries: Arc<tokio::sync::Mutex<BTreeMap<String, ActiveThumbnails>>>,
    finished_thumbnail_libraries: Arc<tokio::sync::Mutex<BTreeMap<String, FinishedThumbnails>>>,
    active_browser_media_libraries: Arc<tokio::sync::Mutex<BTreeMap<String, ActiveBrowserMedia>>>,
    finished_browser_media_libraries:
        Arc<tokio::sync::Mutex<BTreeMap<String, FinishedBrowserMedia>>>,
    browser_media_control_notify: Arc<tokio::sync::Notify>,
    thumbnail_run_lock: Arc<tokio::sync::Mutex<()>>,
    thumbnail_control_notify: Arc<tokio::sync::Notify>,
    active_playback: Arc<tokio::sync::Mutex<HashMap<String, ActivePlayback>>>,
    library_duration_cache_path: PathBuf,
    library_duration_cache: Arc<tokio::sync::Mutex<HashMap<String, CachedLibraryDuration>>>,
    library_cache: Arc<tokio::sync::RwLock<HashMap<Option<String>, Vec<LibraryEntry>>>>,
    library_scan_locks:
        Arc<tokio::sync::Mutex<HashMap<Option<String>, std::sync::Weak<tokio::sync::Mutex<()>>>>>,
    library_cache_generation: Arc<std::sync::atomic::AtomicU64>,
    quality_cache: Arc<tokio::sync::Mutex<HashMap<String, (u64, QualityResponse)>>>,
    log_line_cache: Arc<tokio::sync::Mutex<HashMap<String, (u64, usize)>>>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct CachedLibraryDuration {
    size: u64,
    modified_at: u64,
    duration: Option<f64>,
}

struct ActiveTranscode {
    preload: bool,
    child: tokio::process::Child,
    directory: PathBuf,
    sessions: BTreeSet<String>,
    video_path: String,
    quality: String,
    started_at: u64,
    initiated_by: Option<String>,
}

struct ActivePlayback {
    started_at: Instant,
    started_position: f64,
    user_name: String,
    video_path: String,
    reported_at: u64,
}

struct ActiveTrickplay {
    started_at: u64,
    initiated_by: Option<String>,
    ffmpeg_pid: Option<u32>,
    current_video: Option<String>,
    current_output_dir: Option<PathBuf>,
    current_video_started_at: Option<u64>,
    current_expected_frames: Option<u64>,
    completed_videos: usize,
    total_videos: usize,
    inventory_complete: bool,
    paused_until: Option<u64>,
    max_speed: bool,
    waits_for_idle: bool,
}

/// A library whose previews are all generated keeps reporting 100% instead of
/// vanishing from the queue, which is the only way to tell "finished" apart from
/// "never started".
struct FinishedTrickplay {
    started_at: u64,
    initiated_by: Option<String>,
    total_videos: usize,
    generated_videos: usize,
    failed_videos: usize,
}

struct ActiveThumbnails {
    started_at: u64,
    initiated_by: Option<String>,
    current_file: Option<String>,
    completed_files: usize,
    total_files: usize,
    inventory_complete: bool,
    paused_until: Option<u64>,
}

struct FinishedThumbnails {
    started_at: u64,
    initiated_by: Option<String>,
    total_files: usize,
    generated_files: usize,
    failed_files: usize,
}

struct ActiveBrowserMedia {
    started_at: u64,
    initiated_by: Option<String>,
    ffmpeg_pid: Option<u32>,
    current_file: Option<String>,
    completed_files: usize,
    total_files: usize,
    inventory_complete: bool,
    paused_until: Option<u64>,
    max_speed: bool,
}

struct FinishedBrowserMedia {
    started_at: u64,
    initiated_by: Option<String>,
    total_files: usize,
    generated_files: usize,
    failed_files: usize,
}

/// Keeps the normal request trace quiet while preserving actionable latency and
/// error telemetry in the rotating server logs.
#[derive(Clone, Copy)]
struct PerformanceResponseLogger;

impl<B> OnResponse<B> for PerformanceResponseLogger {
    fn on_response(self, response: &HttpResponse<B>, latency: Duration, span: &tracing::Span) {
        let latency_ms = latency.as_millis() as u64;
        let status = response.status();
        if status.is_server_error() {
            tracing::error!(parent: span, %status, latency_ms, "HTTP request failed");
        } else if status.is_client_error() {
            tracing::warn!(parent: span, %status, latency_ms, "HTTP request rejected");
        } else if latency >= Duration::from_secs(2) {
            tracing::warn!(parent: span, %status, latency_ms, "Very slow HTTP request completed");
        } else if latency >= Duration::from_millis(250) {
            tracing::info!(parent: span, %status, latency_ms, "Slow HTTP request completed");
        }
    }
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    library_root: String,
    library_available: bool,
}

#[derive(Clone, Serialize)]
struct LibraryEntry {
    path: String,
    device_path: Option<String>,
    name: String,
    kind: &'static str,
    preview_path: Option<String>,
    preview_kind: Option<&'static str>,
    item_count: Option<u64>,
    /// Server-owned Movies & TV classification.  Both clients consume this
    /// instead of re-scanning the library independently.
    catalog_kind: Option<&'static str>,
    catalog_title_path: Option<String>,
    size: u64,
    created_at: u64,
    duration: Option<f64>,
    thumbnail_aspect_ratio: Option<f64>,
    #[serde(skip)]
    modified_at: u64,
}

#[derive(Default, Deserialize)]
struct LibraryQuery {
    sort: Option<String>,
    direction: Option<String>,
    folder: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    // Playback queues need the inventory, not per-file thumbnail reads or probes.
    metadata: Option<bool>,
}

#[derive(Clone, Copy)]
struct ZeroProgressObservation {
    first_seen: Instant,
}



#[derive(Clone, Deserialize, Serialize)]
struct LibraryMember {
    name: String,
    #[serde(default = "default_true")]
    can_view: bool,
    #[serde(default)]
    can_delete: bool,
    #[serde(default)]
    can_move: bool,
    #[serde(default)]
    can_create_folders: bool,
    #[serde(default)]
    can_upload: bool,
    #[serde(default)]
    can_download: bool,
    #[serde(default)]
    can_rename: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Deserialize, Serialize)]
struct LibraryConfig {
    content_type: String,
    #[serde(default)]
    members: Vec<LibraryMember>,
    #[serde(default)]
    title_folders: BTreeSet<String>,
    #[serde(default)]
    trickplay_enabled: bool,
    #[serde(default)]
    folder_structure_static: bool,
    /// Absolute source for a folder mounted into the main TMS root. This is
    /// persisted, but stripped from the public libraries response; only the
    /// admin-only locations endpoint exposes server filesystem paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
    /// External folders mounted below this library. These are persisted so a
    /// server restart can restore their managed junctions just like a whole
    /// external library.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    folder_mounts: Vec<LibraryFolderMount>,
}

#[derive(Clone, Deserialize, Serialize)]
struct LibraryFolderMount {
    /// Relative path below the library where the junction lives.
    path: String,
    /// Absolute source path outside the main TMS root.
    source_path: String,
}

#[derive(Deserialize)]
struct LibraryUpdate {
    path: String,
    content_type: String,
    members: Vec<LibraryMember>,
    #[serde(default)]
    trickplay_enabled: bool,
    #[serde(default)]
    folder_structure_static: bool,
}

#[derive(Deserialize)]
struct TitleFolderUpdate {
    path: String,
    title_folder: bool,
}

#[derive(Deserialize)]
struct CreateFolderRequest {
    parent_path: String,
    name: String,
}

#[derive(Deserialize)]
struct CreateLibraryRequest {
    name: String,
    content_type: String,
}

#[derive(Deserialize)]
struct CreateLibraryLocationRequest {
    name: String,
    path: String,
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    destination_library: Option<String>,
    #[serde(default)]
    destination_folder: Option<String>,
}

#[derive(Deserialize)]
struct RemoveLibraryFolderMountRequest {
    library: String,
    folder_path: String,
}

#[derive(Default, Deserialize)]
struct BrowseLibraryLocationsQuery {
    path: Option<String>,
}

#[derive(Serialize)]
struct LibraryLocationEntry {
    name: String,
    path: String,
    external: bool,
    available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_library: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    folder_path: Option<String>,
}

#[derive(Serialize)]
struct LibraryLocationsResponse {
    main_root: String,
    main_root_available: bool,
    locations: Vec<LibraryLocationEntry>,
}

#[derive(Serialize)]
struct FolderBrowserEntry {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct FolderBrowserResponse {
    current_path: Option<String>,
    parent_path: Option<String>,
    folders: Vec<FolderBrowserEntry>,
}

#[derive(Serialize)]
struct PickFolderResponse {
    path: Option<String>,
}

#[derive(Deserialize)]
struct DeleteMediaRequest {
    path: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct DeleteRequest {
    id: String,
    path: String,
    requested_by: u64,
    requested_by_name: String,
    requested_at: u64,
}

#[derive(Deserialize)]
struct ResolveDeleteRequest {
    action: String,
}

#[derive(Deserialize)]
struct MoveMediaRequest {
    source_path: String,
    destination_path: String,
    #[serde(default)]
    conflict_strategy: Option<ConflictStrategy>,
}

#[derive(Deserialize)]
struct BatchMoveMediaRequest {
    source_paths: Vec<String>,
    destination_path: String,
    #[serde(default)]
    conflict_strategy: Option<ConflictStrategy>,
}

#[derive(Serialize)]
struct BatchMoveMediaResponse {
    moved_count: usize,
}

#[derive(Serialize)]
struct MediaMutationResponse {
    path: String,
    name: String,
}

#[derive(Deserialize)]
struct RenameMediaRequest {
    source_path: String,
    new_name: String,
    #[serde(default)]
    conflict_strategy: Option<ConflictStrategy>,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ConflictStrategy {
    AutoRename,
}

#[derive(Clone, Deserialize, Serialize)]
struct TrashEntry {
    id: String,
    original_path: String,
    stored_name: String,
    name: String,
    kind: String,
    size: u64,
    deleted_at: u64,
    deleted_by: u64,
    #[serde(default)]
    library_config: Option<LibraryConfig>,
}

#[derive(Clone, Deserialize, Serialize)]
struct StoredUser {
    id: u64,
    name: String,
    password_hash: Option<String>,
    created_at: u64,
    #[serde(default)]
    is_admin: bool,
    #[serde(default)]
    admin_permissions: AdminPermissions,
    #[serde(default)]
    password_version: u64,
    #[serde(default)]
    avatar: Option<String>,
    #[serde(default = "default_storage_quota")]
    storage_quota_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
struct AdminPermissions {
    #[serde(default)]
    access_admin_panel: bool,
    #[serde(default)]
    view_users: bool,
    #[serde(default)]
    create_users: bool,
    #[serde(default)]
    edit_users: bool,
    #[serde(default)]
    delete_users: bool,
    #[serde(default)]
    view_logs: bool,
    #[serde(default)]
    view_processes: bool,
    #[serde(default)]
    manage_libraries: bool,
    #[serde(default)]
    manage_downloads: bool,
    #[serde(default)]
    logout_other_users: bool,
    #[serde(default)]
    logout_admins: bool,
}

impl AdminPermissions {
    fn full() -> Self {
        Self {
            access_admin_panel: true,
            view_users: true,
            create_users: true,
            edit_users: true,
            delete_users: true,
            view_logs: true,
            view_processes: true,
            manage_libraries: true,
            manage_downloads: true,
            logout_other_users: true,
            logout_admins: true,
        }
    }
}

fn effective_admin_permissions(user: &StoredUser) -> AdminPermissions {
    if user.is_admin {
        AdminPermissions::full()
    } else {
        user.admin_permissions
    }
}

fn has_admin_capability(
    user: &StoredUser,
    capability: impl FnOnce(AdminPermissions) -> bool,
) -> bool {
    let permissions = effective_admin_permissions(user);
    permissions.access_admin_panel && capability(permissions)
}

#[derive(Serialize)]
struct AdminUser {
    id: u64,
    name: String,
    password_set: bool,
    created_at: u64,
    last_active_at: Option<u64>,
    is_admin: bool,
    admin_permissions: AdminPermissions,
    storage_quota_bytes: Option<u64>,
    used_bytes: u64,
    reserved_bytes: u64,
    available_bytes: Option<u64>,
}

impl AdminUser {
    fn from_user(user: &StoredUser, ledger: &StorageLedger, last_active_at: Option<u64>) -> Self {
        let (used_bytes, reserved_bytes) = storage_usage(ledger, user.id);
        Self {
            id: user.id,
            name: user.name.clone(),
            password_set: user.password_hash.is_some(),
            created_at: user.created_at,
            last_active_at,
            is_admin: user.is_admin,
            admin_permissions: effective_admin_permissions(user),
            storage_quota_bytes: storage_quota_limit(user),
            used_bytes,
            reserved_bytes,
            available_bytes: storage_quota_limit(user)
                .map(|limit| limit.saturating_sub(used_bytes.saturating_add(reserved_bytes))),
        }
    }
}

const DEFAULT_STORAGE_QUOTA_BYTES: u64 = 100 * 1024 * 1024 * 1024;

fn default_storage_quota() -> Option<u64> {
    Some(DEFAULT_STORAGE_QUOTA_BYTES)
}

// Administrators own the server and are never subject to account storage limits.
// Keep this centralized so legacy admin records that still contain a quota are
// treated as unlimited everywhere, including active download reservations.
fn storage_quota_limit(user: &StoredUser) -> Option<u64> {
    if user.is_admin {
        None
    } else {
        user.storage_quota_bytes
    }
}

#[derive(Deserialize)]
struct CreateUserRequest {
    name: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    is_admin: bool,
    #[serde(default)]
    admin_permissions: AdminPermissions,
    #[serde(default = "default_storage_quota")]
    storage_quota_bytes: Option<u64>,
}

#[derive(Deserialize)]
struct UpdateUserRequest {
    password: Option<String>,
    is_admin: Option<bool>,
    admin_permissions: Option<AdminPermissions>,
    #[serde(default, deserialize_with = "deserialize_present_nullable_quota")]
    storage_quota_bytes: Option<Option<u64>>,
}

fn deserialize_present_nullable_quota<'de, D>(
    deserializer: D,
) -> Result<Option<Option<u64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<u64>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Deserialize, Serialize)]
struct StoredSession {
    /// Revocable, per-device credential that remains valid until logout or revocation.
    token: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    expires_at: u64,
    user_id: u64,
    password_version: u64,
    created_at: u64,
    #[serde(default)]
    last_active_at: u64,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    device_name: String,
    #[serde(default)]
    user_agent: String,
    #[serde(default)]
    ip_address: String,
}

#[derive(Serialize)]
struct SessionDevice {
    token: String,
    created_at: u64,
    device: String,
    user_agent: String,
    ip_address: String,
    current: bool,
    expires_at: u64,
}

#[derive(Deserialize)]
struct FolderDownloadQuery {
    path: String,
}

#[derive(Serialize)]
struct FolderDownloadResponse {
    url: String,
    filename: String,
    item_count: usize,
}

impl SessionDevice {
    fn from_session(session: &StoredSession, current_access_token: Option<&str>) -> Self {
        Self {
            token: session_public_id(session),
            created_at: session.created_at,
            device: if session.device_name.is_empty() {
                device_name(&session.user_agent)
            } else {
                session.device_name.clone()
            },
            user_agent: session.user_agent.clone(),
            ip_address: session.ip_address.clone(),
            current: current_access_token
                .is_some_and(|token| session_accepts_access_token(session, token)),
            expires_at: effective_session_expiry(session),
        }
    }
}

#[derive(Deserialize)]
struct LoginRequest {
    name: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    device_name: String,
}

#[derive(Deserialize)]
struct RefreshSessionRequest {
    refresh_token: String,
    #[serde(default)]
    device_id: String,
}

#[derive(Serialize)]
struct AuthSessionResponse {
    token: String,
    refresh_token: String,
    expires_at: u64,
    user: SessionUser,
}

#[derive(Serialize)]
struct SetupStatus {
    required: bool,
}

#[derive(Deserialize)]
struct SetupAdminRequest {
    name: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    device_name: String,
}

#[derive(Serialize)]
struct SessionUser {
    id: u64,
    name: String,
    is_admin: bool,
    admin_permissions: AdminPermissions,
    password_set: bool,
}

#[derive(Serialize)]
struct ProfileResponse {
    avatar: Option<String>,
}

#[derive(Deserialize)]
struct ProfilePasswordRequest {
    current_password: String,
    new_password: String,
}

#[derive(Deserialize)]
struct FavoriteUpdate {
    path: String,
    favorite: bool,
}

#[derive(Clone, Deserialize, Serialize, Default)]
struct PlaybackState {
    position: f64,
    duration: f64,
    updated: u64,
    #[serde(default)]
    completed: bool,
}

fn default_playback_buffer_size_mb() -> u16 {
    500
}

fn default_auto_next_enabled() -> bool {
    true
}

fn default_image_seconds() -> u32 {
    5
}

fn default_caption_font_size() -> u16 {
    100
}
fn default_caption_text_color() -> String {
    "#ffffff".to_owned()
}
fn default_caption_background_color() -> String {
    "#000000".to_owned()
}
fn default_caption_background_opacity() -> f32 {
    0.0
}
fn default_caption_font_family() -> String {
    "system".to_owned()
}
fn default_caption_text_edge() -> String {
    "outline".to_owned()
}
fn default_caption_position_x() -> f32 {
    48.46434
}
fn default_caption_position_y() -> f32 {
    94.269875
}

#[derive(Clone, Deserialize, Serialize)]
struct CaptionPreferences {
    #[serde(default = "default_caption_font_size")]
    font_size: u16,
    #[serde(default = "default_caption_text_color")]
    text_color: String,
    #[serde(default = "default_caption_background_color")]
    background_color: String,
    #[serde(default = "default_caption_background_opacity")]
    background_opacity: f32,
    #[serde(default = "default_caption_font_family")]
    font_family: String,
    #[serde(default = "default_caption_text_edge")]
    text_edge: String,
    #[serde(default = "default_caption_position_x")]
    position_x: f32,
    #[serde(default = "default_caption_position_y")]
    position_y: f32,
}

impl Default for CaptionPreferences {
    fn default() -> Self {
        Self {
            font_size: default_caption_font_size(),
            text_color: default_caption_text_color(),
            background_color: default_caption_background_color(),
            background_opacity: default_caption_background_opacity(),
            font_family: default_caption_font_family(),
            text_edge: default_caption_text_edge(),
            position_x: default_caption_position_x(),
            position_y: default_caption_position_y(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct PlaybackPreferences {
    #[serde(default)]
    auto_skip_enabled: bool,
    #[serde(default)]
    auto_skip_by_show: BTreeMap<String, bool>,
    #[serde(default = "default_auto_next_enabled")]
    auto_next_enabled: bool,
    #[serde(default)]
    captions_enabled: bool,
    #[serde(default)]
    intro_seconds: u32,
    #[serde(default)]
    ending_seconds: u32,
    #[serde(default = "default_playback_buffer_size_mb")]
    buffer_size_mb: u16,
    #[serde(default = "default_image_seconds")]
    image_seconds: u32,
    #[serde(default)]
    load_all_items: bool,
    #[serde(default)]
    caption_preferences: CaptionPreferences,
}

impl Default for PlaybackPreferences {
    fn default() -> Self {
        Self {
            auto_skip_enabled: false,
            auto_skip_by_show: BTreeMap::new(),
            auto_next_enabled: default_auto_next_enabled(),
            captions_enabled: false,
            intro_seconds: 0,
            ending_seconds: 0,
            buffer_size_mb: default_playback_buffer_size_mb(),
            image_seconds: default_image_seconds(),
            load_all_items: false,
            caption_preferences: CaptionPreferences::default(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize, Default)]
struct UserState {
    #[serde(default)]
    favorites: BTreeSet<String>,
    #[serde(default)]
    playback: BTreeMap<String, PlaybackState>,
    #[serde(default)]
    last_accessed: BTreeMap<String, u64>,
    #[serde(default)]
    tags: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    tag_catalog: BTreeMap<String, TagDefinition>,
    #[serde(default)]
    playlists: BTreeMap<String, Playlist>,
    #[serde(default)]
    playback_preferences: PlaybackPreferences,
    #[serde(default)]
    caption_selections: BTreeMap<String, CaptionSelection>,
}

#[derive(Clone, Deserialize, Serialize)]
struct CaptionSelection {
    source: String,
    #[serde(default)]
    track_label: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, Default)]
struct UserStates {
    #[serde(default)]
    users: BTreeMap<u64, UserState>,
}

#[derive(Clone, Deserialize, Serialize)]
struct StorageAllocation {
    id: String,
    user_id: u64,
    source: String,
    path: String,
    bytes: u64,
    created_at: u64,
    #[serde(default)]
    trash_id: Option<String>,
    #[serde(default)]
    job_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct StorageReservation {
    id: String,
    user_id: u64,
    source: String,
    bytes: u64,
    created_at: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct StorageLedger {
    #[serde(default)]
    allocations: Vec<StorageAllocation>,
    #[serde(default)]
    reservations: Vec<StorageReservation>,
}

#[derive(Serialize)]
struct StorageQuotaResponse {
    storage_quota_bytes: Option<u64>,
    used_bytes: u64,
    reserved_bytes: u64,
    available_bytes: Option<u64>,
    unlimited: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct Playlist {
    id: String,
    name: String,
    #[serde(default)]
    paths: BTreeSet<String>,
    created_at: u64,
    #[serde(default)]
    updated_at: u64,
}

#[derive(Clone, Deserialize, Serialize)]
struct TagDefinition {
    name: String,
    created_at: u64,
    #[serde(default)]
    updated_at: u64,
}

#[derive(Deserialize)]
struct CreatePlaylistRequest {
    name: String,
}

#[derive(Deserialize)]
struct CreateTagRequest {
    name: String,
}

#[derive(Deserialize)]
struct UpdatePlaylistRequest {
    name: String,
}

#[derive(Deserialize)]
struct OrganizeItemRequest {
    path: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    playlist_ids: BTreeSet<String>,
}

#[derive(Deserialize)]
struct MagnetDownloadRequest {
    magnet: String,
    destination_path: String,
}

#[derive(Deserialize)]
struct MagnetPrepareRequest {
    destination_path: String,
}

#[derive(Deserialize)]
struct MagnetControlRequest {
    hash: String,
    action: String,
}

#[derive(Default, Deserialize)]
struct MagnetStatusQuery {
    #[serde(default)]
    check_route: Option<String>,
}

#[derive(Deserialize)]
struct AutomaticFolderCoverRequest {
    folder_path: String,
    #[serde(default)]
    refresh: bool,
}





#[derive(Clone, Default, Deserialize, Serialize)]
struct YtDlpToolStatus {
    ready: bool,
    checking: bool,
    version: Option<String>,
    error: Option<String>,
    updated_at: Option<u64>,
}

#[derive(Deserialize)]
struct YtDlpInspectRequest {
    url: String,
    destination_path: String,
    mode: String,
}

#[derive(Serialize, Clone)]
struct YtDlpPreviewItem {
    title: String,
    duration_seconds: Option<u64>,
}

#[derive(Serialize)]
struct YtDlpInspection {
    title: String,
    extractor: String,
    item_count: Option<u64>,
    estimated_bytes: Option<u64>,
    estimated_bytes_is_approx: bool,
    preview_items: Vec<YtDlpPreviewItem>,
    mode: String,
    destination_path: String,
    quota: StorageQuotaResponse,
}

#[derive(Deserialize)]
struct YtDlpQueueRequest {
    url: String,
    destination_path: String,
    mode: String,
    #[serde(default)]
    tags: Vec<String>,
    playlist_id: Option<String>,
    new_playlist_name: Option<String>,
    folder_path: Option<String>,
    new_folder_name: Option<String>,
}

#[derive(Deserialize)]
struct YtDlpControlRequest {
    action: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct YtDlpJob {
    id: String,
    user_id: u64,
    user_name: String,
    url: String,
    destination_path: String,
    mode: String,
    title: String,
    extractor: String,
    item_count: Option<u64>,
    estimated_bytes: Option<u64>,
    reserved_bytes: u64,
    downloaded_bytes: u64,
    progress: f64,
    speed: Option<String>,
    eta: Option<String>,
    current_item: Option<String>,
    status: String,
    error: Option<String>,
    created_at: u64,
    updated_at: u64,
    #[serde(default)]
    process_pid: Option<u32>,
    #[serde(default)]
    cancel_requested: bool,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    playlist_id: Option<String>,
    #[serde(default)]
    new_playlist_name: Option<String>,
    #[serde(default)]
    folder_path: Option<String>,
    #[serde(default)]
    new_folder_name: Option<String>,
    #[serde(default)]
    cookie_refresh_attempted: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct YtDlpJobs {
    #[serde(default)]
    jobs: Vec<YtDlpJob>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct YtDlpThrottleSettings {
    #[serde(default)]
    sleep_interval_seconds: u64,
    #[serde(default)]
    max_sleep_interval_seconds: u64,
    #[serde(default)]
    limit_rate: String,
}

#[derive(Serialize, Clone, Debug)]
struct YtDlpCookiesStatus {
    exists: bool,
    size_bytes: u64,
    updated_at: Option<u64>,
    line_count: usize,
    sample_domains: Vec<String>,
    has_youtube_auth: bool,
}

#[derive(Serialize)]
struct AdminDownloadStatus {
    tool: YtDlpToolStatus,
    throttle: YtDlpThrottleSettings,
    cookies: YtDlpCookiesStatus,
}

#[derive(Serialize)]
struct AdminProcessTransfer {
    state: String,
    download_speed: u64,
    upload_speed: u64,
    completed_bytes: u64,
    total_bytes: u64,
    remaining_bytes: u64,
    eta_seconds: u64,
    seeds: u64,
    peers: u64,
}

#[derive(Serialize)]
struct AdminProcess {
    id: String,
    kind: String,
    status: String,
    title: String,
    detail: String,
    user_name: Option<String>,
    progress: Option<f64>,
    started_at: u64,
    pid: Option<u32>,
    eta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eta_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avg_item_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_item: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    paused_until: Option<u64>,
    transfer: Option<AdminProcessTransfer>,
    actions: Vec<String>,
}

#[derive(Serialize)]
struct AdminProcessesResponse {
    processes: Vec<AdminProcess>,
}

#[derive(Deserialize)]
struct AdminProcessControlRequest {
    action: String,
}

#[derive(Deserialize)]
struct MetadataQuery {
    title: String,
    kind: String,
    year: Option<String>,
    tmdb_id: Option<u64>,
    seasons: Option<usize>,
    episodes: Option<usize>,
}

#[derive(Deserialize)]
struct SkipSegmentsQuery {
    video_path: String,
    #[serde(default)]
    imdb_id: String,
    season: Option<u32>,
    episode: Option<u32>,
    duration: f64,
    #[serde(default)]
    refresh: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct SkipSegmentIdentity {
    video_path: String,
    imdb_id: String,
    season: Option<u32>,
    episode: Option<u32>,
    duration: f64,
    file_size: u64,
    modified_at: u64,
}

#[derive(Clone, Deserialize, Serialize)]
struct SkipSegmentEvidence {
    kind: String,
    start: f64,
    end: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    submission_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct SkipProviderEvidence {
    provider: String,
    status: String,
    latency_ms: u64,
    segments: Vec<SkipSegmentEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw: Option<Value>,
}

#[derive(Clone, Deserialize, Serialize)]
struct SkipSegmentDecision {
    kind: String,
    start: f64,
    end: f64,
    confidence: f64,
    agreement: usize,
    providers: Vec<String>,
    reason: String,
    auto_skip_safe: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct SkipSegmentsResponse {
    identity: SkipSegmentIdentity,
    providers: Vec<SkipProviderEvidence>,
    segments: Vec<SkipSegmentDecision>,
    fetched_at: u64,
    cache_status: String,
}

#[derive(Default, Deserialize, Serialize)]
struct SkipSegmentsCache {
    entries: BTreeMap<String, SkipSegmentsResponse>,
}

#[derive(Clone, Copy, Serialize)]
struct FingerprintRange {
    target_start: f64,
    target_end: f64,
    peer_start: f64,
    peer_end: f64,
}

#[derive(Clone, Copy, Serialize)]
struct BlackInterval {
    start: f64,
    end: f64,
}

#[derive(Deserialize)]
struct VideoPathQuery {
    video_path: String,
}

#[derive(Deserialize)]
struct PreviewFrameQuery {
    video_path: String,
    time: f64,
    subtitle_stream: Option<u32>,
}

#[derive(Deserialize)]
struct GridThumbQuery {
    path: String,
}

#[derive(Deserialize)]
struct SubtitlePathQuery {
    path: String,
}

#[derive(Deserialize)]
struct RemoteSubtitleQuery {
    url: String,
}

#[derive(Deserialize)]
struct EmbeddedSubtitleQuery {
    video_path: String,
    stream_index: u32,
}

#[derive(Deserialize)]
struct StremioSubtitle {
    id: String,
    url: String,
    lang: String,
}

#[derive(Deserialize)]
struct WyzieSubtitle {
    url: String,
    language: String,
    source: String,
}

#[derive(Deserialize)]
struct SubdlSearchResult {
    #[serde(default)]
    subtitles: Vec<SubdlSubtitle>,
}

#[derive(Deserialize)]
struct SubdlSubtitle {
    #[serde(default)]
    release_name: String,
    #[serde(default)]
    unpack_files: Vec<SubdlSubtitleFile>,
}

#[derive(Deserialize)]
struct SubdlSubtitleFile {
    name: String,
    url: String,
    language: String,
    #[serde(default)]
    format: String,
}

#[derive(Serialize)]
struct SubtitleTrack {
    label: String,
    language: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_index: Option<u32>,
}

#[derive(Deserialize)]
struct CaptionSelectionUpdate {
    key: String,
    source: String,
    #[serde(default)]
    track_label: Option<String>,
}

#[derive(Deserialize)]
struct TranscodeQuery {
    #[serde(default)]
    preload: bool,
    video_path: String,
    quality: String,
    start: Option<f64>,
    buffer_size_mb: Option<u16>,
    session: Option<String>,
    attempt_id: Option<String>,
    audio_stream: Option<u32>,
    subtitle_stream: Option<u32>,
}

#[derive(Deserialize)]
struct AutoTranscodeVariantQuery {
    video_path: String,
    height: u32,
    start: u64,
    session: String,
    attempt_id: Option<String>,
    audio_stream: Option<u32>,
    subtitle_stream: Option<u32>,
}

#[derive(Deserialize)]
struct CancelTranscodeQuery {
    session: String,
}

#[derive(Serialize, Clone)]
struct QualityResponse {
    source_height: u32,
    levels: Vec<u32>,
    audio_codec: Option<String>,
    audio_compatible: bool,
    audio_tracks: Vec<AudioTrack>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_media_url: Option<String>,
}

#[derive(Serialize, Clone)]
struct AudioTrack {
    stream_index: u32,
    label: String,
    language: String,
    #[serde(default)]
    is_default: bool,
}

#[derive(Serialize)]
struct TranscodeResponse {
    url: String,
    offset: f64,
    session: String,
}

#[derive(Deserialize)]
struct AdminLogsQuery {
    sort: Option<String>,
    direction: Option<String>,
    offset: Option<usize>,
    page_size: Option<usize>,
    level: Option<String>,
    emitter: Option<String>,
    actor: Option<String>,
    kind: Option<String>,
    search: Option<String>,
}

#[derive(Serialize)]
struct AdminLogsResponse {
    files: Vec<String>,
    lines: Vec<String>,
    actors: Vec<String>,
    total_events: usize,
    stored_events: usize,
    total_bytes: u64,
}

#[derive(Deserialize)]
struct AdminLogPruneRequest {
    count: usize,
}

#[derive(Deserialize)]
struct ClientErrorReport {
    message: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    stack: String,
    #[serde(default)]
    route: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    line: u32,
    #[serde(default)]
    column: u32,
    #[serde(default)]
    user_agent: String,
}

#[derive(Deserialize)]
struct ClientPerformanceReport {
    event: String,
    duration_ms: u64,
    #[serde(default)]
    route: String,
    #[serde(default)]
    details: serde_json::Value,
}

#[derive(Deserialize)]
struct PlaybackActivity {
    event: String,
    media_name: String,
    path: String,
    position: f64,
    duration: f64,
    #[serde(default = "default_true")]
    save_progress: bool,
}

#[derive(Deserialize)]
struct FileDownloadActivity {
    path: String,
    media_name: String,
}

#[derive(Deserialize)]
struct AccessActivity {
    path: String,
}

fn current_unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn opened_timestamp(state: &UserState, path: &str) -> u64 {
    let accessed = state.last_accessed.get(path).copied().unwrap_or(0);
    let played = state
        .playback
        .get(path)
        .map(|playback| playback.updated)
        .unwrap_or(0);
    accessed.max(played)
}

#[derive(Serialize)]
struct AdminPerformanceResponse {
    lines: Vec<String>,
}

#[derive(Serialize)]
struct ClearPerformanceResponse {
    removed: usize,
}

fn opened_timestamp_for_library_entry(state: &UserState, entry: &LibraryEntry) -> u64 {
    let mut timestamp = opened_timestamp(state, &entry.path);
    if entry.kind != "folder" {
        return timestamp;
    }

    let prefix = format!("{}/", entry.path);
    // User activity is persisted for the concrete media file. A folder/title
    // card should sort by its newest descendant activity, otherwise a show
    // such as Monarch falls back to its added date after an episode is played.
    for (path, accessed) in state.last_accessed.range(prefix.clone()..) {
        if !path.starts_with(&prefix) {
            break;
        }
        timestamp = timestamp.max(*accessed);
    }
    for (path, playback) in state.playback.range(prefix.clone()..) {
        if !path.starts_with(&prefix) {
            break;
        }
        timestamp = timestamp.max(playback.updated);
    }
    timestamp
}

fn touch_last_accessed(states: &mut UserStates, user_id: u64, path: &str) -> u64 {
    let now = current_unix_timestamp();
    states
        .users
        .entry(user_id)
        .or_default()
        .last_accessed
        .insert(path.to_string(), now);
    now
}

fn panic_summary(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&'static str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic payload".to_owned())
}

/// Keeps a background worker alive for the lifetime of the process. A worker
/// that panics is restarted after a pause instead of disappearing silently,
/// which previously stalled downloads until TMS was restarted by hand.
fn supervise<Factory, Worker>(name: &'static str, mut worker: Factory)
where
    Factory: FnMut() -> Worker + Send + 'static,
    Worker: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        let mut restarts: u32 = 0;
        loop {
            match tokio::spawn(worker()).await {
                Ok(()) => return,
                Err(error) if error.is_panic() => {
                    restarts += 1;
                    let summary = panic_summary(error.into_panic().as_ref());
                    // Back off gradually so a worker that fails immediately on
                    // every attempt cannot saturate the CPU or the log file.
                    let pause = Duration::from_secs(5 * u64::from(restarts.min(12)));
                    tracing::error!(
                        worker = name,
                        restarts,
                        panic = %summary,
                        retry_in_seconds = pause.as_secs(),
                        "Background worker panicked; restarting it"
                    );
                    tokio::time::sleep(pause).await;
                }
                Err(_) => return,
            }
        }
    });
}

#[tokio::main]
async fn main() {
    let library_root = env::var_os("TMS_LIBRARY_ROOT")
        .or_else(|| env::var_os("FRAMEBOX_LIBRARY_ROOT"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\TariqsMediaServer"));
    let data_root = library_root.join(".tms-data");
    let port = env::var("TMS_PORT")
        .or_else(|_| env::var("FRAMEBOX_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let configured_bind = env::var("TMS_BIND_ADDRESS")
        .or_else(|_| env::var("FRAMEBOX_BIND_ADDRESS"))
        .unwrap_or_else(|_| "127.0.0.1".to_owned());
    let bind_ip = configured_bind
        .parse::<IpAddr>()
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let logs_dir = data_root.join("logs");
    let _ = std::fs::create_dir_all(&logs_dir);
    let file_appender = tracing_appender::rolling::daily(&logs_dir, "tms");
    let (log_writer, _log_guard) = tracing_appender::non_blocking(file_appender);
    let mut log_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    for directive in ["tms_server=info", "tower_http=info"] {
        if let Ok(parsed) = directive.parse() {
            log_filter = log_filter.add_directive(parsed);
        }
    }
    tracing_subscriber::fmt()
        .with_env_filter(log_filter)
        .with_writer(log_writer)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_timer(tracing_subscriber::fmt::time::LocalTime::rfc_3339())
        .init();

    // A panic anywhere would otherwise only reach stderr, which the launcher
    // discards. Recording it keeps every failure diagnosable from the log file.
    let default_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown location".to_owned());
        tracing::error!(
            location = %location,
            panic = %panic_summary(info.payload()),
            "Panic caught; TMS keeps running"
        );
        default_panic_hook(info);
    }));

    if bind_ip.to_string() != configured_bind {
        tracing::warn!(
            configured = %configured_bind,
            using = %bind_ip,
            "TMS_BIND_ADDRESS is not a valid IP address; falling back to loopback"
        );
    }

    let library_duration_cache_path = data_root.join("library-durations.json");
    let library_duration_cache = std::fs::read(&library_duration_cache_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let state = AppState {
        library_root: library_root.clone(),
        discovery_lock: Arc::new(tokio::sync::Mutex::new(())),
        libraries_path: data_root.join("libraries.json"),
        users_path: data_root.join("users.json"),
        sessions_path: data_root.join("sessions.json"),
        legacy_folder_types_path: data_root.join("folder-types.json"),
        logs_dir,
        user_state_path: data_root.join("user-state.json"),
        folder_covers_path: data_root.join("folder-covers.json"),
        automatic_folder_covers_path: data_root.join("automatic-folder-covers.json"),
        folder_covers_dir: data_root.join("folder-covers"),
        profile_avatars_dir: data_root.join("profile-avatars"),
        trash_dir: data_root.join("trash"),
        trash_path: data_root.join("trash.json"),
        delete_requests_path: data_root.join("delete-requests.json"),
        storage_path: data_root.join("storage-allocations.json"),
        upload_sessions_path: data_root.join("upload-sessions.json"),
        uploads_dir: data_root.join("uploads"),
        upload_sessions_lock: Arc::new(tokio::sync::Mutex::new(())),
        upload_write_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        download_jobs_path: data_root.join("yt-dlp-jobs.json"),
        magnet_jobs_path: data_root.join("magnet-jobs.json"),
        folder_downloads_dir: data_root.join("folder-downloads"),
        ytdlp_dir: data_root.join("yt-dlp"),
        ytdlp_path: data_root.join("yt-dlp").join("yt-dlp.exe"),
        ytdlp_staging_dir: data_root.join("yt-dlp").join("staging"),
        ytdlp_settings_path: data_root.join("yt-dlp").join("settings.json"),
        transcodes_dir: data_root.join("transcodes"),
        skip_segments_path: data_root.join("skip-segments.json"),
        shared_todo_path: data_root.join("shared-todo.json"),
        skip_fingerprints_dir: data_root.join("skip-fingerprints"),
        trickplay_dir: data_root.join("trickplay"),
        browser_media_dir: data_root.join("browser-media"),
        grid_thumbs_dir: data_root.join("grid-thumbs"),
        title_metadata_dir: data_root.join("title-metadata"),
        ffmpeg_path: env::var_os("TMS_FFMPEG")
            .or_else(|| env::var_os("FRAMEBOX_FFMPEG"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\Jellyfin\Server\ffmpeg.exe")),
        ffprobe_path: env::var_os("TMS_FFPROBE")
            .or_else(|| env::var_os("FRAMEBOX_FFPROBE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\Jellyfin\Server\ffprobe.exe")),
        qbittorrent_url: env::var("TMS_QBITTORRENT_URL")
            .or_else(|_| env::var("FRAMEBOX_QBITTORRENT_URL"))
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_owned())
            .filter(|value| value.starts_with("http://") || value.starts_with("https://")),
        qbittorrent_username: env::var("TMS_QBITTORRENT_USERNAME")
            .or_else(|_| env::var("FRAMEBOX_QBITTORRENT_USERNAME"))
            .ok()
            .filter(|value| !value.trim().is_empty()),
        qbittorrent_password: env::var("TMS_QBITTORRENT_PASSWORD")
            .or_else(|_| env::var("FRAMEBOX_QBITTORRENT_PASSWORD"))
            .ok(),
        vpn_interface: env::var("TMS_VPN_INTERFACE")
            .or_else(|_| env::var("FRAMEBOX_VPN_INTERFACE"))
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
        wyzie_api_key: env::var("TMS_WYZIE_API_KEY")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
        subdl_api_key: env::var("TMS_SUBDL_API_KEY")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
        qbittorrent_exe: env::var_os("TMS_QBITTORRENT_EXE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\qBittorrent\qbittorrent.exe")),
        proton_launcher_path: env::var_os("TMS_PROTON_LAUNCHER")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(r"C:\Program Files\Proton\VPN\ProtonVPN.Launcher.exe")
            }),
        qbittorrent_cookie: Arc::new(tokio::sync::Mutex::new(None)),
        qbittorrent_session_lock: Arc::new(tokio::sync::Mutex::new(())),
        active_downloads: Arc::new(tokio::sync::Mutex::new(BTreeSet::new())),
        qbit_zero_progress: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        qbit_last_recovery: Arc::new(tokio::sync::Mutex::new(None)),
        qbit_restart_lock: Arc::new(tokio::sync::Mutex::new(())),
        ytdlp_tool: Arc::new(tokio::sync::Mutex::new(YtDlpToolStatus::default())),
        ytdlp_notify: Arc::new(tokio::sync::Notify::new()),
        active_transcodes: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
        transcode_start_lock: Arc::new(tokio::sync::Mutex::new(())),
        http: reqwest::Client::new(),
        qbittorrent_http: reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "Falling back to a default qBittorrent HTTP client");
                reqwest::Client::new()
            }),
        persistence_lock: Arc::new(tokio::sync::Mutex::new(())),
        magnet_operation_lock: Arc::new(tokio::sync::Mutex::new(())),
        active_trickplay_libraries: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
        finished_trickplay_libraries: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
        trickplay_run_lock: Arc::new(tokio::sync::Mutex::new(())),
        trickplay_control_notify: Arc::new(tokio::sync::Notify::new()),
        active_thumbnail_libraries: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
        finished_thumbnail_libraries: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
        active_browser_media_libraries: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
        finished_browser_media_libraries: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
        browser_media_control_notify: Arc::new(tokio::sync::Notify::new()),
        thumbnail_run_lock: Arc::new(tokio::sync::Mutex::new(())),
        thumbnail_control_notify: Arc::new(tokio::sync::Notify::new()),
        active_playback: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        library_duration_cache_path,
        library_duration_cache: Arc::new(tokio::sync::Mutex::new(library_duration_cache)),
        library_cache: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
        library_scan_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        library_cache_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        quality_cache: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        log_line_cache: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    };
    ensure_external_library_mounts(&state).await;
    spawn_download_watcher(state.clone());
    discovery::requests::start_worker(state.clone());
    spawn_ytdlp_tool_updater(state.clone());
    spawn_ytdlp_worker(state.clone());
    spawn_storage_maintenance(state.clone());
    uploads::spawn_upload_session_sweep(state.clone());
    spawn_trickplay_cache_sweep(state.clone());
    spawn_background_indexer(state.clone());
    for (library, config) in read_libraries(&state).await {
        schedule_browser_media_library(state.clone(), library.clone());
        if config.trickplay_enabled {
            schedule_library_preload(state.clone(), library, TrickplayRun::Automatic, None);
        }
    }
    let transcode_files = Router::new()
        .fallback_service(ServeDir::new(state.transcodes_dir.clone()))
        .layer(SetResponseHeaderLayer::overriding(
            CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));

    let app = Router::new()
        .merge(discovery::routes())
        .route("/api/health", get(health))
        .route("/api/library", get(library))
        .route(
            "/api/libraries",
            get(libraries).put(update_library).post(create_library),
        )
        .route("/api/libraries/{name}", delete(delete_library))
        .route(
            "/api/libraries/{name}/trickplay",
            post(run_trickplay_library),
        )
        .route(
            "/api/admin/library-locations",
            get(admin_library_locations).post(create_library_location),
        )
        .route(
            "/api/admin/library-locations/folder",
            delete(remove_library_folder_mount),
        )
        .route(
            "/api/admin/library-locations/browse",
            get(browse_library_locations),
        )
        .route(
            "/api/admin/library-locations/pick-folder",
            post(pick_library_location_folder),
        )
        .route("/api/folders", post(create_folder))
        .route("/api/media", delete(delete_media))
        .route("/api/delete-requests", get(my_delete_requests).post(request_media_delete))
        .route("/api/admin/delete-requests", get(admin_delete_requests))
        .route("/api/admin/delete-requests/{id}", post(resolve_delete_request))
        .route("/api/move", post(move_media))
        .route("/api/move/batch", post(move_media_batch))
        .route("/api/rename", post(rename_media))
        .route("/api/trash", get(trash).delete(empty_trash))
        .route("/api/trash/{id}/restore", post(restore_trash))
        .route("/api/trash/{id}", delete(permanently_delete_trash))
        .route("/api/uploads", post(upload_file))
        .route(
            "/api/uploads/sessions",
            get(uploads::list_upload_sessions).post(uploads::create_upload_session),
        )
        .route(
            "/api/uploads/sessions/{id}",
            get(uploads::get_upload_session)
                .put(uploads::put_upload_chunk)
                .delete(uploads::cancel_upload_session),
        )
        .route(
            "/api/uploads/sessions/{id}/complete",
            post(uploads::complete_upload_session),
        )
        .route("/api/folder-download", post(download_folder))
        .route("/api/storage/quota", get(storage_quota))
        .route(
            "/api/downloads/magnet",
            get(magnet_download_status).post(queue_magnet_download),
        )
        .route(
            "/api/downloads/magnet/prepare",
            post(prepare_magnet_download),
        )
        .route(
            "/api/downloads/magnet/control",
            post(control_magnet_download),
        )
        .route(
            "/api/downloads/yt-dlp",
            get(ytdlp_jobs).post(queue_ytdlp_download),
        )
        .route(
            "/api/downloads/yt-dlp/refresh",
            post(refresh_ytdlp_jobs),
        )
        .route(
            "/api/downloads/yt-dlp/inspect",
            post(inspect_ytdlp_download),
        )
        .route(
            "/api/downloads/yt-dlp/cookies/refresh",
            post(refresh_ytdlp_cookies),
        )
        .route(
            "/api/downloads/yt-dlp/{id}/control",
            post(control_ytdlp_download),
        )
        .route(
            "/api/library-title-folders",
            get(libraries).put(update_title_folder),
        )
        .route("/api/admin/logs", get(admin_logs))
        .route("/api/admin/performance", get(admin_performance))
        .route("/api/admin/performance/clear", post(clear_admin_performance))
        .route("/api/admin/logs/prune", post(prune_admin_logs))
        .route("/api/admin/processes", get(admin_processes))
        .route("/api/admin/processes/{id}/control", post(control_admin_process))
        .route("/api/client-errors", post(report_client_error))
        .route("/api/client-performance", post(report_client_performance))
        .route("/api/admin/users", get(admin_users).post(create_admin_user))
        .route(
            "/api/admin/downloads",
            get(admin_download_status).post(update_ytdlp_tool),
        )
        .route(
            "/api/admin/downloads/settings",
            put(update_ytdlp_settings),
        )
        .route(
            "/api/admin/downloads/cookies",
            get(admin_get_ytdlp_cookies)
                .post(admin_update_ytdlp_cookies)
                .delete(admin_delete_ytdlp_cookies),
        )
        .route(
            "/api/admin/downloads/cookies/extract",
            post(admin_extract_ytdlp_cookies),
        )
        .route(
            "/api/admin/downloads/cookies/test",
            post(admin_test_ytdlp_cookies),
        )
        .route(
            "/api/admin/users/{id}",
            axum::routing::put(update_admin_user).delete(delete_admin_user),
        )
        .route("/api/admin/users/{id}/sessions", get(admin_user_sessions))
        .route(
            "/api/admin/users/{id}/sessions/{token}",
            axum::routing::delete(revoke_admin_user_session),
        )
        .route("/api/auth/login", post(login))
        .route("/api/auth/setup", get(setup_status).post(setup_admin))
        .route("/api/auth/session", get(current_session).post(refresh_session))
        .route("/api/auth/activity", post(record_session_activity))
        .route("/api/auth/logout", post(logout))
        .route(
            "/api/profile",
            get(profile)
                .put(change_profile_password)
                .post(upload_profile_avatar),
        )
        .route("/api/profile/sessions", get(profile_sessions))
        .route(
            "/api/profile/sessions/{token}",
            axum::routing::delete(revoke_profile_session),
        )
        .route("/api/activity", post(playback_activity))
        .route("/api/activity/access", post(access_activity))
        .route("/api/activity/file-download", post(file_download_activity))
        .route("/api/favorites", get(favorites).put(update_favorite))
        .route("/api/user-state", get(user_state))
        .route(
            "/api/playback-preferences",
            axum::routing::put(update_playback_preferences),
        )
        .route(
            "/api/caption-selection",
            axum::routing::put(update_caption_selection),
        )
        .route("/api/organize", axum::routing::put(organize_item))
        .route("/api/tags", post(create_tag))
        .route("/api/tags/{name}", axum::routing::delete(delete_tag))
        .route("/api/playlists", post(create_playlist))
        .route(
            "/api/playlists/{id}",
            axum::routing::put(update_playlist).delete(delete_playlist),
        )
        .route(
            "/api/playlists/{id}/clean-filenames",
            post(clean_playlist_filenames),
        )
        .route(
            "/api/folder-covers",
            get(folder_covers)
                .put(update_folder_cover)
                .delete(clear_folder_cover),
        )
        .route("/api/folder-covers/automatic", post(generate_automatic_folder_cover))
        .route("/api/title-metadata", get(title_metadata))
        .route("/api/skip-segments", get(skip_segments))
        .route(
            "/api/shared-todo",
            get(shared_todo).put(update_shared_todo),
        )
        .route("/api/subtitles", get(subtitles))
        .route("/api/subtitle", get(subtitle_file))
        .route("/api/embedded-subtitle", get(embedded_subtitle_file))
        .route("/api/remote-subtitle", get(remote_subtitle_file))
        .route("/api/preview-frame", get(preview_frame))
        .route("/api/grid-thumb", get(grid_thumb))
        .route("/api/qualities", get(qualities))
        .route("/api/transcode", get(transcode).delete(cancel_transcode))
        .route("/api/transcode/variant", get(auto_transcode_variant))
        .nest_service("/media", ServeDir::new(&library_root))
        .nest_service("/folder-downloads", ServeDir::new(state.folder_downloads_dir.clone()))
        .nest_service("/trash-files", ServeDir::new(state.trash_dir.clone()))
        .nest_service(
            "/folder-covers",
            ServeDir::new(state.folder_covers_dir.clone()),
        )
        .nest_service(
            "/profile-avatars",
            ServeDir::new(state.profile_avatars_dir.clone()),
        )
        .nest("/transcodes", transcode_files)
        .nest_service("/browser-media", ServeDir::new(state.browser_media_dir.clone()))
        // Library responses can be many megabytes of repetitive JSON. Mobile
        // WebViews otherwise spend most of startup transferring that payload.
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024 * 1024))
        .layer(
            TraceLayer::new_for_http()
                // Rejected and slow responses name their route. The query string
                // is left out because media URLs can carry session tokens.
                .make_span_with(|request: &axum::http::Request<_>| {
                    tracing::info_span!("request", method = %request.method(), path = %request.uri().path())
                })
                .on_response(PerformanceResponseLogger),
        )
        // Outermost layer: a panic inside any handler becomes a 500 for that one
        // request instead of tearing down the connection or the server.
        .layer(CatchPanicLayer::custom(|payload: Box<dyn Any + Send>| {
            tracing::error!(
                panic = %panic_summary(payload.as_ref()),
                "Request handler panicked; returning 500"
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "message": "TMS hit an unexpected error handling this request. It has been logged."
                })),
            )
                .into_response()
        }))
        .with_state(state);

    let address = SocketAddr::new(bind_ip, port);
    let Some(listener) = bind_with_retry(address).await else {
        tracing::error!(%address, "Could not bind the TMS port; another process is holding it");
        std::process::exit(1);
    };
    tracing::info!(%address, library = %library_root.display(), "TMS server ready");
    if let Err(error) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    {
        tracing::error!(%error, "TMS server stopped serving");
    }
}

/// A restart usually races the previous process releasing the port. Retrying
/// briefly turns that race into a short delay instead of a failed startup.
async fn bind_with_retry(address: SocketAddr) -> Option<tokio::net::TcpListener> {
    for attempt in 1..=120_u32 {
        match tokio::net::TcpListener::bind(address).await {
            Ok(listener) => return Some(listener),
            Err(error) => {
                tracing::warn!(
                    %address,
                    attempt,
                    %error,
                    "Could not bind the TMS port yet; retrying"
                );
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    None
}

fn admin_log_query_unfiltered(query: &AdminLogsQuery) -> bool {
    query
        .level
        .as_deref()
        .is_none_or(|value| value == "all")
        && query
            .emitter
            .as_deref()
            .is_none_or(|value| value == "all")
        && query
            .actor
            .as_deref()
            .is_none_or(|value| value == "all")
        && query
            .kind
            .as_deref()
            .is_none_or(|value| value == "all")
        && query
            .search
            .as_deref()
            .map(str::trim)
            .is_none_or(|value| value.is_empty())
}

fn count_log_lines(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = bytes.iter().filter(|&&byte| byte == b'\n').count();
    if bytes.last() == Some(&b'\n') {
        newlines
    } else {
        newlines + 1
    }
}

async fn list_admin_log_files(logs_dir: &Path) -> (Vec<String>, Vec<u64>, u64) {
    let mut files = Vec::new();
    let mut sizes = Vec::new();
    let mut total_bytes = 0_u64;
    if let Ok(mut directory) = tokio::fs::read_dir(logs_dir).await {
        while let Ok(Some(entry)) = directory.next_entry().await {
            if entry
                .file_type()
                .await
                .ok()
                .is_some_and(|file_type| file_type.is_file())
            {
                let name = entry.file_name().to_string_lossy().into_owned();
                let len = entry.metadata().await.map(|metadata| metadata.len()).unwrap_or(0);
                total_bytes = total_bytes.saturating_add(len);
                files.push(name);
                sizes.push(len);
            }
        }
    }
    let mut order = (0..files.len()).collect::<Vec<_>>();
    order.sort_by_key(|index| files[*index].clone());
    let files = order.iter().map(|index| files[*index].clone()).collect();
    let sizes = order.iter().map(|index| sizes[*index]).collect();
    (files, sizes, total_bytes)
}

async fn cached_log_line_count(
    cache: &tokio::sync::Mutex<HashMap<String, (u64, usize)>>,
    name: &str,
    path: &Path,
    size: u64,
) -> usize {
    {
        let guard = cache.lock().await;
        if let Some((cached_size, count)) = guard.get(name) {
            if *cached_size == size {
                return *count;
            }
        }
    }
    let count = tokio::fs::read(path)
        .await
        .map(|bytes| count_log_lines(&bytes))
        .unwrap_or(0);
    let mut guard = cache.lock().await;
    guard.insert(name.to_owned(), (size, count));
    count
}

async fn load_admin_logs_by_timestamp(
    state: &AppState,
    files: &[String],
    sizes: &[u64],
    query: &AdminLogsQuery,
    offset: usize,
    page_size: usize,
    descending: bool,
) -> (Vec<String>, usize, usize) {
    let unfiltered = admin_log_query_unfiltered(query);
    let mut stored_events = 0_usize;
    let mut total_events = 0_usize;
    let mut page = Vec::with_capacity(page_size.min(1_024));
    let mut to_skip = offset;
    let order: Vec<usize> = if descending {
        (0..files.len()).rev().collect()
    } else {
        (0..files.len()).collect()
    };
    for index in order {
        let name = &files[index];
        let size = sizes[index];
        let path = state.logs_dir.join(name);
        let page_complete = page.len() >= page_size && to_skip == 0;
        if page_complete {
            if unfiltered {
                stored_events = stored_events
                    .saturating_add(cached_log_line_count(&state.log_line_cache, name, &path, size).await);
                continue;
            }
            break;
        }
        if unfiltered && to_skip > 0 {
            let file_matches =
                cached_log_line_count(&state.log_line_cache, name, &path, size).await;
            stored_events = stored_events.saturating_add(file_matches);
            if to_skip >= file_matches {
                to_skip -= file_matches;
                continue;
            }
        }
        let Ok(content) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let mut file_lines = content.lines().collect::<Vec<_>>();
        {
            let mut guard = state.log_line_cache.lock().await;
            guard.insert(name.clone(), (size, file_lines.len()));
        }
        if !(unfiltered && to_skip > 0) {
            stored_events = stored_events.saturating_add(file_lines.len());
        }
        if descending {
            file_lines.reverse();
        }
        if unfiltered {
            let start = to_skip;
            to_skip = 0;
            let end = start.saturating_add(page_size.saturating_sub(page.len()));
            page.extend(
                file_lines[start..end.min(file_lines.len())]
                    .iter()
                    .map(|line| (*line).to_owned()),
            );
            continue;
        }
        for line in file_lines {
            if !admin_log_matches(line, query) {
                continue;
            }
            total_events = total_events.saturating_add(1);
            if to_skip > 0 {
                to_skip -= 1;
                continue;
            }
            if page.len() < page_size {
                page.push(line.to_owned());
            }
            if page.len() >= page_size && to_skip == 0 {
                break;
            }
        }
    }
    if unfiltered {
        total_events = stored_events;
    }
    (page, stored_events, total_events)
}

async fn load_admin_logs_sorted(
    state: &AppState,
    files: &[String],
    sizes: &[u64],
    query: &AdminLogsQuery,
    offset: usize,
    page_size: usize,
    sort: &str,
    descending: bool,
) -> (Vec<String>, usize, usize) {
    let mut stored_events = 0_usize;
    let mut lines = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let path = state.logs_dir.join(file);
        let Ok(content) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let line_count = content.lines().count();
        stored_events = stored_events.saturating_add(line_count);
        {
            let mut guard = state.log_line_cache.lock().await;
            guard.insert(file.clone(), (sizes[index], line_count));
        }
        lines.extend(
            content
                .lines()
                .filter(|line| admin_log_matches(line, query))
                .map(str::to_owned),
        );
    }
    let total_events = lines.len();
    lines.sort_by(|left, right| {
        let left_key = admin_log_sort_value(left, sort);
        let right_key = admin_log_sort_value(right, sort);
        let order = left_key.cmp(&right_key);
        if descending {
            order.reverse()
        } else {
            order
        }
    });
    let offset = offset.min(total_events);
    let end = offset.saturating_add(page_size).min(total_events);
    (lines[offset..end].to_vec(), stored_events, total_events)
}

async fn admin_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AdminLogsQuery>,
) -> Result<Json<AdminLogsResponse>, StatusCode> {
    let started = Instant::now();
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.view_logs))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let (mut files, sizes, total_bytes) = list_admin_log_files(&state.logs_dir).await;
    let sort = query.sort.as_deref().unwrap_or("timestamp");
    let descending = query.direction.as_deref().unwrap_or("desc") != "asc";
    let offset = query.offset.unwrap_or(0);
    let page_size = query.page_size.unwrap_or(1_000).clamp(1, 5_000);
    let (lines, stored_events, total_events) = if sort == "timestamp" {
        load_admin_logs_by_timestamp(
            &state,
            &files,
            &sizes,
            &query,
            offset,
            page_size,
            descending,
        )
        .await
    } else {
        load_admin_logs_sorted(
            &state,
            &files,
            &sizes,
            &query,
            offset,
            page_size,
            sort,
            descending,
        )
        .await
    };
    files.reverse();
    let mut actors = read_users(&state.users_path)
        .await
        .into_iter()
        .map(|user| user.name)
        .collect::<Vec<_>>();
    actors.sort_by_key(|name| name.to_ascii_lowercase());
    tracing::info!(
        event = "admin_logs_loaded",
        duration_ms = started.elapsed().as_millis() as u64,
        stored_events,
        matching_events = total_events,
        returned_events = lines.len(),
        total_bytes,
        sort,
        descending,
        "Admin log query completed"
    );
    Ok(Json(AdminLogsResponse {
        files,
        lines,
        actors,
        total_events,
        stored_events,
        total_bytes,
    }))
}

// The metrics page needs the latest performance events, not a count of every
// matching line in every retained log. Read from the end of each daily file so
// the request stops as soon as its 5,000-event window is full.
fn is_client_performance_line(line: &str) -> bool {
    line.split_whitespace()
        .any(|part| part == "event=\"client_performance\"")
}

fn latest_performance_lines(logs_dir: &Path, files: &[String], limit: usize) -> Vec<String> {
    use std::io::{Read, Seek};

    let mut lines = Vec::with_capacity(limit);
    let mut chunk = vec![0_u8; 64 * 1024];
    for name in files.iter().rev().filter(|name| name.starts_with("tms.")) {
        let Ok(mut file) = std::fs::File::open(logs_dir.join(name)) else {
            continue;
        };
        let Ok(mut remaining) = file.metadata().map(|metadata| metadata.len()) else {
            continue;
        };
        let mut reversed_line = Vec::new();
        while remaining > 0 && lines.len() < limit {
            let size = remaining.min(chunk.len() as u64) as usize;
            remaining -= size as u64;
            if file.seek(std::io::SeekFrom::Start(remaining)).is_err()
                || file.read_exact(&mut chunk[..size]).is_err()
            {
                break;
            }
            for &byte in chunk[..size].iter().rev() {
                if byte == b'\n' {
                    if !reversed_line.is_empty() {
                        reversed_line.reverse();
                        let line = String::from_utf8_lossy(&reversed_line);
                        if is_client_performance_line(&line) {
                            lines.push(line.into_owned());
                        }
                        reversed_line.clear();
                    }
                    if lines.len() >= limit {
                        break;
                    }
                } else {
                    reversed_line.push(byte);
                }
            }
        }
        if remaining == 0 && !reversed_line.is_empty() && lines.len() < limit {
            reversed_line.reverse();
            let line = String::from_utf8_lossy(&reversed_line);
            if is_client_performance_line(&line) {
                lines.push(line.into_owned());
            }
        }
        if lines.len() >= limit {
            break;
        }
    }
    lines
}

async fn admin_performance(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminPerformanceResponse>, StatusCode> {
    let started = Instant::now();
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.view_logs))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let (files, _, _) = list_admin_log_files(&state.logs_dir).await;
    let logs_dir = state.logs_dir.clone();
    let lines = tokio::task::spawn_blocking(move || latest_performance_lines(&logs_dir, &files, 5_000))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tracing::info!(
        event = "admin_performance_loaded",
        duration_ms = started.elapsed().as_millis() as u64,
        returned_events = lines.len(),
        "Admin performance metrics loaded"
    );
    Ok(Json(AdminPerformanceResponse { lines }))
}

async fn clear_admin_performance(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ClearPerformanceResponse>, StatusCode> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !user.is_admin {
        return Err(StatusCode::FORBIDDEN);
    }

    let (files, _, _) = list_admin_log_files(&state.logs_dir).await;
    let mut removed = 0;
    for file in files.iter().filter(|file| file.starts_with("tms.")) {
        let path = state.logs_dir.join(file);
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let retained = content
            .lines()
            .filter(|line| !is_client_performance_line(line))
            .collect::<Vec<_>>();
        let removed_from_file = content.lines().count() - retained.len();
        if removed_from_file == 0 {
            continue;
        }
        let mut replacement = retained.join("\n");
        if !replacement.is_empty() {
            replacement.push('\n');
        }
        tokio::fs::write(path, replacement)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        removed += removed_from_file;
    }
    state.log_line_cache.lock().await.clear();
    tracing::warn!(actor = %user.name, removed, "Administrator cleared client performance metrics");
    Ok(Json(ClearPerformanceResponse { removed }))
}

fn admin_log_matches(line: &str, query: &AdminLogsQuery) -> bool {
    let token = |key: &str| {
        line.split_whitespace()
            .find_map(|part| part.strip_prefix(&format!("{key}=")))
            .unwrap_or_default()
    };
    if let Some(level) = query.level.as_deref().filter(|value| *value != "all") {
        let expected = match level {
            "Error" => "ERROR",
            "Warning" => "WARN",
            "Information" => "INFO",
            "Debug" => "DEBUG",
            _ => level,
        };
        let actual = line
            .split_whitespace()
            .find(|part| matches!(*part, "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR"))
            .unwrap_or_default();
        if expected != actual && !(expected == "DEBUG" && actual == "TRACE") {
            return false;
        }
    }
    let actor = {
        let actor = token("actor");
        if !actor.is_empty() {
            actor
        } else {
            let user = token("user");
            if !user.is_empty() {
                user
            } else {
                token("user_name")
            }
        }
    };
    if let Some(requested) = query.actor.as_deref().filter(|value| *value != "all") {
        if (requested == "Server" && !actor.is_empty())
            || (requested != "Server" && actor != requested)
        {
            return false;
        }
    }
    if let Some(emitter) = query.emitter.as_deref().filter(|value| *value != "all") {
        let actual = if line.contains("client_error") || line.contains("tms_server::performance") {
            "Client"
        } else if actor.is_empty() {
            "Server"
        } else {
            "User action"
        };
        if actual != emitter {
            return false;
        }
    }
    if let Some(kind) = query.kind.as_deref().filter(|value| *value != "all") {
        let raw_kind = {
            let kind = token("kind");
            if !kind.is_empty() {
                kind
            } else {
                token("event")
            }
        }
        .replace('_', " ")
        .to_ascii_lowercase();
        if raw_kind != kind.to_ascii_lowercase() {
            return false;
        }
    }
    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !line
            .to_ascii_lowercase()
            .contains(&search.to_ascii_lowercase())
        {
            return false;
        }
    }
    true
}

fn admin_log_sort_value(line: &str, field: &str) -> String {
    let token = |key: &str| {
        line.split_whitespace()
            .find_map(|part| part.strip_prefix(&format!("{key}=")))
            .unwrap_or_default()
    };
    match field {
        "level" => line
            .split_whitespace()
            .find(|part| matches!(*part, "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR"))
            .unwrap_or_default()
            .to_owned(),
        "emitter" => {
            if token("actor").is_empty()
                && token("user").is_empty()
                && token("user_name").is_empty()
            {
                "Server".to_owned()
            } else {
                "User action".to_owned()
            }
        }
        "actor" => {
            let actor = token("actor");
            if !actor.is_empty() {
                actor.to_owned()
            } else {
                let user = token("user");
                if !user.is_empty() {
                    user.to_owned()
                } else {
                    token("user_name").to_owned()
                }
            }
        }
        "type" => {
            let kind = token("kind");
            if !kind.is_empty() {
                kind.to_owned()
            } else {
                token("event").to_owned()
            }
        }
        "overview" => line.to_owned(),
        _ => line
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_owned(),
    }
}

async fn prune_admin_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AdminLogPruneRequest>,
) -> Result<Json<AdminLogsResponse>, StatusCode> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !user.is_admin {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut files = Vec::new();
    let mut directory = tokio::fs::read_dir(&state.logs_dir)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    while let Ok(Some(entry)) = directory.next_entry().await {
        if entry
            .file_type()
            .await
            .ok()
            .is_some_and(|kind| kind.is_file())
        {
            files.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    files.sort();
    let mut remaining = request.count;
    for file in &files {
        if remaining == 0 {
            break;
        }
        let path = state.logs_dir.join(file);
        let content = tokio::fs::read_to_string(&path).await.unwrap_or_default();
        let lines = content.lines().collect::<Vec<_>>();
        let remove = remaining.min(lines.len());
        remaining -= remove;
        let replacement = lines[remove..].join("\n");
        tokio::fs::write(path, replacement)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    state.log_line_cache.lock().await.clear();
    tracing::warn!(actor = %user.name, requested = request.count, removed = request.count.saturating_sub(remaining), "Administrator pruned oldest log events");
    admin_logs(
        State(state),
        headers,
        Query(AdminLogsQuery {
            sort: Some("timestamp".to_owned()),
            direction: Some("desc".to_owned()),
            offset: Some(0),
            page_size: Some(1_000),
            level: None,
            emitter: None,
            actor: None,
            kind: None,
            search: None,
        }),
    )
    .await
}

#[cfg(windows)]
fn is_pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let success = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        success != 0 && exit_code == 259
    }
}

#[cfg(not(windows))]
fn is_pid_alive(pid: u32) -> bool {
    hidden_sync_command("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

async fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = hidden_async_command("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .status()
            .await;
    }
    #[cfg(not(windows))]
    {
        let _ = hidden_async_command("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .await;
    }
}

async fn admin_processes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminProcessesResponse>, StatusCode> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !has_admin_capability(&user, |permissions| permissions.view_processes) {
        return Err(StatusCode::FORBIDDEN);
    }

    let idle = trickplay_idle_window(&state).await;
    let mut processes = Vec::new();
    for job in reconcile_ytdlp_jobs(&state).await.jobs {
        if job.status != "complete" && job.status != "completed" && job.status != "cancelled" {
            let staging = state.ytdlp_staging_dir.join(&job.id);
            let stats = estimate_playlist_stats(&staging, &job);
            let eta_seconds = stats.as_ref().map(|s| s.eta_seconds);
            let avg_item_seconds = stats.as_ref().map(|s| s.avg_item_seconds);
            let actions = if job.status == "running" {
                vec!["interrupt".to_owned(), "cancel".to_owned()]
            } else if matches!(job.status.as_str(), "failed" | "interrupted") {
                vec!["retry".to_owned(), "cancel".to_owned()]
            } else {
                vec!["cancel".to_owned()]
            };
            processes.push(AdminProcess {
                id: format!("ytdlp:{}", job.id),
                kind: format!("yt-dlp {}", job.mode),
                status: job.status.clone(),
                title: job.title.clone(),
                detail: format!("{} · {}", job.destination_path, job.mode),
                user_name: Some(job.user_name.clone()),
                progress: Some(job.progress.clamp(0.0, 1.0)),
                started_at: job.created_at,
                pid: job.process_pid,
                eta: job.eta.clone(),
                eta_seconds,
                avg_item_seconds,
                current_item: job.current_item.clone(),
                destination_path: Some(job.destination_path.clone()),
                speed: job.speed.clone(),
                error: job.error.clone(),
                paused_until: None,
                transfer: None,
                actions,
            });
        }
    }
    let live_magnets = match tokio::time::timeout(
        Duration::from_secs(4),
        connect_qbittorrent_for_status(&state),
    )
    .await
    {
        Ok(Ok(session)) => match tokio::time::timeout(
            Duration::from_secs(4),
            qbittorrent_torrents(&state, &session),
        )
        .await
        {
            Ok(Ok(torrents)) => torrents
                .into_iter()
                .map(|torrent| (torrent.hash.to_lowercase(), torrent))
                .collect::<HashMap<_, _>>(),
            _ => HashMap::new(),
        },
        _ => HashMap::new(),
    };
    let magnet_owners = read_users(&state.users_path).await;
    for job in read_magnet_jobs(&state.magnet_jobs_path).await.jobs {
        if matches!(job.status.as_str(), "downloading" | "cancel_pending") {
            let speed_cap_enabled = job.uses_speed_cap(&magnet_owners);
            let torrent = live_magnets.get(&job.hash.to_lowercase());
            let stopped = torrent.is_some_and(qbittorrent_torrent_is_stopped);
            let complete = torrent.is_some_and(qbittorrent_torrent_is_complete);
            processes.push(AdminProcess {
                id: format!("magnet:{}", job.hash),
                kind: "magnet download".to_owned(),
                status: if job.status == "cancel_pending" {
                    "cancelling".to_owned()
                } else if complete {
                    "complete".to_owned()
                } else if stopped {
                    "paused".to_owned()
                } else if torrent.is_none() {
                    "status unavailable".to_owned()
                } else {
                    job.status.clone()
                },
                title: torrent
                    .filter(|torrent| !torrent.name.is_empty())
                    .map(|torrent| torrent.name.clone())
                    .unwrap_or_else(|| format!("Magnet {}", &job.hash[..job.hash.len().min(12)])),
                detail: job.destination_path.clone(),
                user_name: Some(job.user_name),
                progress: torrent.map(|torrent| torrent.progress.clamp(0.0, 1.0)),
                started_at: torrent.map_or(job.created_at, |torrent| torrent.added_on),
                pid: None,
                eta: None,
                eta_seconds: None,
                avg_item_seconds: None,
                current_item: None,
                destination_path: Some(job.destination_path),
                speed: None,
                error: if job.status == "cancel_pending" { Some(job.error.clone().unwrap_or_else(|| "Cancellation saved. Waiting for qBittorrent and file cleanup; this job will disappear when cleanup finishes.".to_owned())) } else { torrent.is_none().then(|| "Live torrent status is unavailable; download activity cannot be confirmed.".to_owned()) },
                paused_until: None,
                transfer: torrent.map(|torrent| AdminProcessTransfer {
                    state: torrent.state.clone(),
                    download_speed: torrent.dlspeed,
                    upload_speed: torrent.upspeed,
                    completed_bytes: torrent.completed,
                    total_bytes: torrent.size,
                    remaining_bytes: torrent.amount_left,
                    eta_seconds: torrent.eta,
                    seeds: torrent.num_seeds,
                    peers: torrent.num_leechs,
                }),
                actions: if job.status == "cancel_pending" { vec!["cancel".to_owned()] } else {
                    let mut actions = magnet_work_actions(torrent.is_some(), stopped);
                    if user.is_admin && !complete {
                        actions.insert(1, if speed_cap_enabled { "uncap" } else { "cap" }.to_owned());
                    }
                    actions
                },
            });
        }
    }
    {
        let active = state.active_transcodes.lock().await;
        for (key, transcode) in active.iter() {
            processes.push(AdminProcess {
                id: format!("transcode:{key}"),
                kind: "FFmpeg transcode".to_owned(),
                status: "running".to_owned(),
                title: transcode.video_path.clone(),
                detail: format!(
                    "{} · {} viewer session{}",
                    transcode.quality,
                    transcode.sessions.len(),
                    if transcode.sessions.len() == 1 {
                        ""
                    } else {
                        "s"
                    }
                ),
                progress: None,
                started_at: transcode.started_at,
                user_name: transcode.initiated_by.clone(),
                pid: transcode.child.id(),
                eta: None,
                eta_seconds: None,
                avg_item_seconds: None,
                current_item: None,
                destination_path: None,
                speed: None,
                error: None,
                paused_until: None,
                transfer: None,
                actions: vec!["kill".to_owned()],
            });
        }
    }

    for (library, thumbnails) in state.active_thumbnail_libraries.lock().await.iter() {
        let is_running = thumbnails.current_file.is_some();
        let is_paused = thumbnails
            .paused_until
            .is_some_and(|until| until > unix_now());
        let progress = if !thumbnails.inventory_complete {
            0.0
        } else if thumbnails.total_files == 0 {
            1.0
        } else {
            thumbnails.completed_files.min(thumbnails.total_files) as f64
                / thumbnails.total_files as f64
        };
        processes.push(AdminProcess {
            id: format!("thumbnails:{}", library),
            kind: "Grid thumbnail generation".to_owned(),
            status: background_work_status(is_running, is_paused, thumbnails.inventory_complete, idle, false).to_owned(),
            title: thumbnails
                .current_file
                .clone()
                .unwrap_or_else(|| library.clone()),
            detail: if is_paused {
                format!("Library {library} · paused")
            } else if is_running {
                format!("Library {} · active thumbnail generation", library)
            } else {
                format!("Library {} · waiting to generate thumbnails", library)
            },
            progress: Some(progress),
            started_at: thumbnails.started_at,
            user_name: thumbnails.initiated_by.clone(),
            pid: None,
            eta: None,
            eta_seconds: None,
            avg_item_seconds: None,
            current_item: None,
            destination_path: None,
            speed: None,
            error: None,
            paused_until: thumbnails.paused_until,
            transfer: None,
            actions: vec![],
        });
    }

    for (library, browser_media) in state.active_browser_media_libraries.lock().await.iter() {
        let is_running = browser_media.ffmpeg_pid.is_some() || browser_media.current_file.is_some();
        let is_paused = browser_media
            .paused_until
            .is_some_and(|until| until > unix_now());
        let progress = if !browser_media.inventory_complete {
            0.0
        } else if browser_media.total_files == 0 {
            1.0
        } else {
            browser_media.completed_files.min(browser_media.total_files) as f64
                / browser_media.total_files as f64
        };
        processes.push(AdminProcess {
            id: format!("browser-media:{library}"),
            kind: "Browser audio remux".to_owned(),
            status: background_work_status(is_running, is_paused, browser_media.inventory_complete, idle, browser_media.max_speed).to_owned(),
            title: browser_media
                .current_file
                .clone()
                .unwrap_or_else(|| library.clone()),
            detail: if is_paused {
                format!("Library {library} · paused")
            } else if is_running {
                format!(
                    "Library {library} · {} AAC remux",
                    if browser_media.max_speed {
                        "max-speed"
                    } else {
                        "low priority"
                    }
                )
            } else if browser_media.max_speed {
                format!("Library {library} · max speed requested, waiting for the FFmpeg slot")
            } else {
                format!("Library {library} · waiting to remux incompatible audio")
            },
            progress: Some(progress),
            started_at: browser_media.started_at,
            user_name: browser_media.initiated_by.clone(),
            pid: browser_media.ffmpeg_pid,
            eta: None,
            eta_seconds: None,
            avg_item_seconds: None,
            current_item: None,
            destination_path: None,
            speed: None,
            error: None,
            paused_until: browser_media.paused_until,
            transfer: None,
            actions: if is_paused {
                Vec::new()
            } else if browser_media.max_speed {
                vec!["stop".to_owned(), "low".to_owned()]
            } else {
                vec!["stop".to_owned(), "max".to_owned()]
            },
        });
    }

    // Scheduled libraries stay visible, but only a spawned FFmpeg child is
    // running. This lets the queue distinguish real work from idle waiting.
    for (library, trickplay) in state.active_trickplay_libraries.lock().await.iter() {
        let is_running = trickplay.ffmpeg_pid.is_some();
        let is_paused = trickplay
            .paused_until
            .is_some_and(|until| until > unix_now());
        let progress = if !trickplay.inventory_complete {
            0.0
        } else if trickplay.total_videos == 0 {
            1.0
        } else {
            trickplay.completed_videos.min(trickplay.total_videos) as f64
                / trickplay.total_videos as f64
        };
        let eta_seconds = trickplay.current_output_dir.as_ref().and_then(|output_dir| {
            let started_at = trickplay.current_video_started_at?;
            let expected = trickplay.current_expected_frames?;
            trickplay_eta_seconds(output_dir, started_at, expected)
        });
        processes.push(AdminProcess {
            id: format!("trickplay:{library}"),
            kind: "FFmpeg timeline-preview generation".to_owned(),
            status: background_work_status(is_running, is_paused, trickplay.inventory_complete, idle, trickplay.max_speed || !trickplay.waits_for_idle).to_owned(),
            title: trickplay
                .current_video
                .clone()
                .unwrap_or_else(|| library.clone()),
            detail: if is_paused {
                format!("Library {library} · paused")
            } else if is_running {
                format!(
                    "Library {library} · {} thumbnail generation",
                    if trickplay.max_speed {
                        "max-speed"
                    } else {
                        "low priority"
                    }
                )
            } else if trickplay.max_speed {
                format!("Library {library} · max speed requested, waiting for the FFmpeg slot")
            } else {
                format!("Library {library} · waiting for idle time and the FFmpeg slot")
            },
            user_name: trickplay.initiated_by.clone(),
            progress: Some(progress),
            started_at: trickplay.started_at,
            pid: trickplay.ffmpeg_pid,
            eta: None,
            eta_seconds,
            avg_item_seconds: None,
            current_item: None,
            destination_path: None,
            speed: None,
            error: None,
            paused_until: trickplay.paused_until,
            transfer: None,
            actions: if is_paused {
                Vec::new()
            } else if trickplay.max_speed {
                vec!["stop".to_owned(), "low".to_owned()]
            } else {
                vec!["stop".to_owned(), "max".to_owned()]
            },
        });
    }
    for (library, finished) in state.finished_trickplay_libraries.lock().await.iter() {
        processes.push(AdminProcess {
            id: format!("trickplay-finished:{library}"),
            kind: "FFmpeg timeline-preview generation".to_owned(),
            status: if finished.failed_videos > 0 { "finished with errors" } else { "complete" }.to_owned(),
            title: library.clone(),
            detail: format!(
                "Library {library} · {} already cached · {} generated · {} failed · {} total",
                finished.total_videos.saturating_sub(finished.generated_videos + finished.failed_videos),
                finished.generated_videos, finished.failed_videos, finished.total_videos
            ),
            user_name: finished.initiated_by.clone(),
            progress: Some(preview_completion(finished.total_videos, finished.failed_videos)),
            started_at: finished.started_at,
            pid: None,
            eta: None,
            eta_seconds: None,
            avg_item_seconds: None,
            current_item: None,
            destination_path: None,
            speed: None,
            error: None,
            paused_until: None,
            transfer: None,
            actions: if finished.failed_videos > 0 { vec!["retry".to_owned()] } else { Vec::new() },
        });
    }
    {
        let mut active = state.active_playback.lock().await;
        active.retain(|_, playback| playback.started_at.elapsed() < TRICKPLAY_PLAYBACK_GRACE);
        for (id, playback) in active.iter() {
            processes.push(AdminProcess {
                id: format!("playback:{id}"),
                kind: "active playback".to_owned(),
                status: "running".to_owned(),
                title: playback.video_path.clone(),
                detail: "Direct playback activity reported by the player".to_owned(),
                user_name: Some(playback.user_name.clone()),
                progress: None,
                started_at: playback.reported_at,
                pid: None,
                eta: None,
                eta_seconds: None,
                avg_item_seconds: None,
                current_item: None,
                destination_path: None,
                speed: None,
                error: None,
                paused_until: None,
                transfer: None,
                actions: Vec::new(),
            });
        }
    }
    let queue_rank = |status: &str| match status {
        "running" | "downloading" => 0,
        "complete" => 2,
        _ => 1,
    };
    processes.sort_by(|left, right| {
        queue_rank(&left.status)
            .cmp(&queue_rank(&right.status))
            .then_with(|| right.started_at.cmp(&left.started_at))
            .then_with(|| left.kind.cmp(&right.kind))
    });
    Ok(Json(AdminProcessesResponse { processes }))
}

fn magnet_work_actions(has_live_status: bool, stopped: bool) -> Vec<String> {
    vec![
        if !has_live_status || stopped { "resume" } else { "pause" }.to_owned(),
        "cancel".to_owned(),
    ]
}

async fn control_admin_process(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<AdminProcessControlRequest>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    if !has_admin_capability(&user, |permissions| permissions.view_processes) {
        return StatusCode::FORBIDDEN;
    }
    if let Some(library) = id.strip_prefix("trickplay-finished:") {
        if request.action != "retry" { return StatusCode::BAD_REQUEST; }
        let retryable = state.finished_trickplay_libraries.lock().await
            .get(library).is_some_and(|run| run.failed_videos > 0);
        if !retryable { return StatusCode::NOT_FOUND; }
        schedule_trickplay_library(state.clone(), library.to_owned(), TrickplayRun::Manual, Some(user.name.clone()));
        return StatusCode::ACCEPTED;
    }
    if let Some(key) = id.strip_prefix("transcode:") {
        if request.action != "kill" {
            return StatusCode::BAD_REQUEST;
        }
        let Some(mut transcode) = state.active_transcodes.lock().await.remove(key) else {
            return StatusCode::NOT_FOUND;
        };
        let pid = transcode.child.id();
        let _ = transcode.child.start_kill();
        let _ = transcode.child.wait().await;
        let _ = tokio::fs::remove_dir_all(&transcode.directory).await;
        tracing::warn!(transcode_key = %key, pid = ?pid, video_path = %transcode.video_path, initiated_by = ?transcode.initiated_by, reason = "admin_kill", "Administrator killed FFmpeg transcode");
        return StatusCode::NO_CONTENT;
    }
    if let Some(library) = id.strip_prefix("trickplay:") {
        if !matches!(request.action.as_str(), "stop" | "max" | "low") {
            return StatusCode::BAD_REQUEST;
        }
        let (pid, paused_until, max_speed) = {
            let mut active = state.active_trickplay_libraries.lock().await;
            let Some(trickplay) = active.get_mut(library) else {
                return StatusCode::NOT_FOUND;
            };
            match request.action.as_str() {
                "stop" => {
                    trickplay.paused_until =
                        Some(unix_now().saturating_add(Duration::from_secs(60 * 60).as_secs()))
                }
                "max" => {
                    trickplay.max_speed = true;
                    trickplay.paused_until = None;
                }
                "low" => trickplay.max_speed = false,
                _ => unreachable!(),
            }
            (
                trickplay.ffmpeg_pid,
                trickplay.paused_until,
                trickplay.max_speed,
            )
        };
        if request.action == "stop" {
            if let Some(pid) = pid {
                let _ = hidden_async_command("taskkill.exe")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .output()
                    .await;
            }
            tracing::warn!(library, pid = ?pid, paused_until = ?paused_until, reason = "admin_stop", "Administrator paused timeline-preview generation for one hour");
        } else {
            tracing::info!(
                library,
                max_speed,
                reason = "admin_speed",
                "Administrator changed timeline-preview generation speed"
            );
        }
        state.trickplay_control_notify.notify_waiters();
        return StatusCode::ACCEPTED;
    }
    if let Some(library) = id.strip_prefix("browser-media:") {
        if !matches!(request.action.as_str(), "stop" | "max" | "low") {
            return StatusCode::BAD_REQUEST;
        }
        let (pid, paused_until, max_speed) = {
            let mut active = state.active_browser_media_libraries.lock().await;
            let Some(browser_media) = active.get_mut(library) else {
                return StatusCode::NOT_FOUND;
            };
            match request.action.as_str() {
                "stop" => {
                    browser_media.paused_until =
                        Some(unix_now().saturating_add(Duration::from_secs(60 * 60).as_secs()))
                }
                "max" => {
                    browser_media.max_speed = true;
                    browser_media.paused_until = None;
                }
                "low" => browser_media.max_speed = false,
                _ => unreachable!(),
            }
            (
                browser_media.ffmpeg_pid,
                browser_media.paused_until,
                browser_media.max_speed,
            )
        };
        if request.action == "stop" {
            if let Some(pid) = pid {
                let _ = hidden_async_command("taskkill.exe")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .output()
                    .await;
            }
            tracing::warn!(library, pid = ?pid, paused_until = ?paused_until, reason = "admin_stop", "Administrator paused browser audio remux for one hour");
        } else {
            tracing::info!(
                library,
                max_speed,
                reason = "admin_speed",
                "Administrator changed browser audio remux speed"
            );
        }
        state.browser_media_control_notify.notify_waiters();
        return StatusCode::ACCEPTED;
    }
    if let Some(job_id) = id.strip_prefix("ytdlp:") {
        let action = match request.action.as_str() {
            "kill" | "cancel" => "cancel",
            "interrupt" => "interrupt",
            "retry" => "retry",
            _ => return StatusCode::BAD_REQUEST,
        };
        let (status, _) = match control_ytdlp_download(
            State(state),
            headers,
            AxumPath(job_id.to_owned()),
            Json(YtDlpControlRequest {
                action: action.to_owned(),
            }),
        )
        .await
        {
            Ok(Json(_)) => (StatusCode::ACCEPTED, ()),
            Err((status, _)) => (status, ()),
        };
        return status;
    }
    if let Some(hash) = id.strip_prefix("magnet:") {
        let action = match request.action.as_str() {
            "pause" => "pause",
            "resume" => "resume",
            "kill" | "cancel" => "cancel",
            _ => return StatusCode::BAD_REQUEST,
        };
        let (status, _) = control_magnet_download(
            State(state),
            headers,
            Json(MagnetControlRequest {
                hash: hash.to_owned(),
                action: action.to_owned(),
            }),
        )
        .await;
        return status;
    }
    StatusCode::BAD_REQUEST
}

async fn report_client_error(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(report): Json<ClientErrorReport>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let message = truncate_log_value(&report.message, 4_000);
    if message.is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    tracing::error!(
        target: "tms_server::client_error",
        user = %user.name,
        user_id = user.id,
        kind = %truncate_log_value(&report.kind, 120),
        route = %truncate_log_value(&report.route, 1_000),
        source = %truncate_log_value(&report.source, 1_000),
        line = report.line,
        column = report.column,
        user_agent = %truncate_log_value(&report.user_agent, 1_000),
        stack = %truncate_log_value(&report.stack, 8_000),
        "Client error: {message}"
    );
    StatusCode::NO_CONTENT
}

async fn report_client_performance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(report): Json<ClientPerformanceReport>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let event = truncate_log_value(report.event.trim(), 120);
    if event.is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    tracing::info!(
        target: "tms_server::performance",
        event = "client_performance",
        phase = %event,
        duration_ms = report.duration_ms,
        route = %truncate_log_value(&report.route, 1_000),
        user = %user.name,
        user_id = user.id,
        details = %truncate_log_value(&report.details.to_string(), 4_000),
        "Browser performance measurement"
    );
    StatusCode::NO_CONTENT
}

fn truncate_log_value(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

async fn admin_users(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<
    (
        [(axum::http::header::HeaderName, HeaderValue); 1],
        Json<Vec<AdminUser>>,
    ),
    StatusCode,
> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| {
            has_admin_capability(&user, |permissions| {
                permissions.view_users
                    || permissions.create_users
                    || permissions.edit_users
                    || permissions.delete_users
                    || permissions.manage_libraries
                    || permissions.manage_downloads
            })
        })
    {
        return Err(StatusCode::FORBIDDEN);
    }
    // Storage reconciliation stats every allocated media file and can take
    // seconds on an external/NAS library. It already runs during maintenance
    // and storage-changing operations; listing accounts should only read the
    // latest persisted ledger snapshot.
    let ledger = read_storage_ledger(&state.storage_path).await;
    let sessions = read_sessions(&state.sessions_path).await;
    Ok((
        [(
            CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=60"),
        )],
        Json(
            read_users(&state.users_path)
                .await
                .iter()
                .map(|user| {
                    AdminUser::from_user(
                        user,
                        &ledger,
                        sessions
                            .iter()
                            .filter(|session| session.user_id == user.id)
                            .map(|session| session.last_active_at.max(session.created_at))
                            .max(),
                    )
                })
                .collect(),
        ),
    ))
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn device_name(user_agent: &str) -> String {
    let agent = user_agent.to_ascii_lowercase();
    if agent.contains("iphone") || agent.contains("ipad") {
        "Apple mobile device".to_owned()
    } else if agent.contains("android") {
        "Android device".to_owned()
    } else if agent.contains("windows") {
        "Windows device".to_owned()
    } else if agent.contains("macintosh") || agent.contains("mac os") {
        "Mac".to_owned()
    } else if agent.contains("linux") {
        "Linux device".to_owned()
    } else {
        "Browser device".to_owned()
    }
}

fn session_client_details(headers: &HeaderMap) -> (String, String) {
    let user_agent = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .chars()
        .take(1_000)
        .collect();
    let ip_address = headers
        .get("x-forwarded-for")
        .or_else(|| headers.get("x-real-ip"))
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(',')
        .next()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(128)
        .collect();
    (user_agent, ip_address)
}

fn can_manage_user_sessions(actor: &StoredUser, target: &StoredUser) -> bool {
    has_admin_capability(actor, |permissions| {
        if target.is_admin {
            permissions.logout_admins
        } else {
            permissions.logout_other_users || permissions.logout_admins
        }
    })
}

fn effective_session_expiry(session: &StoredSession) -> u64 {
    let _ = session;
    u64::MAX
}

fn session_public_id(session: &StoredSession) -> String {
    let digest = Sha256::digest(session.token.as_bytes());
    format!("{digest:x}")[..32].to_owned()
}

fn session_has_access_token(session: &StoredSession, token: &str) -> bool {
    session.token == token || (!session.access_token.is_empty() && session.access_token == token)
}

fn session_accepts_access_token(session: &StoredSession, token: &str) -> bool {
    session.token == token || (session.access_token == token
        && !session.access_token.is_empty()
        && session.expires_at > current_unix_timestamp())
}

fn session_user(user: &StoredUser) -> SessionUser {
    SessionUser {
        id: user.id,
        name: user.name.clone(),
        is_admin: user.is_admin,
        admin_permissions: effective_admin_permissions(user),
        password_set: user.password_hash.is_some(),
    }
}

fn auth_session_response(session: &StoredSession, user: &StoredUser) -> AuthSessionResponse {
    AuthSessionResponse {
        token: session.token.clone(),
        refresh_token: session.token.clone(),
        expires_at: effective_session_expiry(session),
        user: session_user(user),
    }
}

async fn authenticated_user(state: &AppState, headers: &HeaderMap) -> Option<StoredUser> {
    let token = bearer_token(headers)?;
    let started = Instant::now();
    let sessions_started = Instant::now();
    let sessions = read_sessions(&state.sessions_path).await;
    let sessions_ms = sessions_started.elapsed().as_millis() as u64;
    let session = sessions
        .iter()
        .find(|session| session_accepts_access_token(session, token))?;
    let users_started = Instant::now();
    let user = read_users(&state.users_path)
        .await
        .into_iter()
        .find(|user| {
            user.id == session.user_id && user.password_version == session.password_version
        });
    let users_ms = users_started.elapsed().as_millis() as u64;
    let total_ms = started.elapsed().as_millis() as u64;
    if total_ms >= 100 {
        tracing::info!(
            target: "tms_server::performance",
            event = "slow_authentication",
            total_ms,
            sessions_ms,
            users_ms,
            session_count = sessions.len(),
            "Authentication storage lookup was slow"
        );
    }
    user
}

async fn record_session_activity(State(state): State<AppState>, headers: HeaderMap) -> StatusCode {
    let Some(token) = bearer_token(&headers) else {
        return StatusCode::UNAUTHORIZED;
    };
    let _guard = state.persistence_lock.lock().await;
    let mut sessions = read_sessions(&state.sessions_path).await;
    let Some(session) = sessions
        .iter_mut()
        .find(|session| session_accepts_access_token(session, token))
    else {
        return StatusCode::UNAUTHORIZED;
    };
    let now = current_unix_timestamp();
    // A heartbeat is sent after normal user requests. Persisting it at most
    // once per 30 seconds keeps "Last active" useful without turning browsing
    // and playback polling into constant session-file writes.
    if session.last_active_at >= now.saturating_sub(30) {
        return StatusCode::NO_CONTENT;
    }
    session.last_active_at = now;
    match write_sessions(&state.sessions_path, &sessions).await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(status) => status,
    }
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let started = Instant::now();
    let name = request.name.trim();
    let requested_device_id = truncate_log_value(request.device_id.trim(), 128);
    let requested_device_name = truncate_log_value(request.device_name.trim(), 160);
    let user = read_users(&state.users_path)
        .await
        .into_iter()
        .find(|user| user.name.eq_ignore_ascii_case(name))
        .ok_or_else(|| {
            tracing::warn!(event = "login_failed", user_name = %name, "Login rejected: unknown account");
            StatusCode::UNAUTHORIZED
        })?;
    let password_ok = match user.password_hash.clone() {
        Some(hash) => tokio::task::spawn_blocking(move || bcrypt::verify(request.password, &hash))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false),
        None => request.password.is_empty(),
    };
    if !password_ok {
        tracing::warn!(event = "login_failed", user_id = user.id, user_name = %user.name, "Login rejected: invalid password");
        return Err(StatusCode::UNAUTHORIZED);
    }
    let (user_agent, ip_address) = session_client_details(&headers);
    let now = current_unix_timestamp();
    let session = StoredSession {
        token: uuid::Uuid::new_v4().to_string(),
        access_token: String::new(),
        expires_at: 0,
        user_id: user.id,
        password_version: user.password_version,
        created_at: now,
        last_active_at: now,
        device_id: requested_device_id,
        device_name: requested_device_name,
        user_agent,
        ip_address,
    };
    let _guard = state.persistence_lock.lock().await;
    let mut sessions = read_sessions(&state.sessions_path).await;
    if !session.device_id.is_empty() {
        sessions.retain(|existing| {
            !(existing.user_id == user.id && existing.device_id == session.device_id)
        });
    }
    sessions.push(session.clone());
    write_sessions(&state.sessions_path, &sessions).await?;
    tracing::info!(event = "login", user_id = user.id, user_name = %user.name, device = %if session.device_name.is_empty() { device_name(&session.user_agent) } else { session.device_name.clone() }, ip_address = %session.ip_address, duration_ms = started.elapsed().as_millis() as u64, "User logged in and received a device session");
    Ok(Json(
        serde_json::to_value(auth_session_response(&session, &user))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    ))
}

async fn setup_status(State(state): State<AppState>) -> Json<SetupStatus> {
    Json(SetupStatus {
        required: read_users(&state.users_path).await.is_empty(),
    })
}

async fn setup_admin(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SetupAdminRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    let name = request.name.trim().to_owned();
    let requested_device_id = truncate_log_value(request.device_id.trim(), 128);
    let requested_device_name = truncate_log_value(request.device_name.trim(), 160);
    if name.is_empty() || name.chars().count() > 80 || request.password.chars().count() > 256 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let password_hash = if request.password.is_empty() {
        None
    } else {
        Some(
            tokio::task::spawn_blocking(move || {
                bcrypt::hash(request.password, bcrypt::DEFAULT_COST)
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        )
    };
    let _guard = state.persistence_lock.lock().await;
    let mut users = read_users(&state.users_path).await;
    if !users.is_empty()
        || users
            .iter()
            .any(|user| user.name.eq_ignore_ascii_case(&name))
    {
        return Err(StatusCode::CONFLICT);
    }
    let user = StoredUser {
        id: 1,
        name,
        password_hash,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        is_admin: true,
        admin_permissions: AdminPermissions::default(),
        password_version: 0,
        avatar: None,
        storage_quota_bytes: None,
    };
    users.push(user.clone());
    write_users(&state.users_path, &users).await?;
    let (user_agent, ip_address) = session_client_details(&headers);
    let now = current_unix_timestamp();
    let session = StoredSession {
        token: uuid::Uuid::new_v4().to_string(),
        access_token: String::new(),
        expires_at: 0,
        user_id: user.id,
        password_version: user.password_version,
        created_at: now,
        last_active_at: now,
        device_id: requested_device_id,
        device_name: requested_device_name,
        user_agent,
        ip_address,
    };
    write_sessions(&state.sessions_path, &[session.clone()]).await?;
    tracing::info!(event = "setup_admin", user_id = user.id, user_name = %user.name, "Initial administrator created and signed in");
    Ok((
        StatusCode::CREATED,
        Json(
            serde_json::to_value(auth_session_response(&session, &user))
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        ),
    ))
}

async fn current_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AuthSessionResponse>, StatusCode> {
    let token = bearer_token(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let _guard = state.persistence_lock.lock().await;
    let mut sessions = read_sessions(&state.sessions_path).await;
    let session = sessions
        .iter_mut()
        .find(|session| session_accepts_access_token(session, token))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let users = read_users(&state.users_path).await;
    let user = users
        .iter()
        .find(|user| {
            user.id == session.user_id && user.password_version == session.password_version
        })
        .ok_or(StatusCode::UNAUTHORIZED)?;
    session.last_active_at = current_unix_timestamp();
    let session_snapshot = session.clone();
    write_sessions(&state.sessions_path, &sessions).await?;
    Ok(Json(auth_session_response(&session_snapshot, user)))
}

async fn refresh_session(
    State(state): State<AppState>,
    Json(request): Json<RefreshSessionRequest>,
) -> Result<Json<AuthSessionResponse>, StatusCode> {
    let refresh_token = request.refresh_token.trim();
    if refresh_token.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _guard = state.persistence_lock.lock().await;
    let mut sessions = read_sessions(&state.sessions_path).await;
    let session = sessions
        .iter_mut()
        .find(|session| session.token == refresh_token)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !session.device_id.is_empty() && session.device_id != request.device_id {
        tracing::warn!(
            event = "session_refresh_rejected",
            user_id = session.user_id,
            "Device identity did not match the remembered session"
        );
        return Err(StatusCode::UNAUTHORIZED);
    }
    let users = read_users(&state.users_path).await;
    let user = users
        .iter()
        .find(|user| {
            user.id == session.user_id && user.password_version == session.password_version
        })
        .ok_or(StatusCode::UNAUTHORIZED)?;
    session.last_active_at = current_unix_timestamp();
    let session_snapshot = session.clone();
    let response = auth_session_response(&session_snapshot, user);
    write_sessions(&state.sessions_path, &sessions).await?;
    tracing::info!(event = "session_restored", user_id = user.id, user_name = %user.name, "Device login restored");
    Ok(Json(response))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> StatusCode {
    let Some(token) = bearer_token(&headers).map(str::to_owned) else {
        return StatusCode::NO_CONTENT;
    };
    let _guard = state.persistence_lock.lock().await;
    let mut sessions = read_sessions(&state.sessions_path).await;
    let user_id = sessions
        .iter()
        .find(|session| session_has_access_token(session, &token))
        .map(|session| session.user_id);
    let user = match user_id {
        Some(user_id) => read_users(&state.users_path)
            .await
            .into_iter()
            .find(|user| user.id == user_id),
        None => None,
    };
    sessions.retain(|session| !session_has_access_token(session, &token));
    if write_sessions(&state.sessions_path, &sessions)
        .await
        .is_ok()
    {
        if let Some(user) = user {
            tracing::info!(event = "logout", user_id = user.id, user_name = %user.name, "User logged out");
        }
        StatusCode::NO_CONTENT
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

async fn profile_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<SessionDevice>>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let mut sessions = read_sessions(&state.sessions_path).await;
    sessions.retain(|session| {
        session.user_id == user.id && session.password_version == user.password_version
    });
    sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    let current_access_token = bearer_token(&headers);
    Ok(Json(
        sessions
            .iter()
            .map(|session| SessionDevice::from_session(session, current_access_token))
            .collect(),
    ))
}

async fn revoke_profile_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(token): AxumPath<String>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let _guard = state.persistence_lock.lock().await;
    let mut sessions = read_sessions(&state.sessions_path).await;
    let before = sessions.len();
    sessions.retain(|session| !(session.user_id == user.id && session_public_id(session) == token));
    if sessions.len() == before {
        return StatusCode::NOT_FOUND;
    }
    match write_sessions(&state.sessions_path, &sessions).await {
        Ok(()) => {
            tracing::info!(event = "session_revoked", user_id = user.id, user_name = %user.name, "User revoked a remembered device");
            StatusCode::NO_CONTENT
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn admin_user_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(user_id): AxumPath<u64>,
) -> Result<Json<Vec<SessionDevice>>, StatusCode> {
    let actor = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let users = read_users(&state.users_path).await;
    let target = users
        .iter()
        .find(|user| user.id == user_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    if !can_manage_user_sessions(&actor, target) {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut sessions = read_sessions(&state.sessions_path).await;
    sessions.retain(|session| {
        session.user_id == target.id && session.password_version == target.password_version
    });
    sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(Json(
        sessions
            .iter()
            .map(|session| SessionDevice::from_session(session, None))
            .collect(),
    ))
}

async fn revoke_admin_user_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((user_id, token)): AxumPath<(u64, String)>,
) -> StatusCode {
    let Some(actor) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let _guard = state.persistence_lock.lock().await;
    let users = read_users(&state.users_path).await;
    let Some(target) = users.iter().find(|user| user.id == user_id) else {
        return StatusCode::NOT_FOUND;
    };
    if !can_manage_user_sessions(&actor, target) {
        return StatusCode::FORBIDDEN;
    }
    let mut sessions = read_sessions(&state.sessions_path).await;
    let before = sessions.len();
    sessions
        .retain(|session| !(session.user_id == target.id && session_public_id(session) == token));
    if sessions.len() == before {
        return StatusCode::NOT_FOUND;
    }
    match write_sessions(&state.sessions_path, &sessions).await {
        Ok(()) => {
            tracing::info!(event = "session_revoked", actor = %actor.name, user_id = target.id, user_name = %target.name, "Administrator revoked remembered device");
            StatusCode::NO_CONTENT
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn profile(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ProfileResponse>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(ProfileResponse {
        avatar: user.avatar,
    }))
}

async fn change_profile_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ProfilePasswordRequest>,
) -> Result<StatusCode, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if request.new_password.chars().count() > 256 || request.new_password.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if let Some(hash) = user.password_hash.clone() {
        let current = request.current_password;
        let valid = tokio::task::spawn_blocking(move || bcrypt::verify(current, &hash))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false);
        if !valid {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    let next_password = request.new_password;
    let hash =
        tokio::task::spawn_blocking(move || bcrypt::hash(next_password, bcrypt::DEFAULT_COST))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _guard = state.persistence_lock.lock().await;
    let mut users = read_users(&state.users_path).await;
    let profile = users
        .iter_mut()
        .find(|candidate| candidate.id == user.id)
        .ok_or(StatusCode::NOT_FOUND)?;
    profile.password_hash = Some(hash);
    profile.password_version = profile.password_version.saturating_add(1);
    write_users(&state.users_path, &users).await?;
    let mut sessions = read_sessions(&state.sessions_path).await;
    sessions.retain(|session| session.user_id != user.id);
    write_sessions(&state.sessions_path, &sessions).await?;
    tracing::info!(event = "password_changed", user_id = user.id, user_name = %user.name, "User changed own password and ended remembered sessions");
    Ok(StatusCode::NO_CONTENT)
}

async fn upload_profile_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<ProfileResponse>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?
    else {
        return Err(StatusCode::BAD_REQUEST);
    };
    if field.name() != Some("avatar") {
        return Err(StatusCode::BAD_REQUEST);
    }
    let filename = field
        .file_name()
        .and_then(|name| Path::new(name).file_name())
        .and_then(|name| name.to_str())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let extension = filename
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    if !["jpg", "jpeg", "png", "webp", "gif", "avif"].contains(&extension.as_str()) {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let bytes = field.bytes().await.map_err(|_| StatusCode::BAD_REQUEST)?;
    if bytes.is_empty() || bytes.len() > 10 * 1024 * 1024 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let saved_name = format!("user-{}-{}.{}", user.id, uuid::Uuid::new_v4(), extension);
    tokio::fs::create_dir_all(&state.profile_avatars_dir)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::write(state.profile_avatars_dir.join(&saved_name), bytes)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _guard = state.persistence_lock.lock().await;
    let mut users = read_users(&state.users_path).await;
    let profile = users
        .iter_mut()
        .find(|candidate| candidate.id == user.id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let previous = profile.avatar.replace(saved_name.clone());
    write_users(&state.users_path, &users).await?;
    if let Some(previous) = previous {
        let _ = tokio::fs::remove_file(state.profile_avatars_dir.join(previous)).await;
    }
    tracing::info!(user_id = user.id, user_name = %user.name, "User updated profile avatar");
    Ok(Json(ProfileResponse {
        avatar: Some(saved_name),
    }))
}

// Windows can briefly deny opens of a file being atomically replaced, even
// when readers allow delete sharing. Keep auth readers out of that window;
// an I/O error here must not be mistaken for a revoked login.
static AUTH_RECORDS_LOCK: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

async fn read_sessions(path: &Path) -> Vec<StoredSession> {
    let _guard = AUTH_RECORDS_LOCK.read().await;
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

async fn write_sessions(path: &Path, sessions: &[StoredSession]) -> Result<(), StatusCode> {
    let _guard = AUTH_RECORDS_LOCK.write().await;
    // Authentication reads without the persistence lock. Heartbeats must never
    // expose a truncated file: a transient empty read becomes a permanent logout.
    write_persisted_json(path, &sessions.to_vec()).await
}

#[cfg(test)]
mod auth_persistence_tests;

mod playback_progress;

async fn playback_activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(activity): Json<PlaybackActivity>,
) -> StatusCode {
    const VALID_EVENTS: [&str; 5] = ["started", "resumed", "paused", "stopped", "completed"];
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    if !VALID_EVENTS.contains(&activity.event.as_str())
        || activity.media_name.trim().is_empty()
        || activity.path.trim().is_empty()
        || !activity.position.is_finite()
        || !activity.duration.is_finite()
        || safe_library_path(&state.library_root, &activity.path).is_err()
    {
        return StatusCode::BAD_REQUEST;
    }
    let activity_key = format!("{}:{}", user.id, activity.path);
    let mut active_playback = state.active_playback.lock().await;
    let playback_session = match activity.event.as_str() {
        "started" | "resumed" => {
            active_playback.insert(
                activity_key,
                ActivePlayback {
                    started_at: Instant::now(),
                    started_position: activity.position.max(0.0),
                    user_name: user.name.clone(),
                    video_path: activity.path.clone(),
                    reported_at: unix_now(),
                },
            );
            None
        }
        "paused" | "stopped" | "completed" => active_playback.remove(&activity_key),
        _ => None,
    };
    drop(active_playback);
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    let user_state = states.users.entry(user.id).or_default();
    playback_progress::record(user_state, &activity, current_unix_timestamp());
    if write_user_states(&state.user_state_path, &states).await != StatusCode::NO_CONTENT {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    tracing::info!(
        target: "tms_server::playback",
        event = %activity.event,
        user = %user.name,
        media = %activity.media_name,
        path = %activity.path,
        position_seconds = activity.position.max(0.0).round() as u64,
        duration_seconds = activity.duration.max(0.0).round() as u64,
        session_seconds = playback_session.as_ref().map(|session| session.started_at.elapsed().as_secs()).unwrap_or(0),
        watched_seconds = playback_session.as_ref().map(|session| (activity.position - session.started_position).max(0.0).round() as u64).unwrap_or(0),
        "Playback activity"
    );
    StatusCode::NO_CONTENT
}

async fn access_activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(activity): Json<AccessActivity>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let path = activity.path.trim().replace('\\', "/");
    if path.is_empty() || safe_library_path(&state.library_root, &path).is_err() {
        return StatusCode::BAD_REQUEST;
    }
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    touch_last_accessed(&mut states, user.id, &path);
    if write_user_states(&state.user_state_path, &states).await != StatusCode::NO_CONTENT {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn file_download_activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(activity): Json<FileDownloadActivity>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let path = activity.path.trim().replace('\\', "/");
    if activity.media_name.trim().is_empty()
        || safe_library_path(&state.library_root, &path).is_err()
    {
        return StatusCode::BAD_REQUEST;
    }
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    touch_last_accessed(&mut states, user.id, &path);
    if write_user_states(&state.user_state_path, &states).await != StatusCode::NO_CONTENT {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    tracing::info!(event = "file_downloaded", user = %user.name, media = %activity.media_name, path = %path, "File download started");
    StatusCode::NO_CONTENT
}

fn create_folder_archive(source: &Path, archive: &Path) -> Result<usize, String> {
    let output = std::fs::File::create(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipWriter::new(output);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut item_count = 0usize;
    for entry in WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| error.to_string())?;
        let name = relative.to_string_lossy().replace('\\', "/");
        if name.is_empty() {
            continue;
        }
        zip.start_file(name, options)
            .map_err(|error| error.to_string())?;
        let mut input = std::fs::File::open(entry.path()).map_err(|error| error.to_string())?;
        std::io::copy(&mut input, &mut zip).map_err(|error| error.to_string())?;
        item_count += 1;
    }
    zip.finish().map_err(|error| error.to_string())?;
    Ok(item_count)
}

async fn download_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<FolderDownloadQuery>,
) -> Result<Json<FolderDownloadResponse>, (StatusCode, Json<Value>)> {
    let user = authenticated_user(&state, &headers).await.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "message": "Sign in to download folders." })),
        )
    })?;
    let path = query.path.trim().replace('\\', "/");
    if !safe_relative_path(&path) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "message": "Choose a valid folder." })),
        ));
    }
    let library_name = path
        .split('/')
        .next()
        .filter(|name| is_library_path(name))
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "message": "Choose a valid library folder." })),
            )
        })?;
    let libraries = read_libraries(&state).await;
    let allowed = libraries.get(library_name).is_some_and(|library| {
        user.is_admin
            || library
                .members
                .iter()
                .any(|member| member.can_view && member.name.eq_ignore_ascii_case(&user.name))
    });
    if !allowed {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "You do not have access to this folder." })),
        ));
    }
    let source = safe_library_path(&state.library_root, &path).map_err(|status| {
        (
            status,
            Json(serde_json::json!({ "message": "Choose a valid folder." })),
        )
    })?;
    if !source.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "message": "The selected folder no longer exists." })),
        ));
    }
    tokio::fs::create_dir_all(&state.folder_downloads_dir)
        .await
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::json!({ "message": "TMS could not prepare the folder download." }),
                ),
            )
        })?;
    let archive_name = format!("{}.zip", uuid::Uuid::new_v4());
    let archive = state.folder_downloads_dir.join(&archive_name);
    let source_for_archive = source.clone();
    let archive_for_task = archive.clone();
    let item_count = tokio::task::spawn_blocking(move || create_folder_archive(&source_for_archive, &archive_for_task))
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "message": "TMS could not create the folder archive." }))))?
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "message": format!("TMS could not create the folder archive: {error}") }))))?;
    let display_name = format!(
        "{}.zip",
        source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("folder")
    );
    let cleanup = archive.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60 * 60)).await;
        let _ = tokio::fs::remove_file(cleanup).await;
    });
    tracing::info!(event = "folder_downloaded", user = %user.name, path = %path, files = item_count, "Folder archive prepared");
    Ok(Json(FolderDownloadResponse {
        url: format!("/folder-downloads/{archive_name}"),
        filename: display_name,
        item_count,
    }))
}

async fn create_admin_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateUserRequest>,
) -> Result<(StatusCode, Json<AdminUser>), StatusCode> {
    let Some(actor) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !has_admin_capability(&actor, |permissions| permissions.create_users) {
        return Err(StatusCode::FORBIDDEN);
    }
    if !actor.is_admin
        && (request.is_admin || request.admin_permissions != AdminPermissions::default())
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let name = request.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 80 || request.password.chars().count() > 256 {
        return Err(StatusCode::BAD_REQUEST);
    }

    let password_hash = if request.password.is_empty() {
        None
    } else {
        Some(
            tokio::task::spawn_blocking(move || {
                bcrypt::hash(request.password, bcrypt::DEFAULT_COST)
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        )
    };

    let _guard = state.persistence_lock.lock().await;
    let mut users = read_users(&state.users_path).await;
    if users
        .iter()
        .any(|user| user.name.eq_ignore_ascii_case(&name))
    {
        return Err(StatusCode::CONFLICT);
    }
    let id = users
        .iter()
        .map(|user| user.id)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let user = StoredUser {
        id,
        name,
        password_hash,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        is_admin: request.is_admin,
        admin_permissions: if request.is_admin {
            AdminPermissions::default()
        } else {
            request.admin_permissions
        },
        password_version: 0,
        avatar: None,
        storage_quota_bytes: if request.is_admin {
            None
        } else {
            request.storage_quota_bytes
        },
    };
    users.push(user.clone());
    write_users(&state.users_path, &users).await?;
    tracing::info!(event = "user_created", actor = %actor.name, user_id = user.id, user_name = %user.name, "User created");
    let ledger = read_storage_ledger(&state.storage_path).await;
    Ok((
        StatusCode::CREATED,
        Json(AdminUser::from_user(&user, &ledger, None)),
    ))
}

async fn update_admin_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(user_id): AxumPath<u64>,
    Json(request): Json<UpdateUserRequest>,
) -> Result<Json<AdminUser>, StatusCode> {
    let Some(actor) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !has_admin_capability(&actor, |permissions| permissions.edit_users) {
        return Err(StatusCode::FORBIDDEN);
    }
    if !actor.is_admin && (request.is_admin.is_some() || request.admin_permissions.is_some()) {
        return Err(StatusCode::FORBIDDEN);
    }
    if request
        .password
        .as_ref()
        .is_some_and(|password| password.chars().count() > 256)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let next_password_hash = if let Some(password) = request.password {
        Some(if password.is_empty() {
            None
        } else {
            Some(
                tokio::task::spawn_blocking(move || bcrypt::hash(password, bcrypt::DEFAULT_COST))
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            )
        })
    } else {
        None
    };
    let _guard = state.persistence_lock.lock().await;
    let mut users = read_users(&state.users_path).await;
    let index = users
        .iter()
        .position(|user| user.id == user_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    if users[index].is_admin && !actor.is_admin {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(is_admin) = request.is_admin {
        users[index].is_admin = is_admin;
    }
    if let Some(admin_permissions) = request.admin_permissions {
        users[index].admin_permissions = admin_permissions;
    }
    if let Some(storage_quota_bytes) = request.storage_quota_bytes {
        users[index].storage_quota_bytes = storage_quota_bytes;
    }
    if users[index].is_admin {
        users[index].storage_quota_bytes = None;
    }
    let password_changed = next_password_hash.is_some();
    if let Some(password_hash) = next_password_hash {
        users[index].password_hash = password_hash;
        users[index].password_version = users[index].password_version.saturating_add(1);
        let mut sessions = read_sessions(&state.sessions_path).await;
        sessions.retain(|session| session.user_id != user_id);
        write_sessions(&state.sessions_path, &sessions).await?;
    }
    if !users.iter().any(|user| user.is_admin) {
        return Err(StatusCode::BAD_REQUEST);
    }
    write_users(&state.users_path, &users).await?;
    let ledger = read_storage_ledger(&state.storage_path).await;
    let last_active_at = read_sessions(&state.sessions_path)
        .await
        .iter()
        .filter(|session| session.user_id == user_id)
        .map(|session| session.last_active_at.max(session.created_at))
        .max();
    let response = AdminUser::from_user(&users[index], &ledger, last_active_at);
    tracing::info!(event = if password_changed { "password_changed_by_admin" } else { "user_updated" }, actor = %actor.name, user_id, user_name = %users[index].name, "User updated");
    Ok(Json(response))
}

async fn delete_admin_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(user_id): AxumPath<u64>,
) -> StatusCode {
    let Some(actor) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    if !has_admin_capability(&actor, |permissions| permissions.delete_users) {
        return StatusCode::FORBIDDEN;
    }
    if actor.id == user_id {
        return StatusCode::BAD_REQUEST;
    }

    let _guard = state.persistence_lock.lock().await;
    let mut users = read_users(&state.users_path).await;
    let Some(index) = users.iter().position(|user| user.id == user_id) else {
        return StatusCode::NOT_FOUND;
    };
    if users[index].is_admin && !actor.is_admin {
        return StatusCode::FORBIDDEN;
    }
    if users[index].is_admin && users.iter().filter(|user| user.is_admin).count() == 1 {
        return StatusCode::BAD_REQUEST;
    }
    let deleted = users.remove(index);

    let mut sessions = read_sessions(&state.sessions_path).await;
    sessions.retain(|session| session.user_id != user_id);
    let mut libraries = read_libraries(&state).await;
    for library in libraries.values_mut() {
        library
            .members
            .retain(|member| !member.name.eq_ignore_ascii_case(&deleted.name));
    }

    if write_sessions(&state.sessions_path, &sessions)
        .await
        .is_err()
        || write_libraries(&state.libraries_path, &libraries).await != StatusCode::NO_CONTENT
        || write_users(&state.users_path, &users).await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    tracing::info!(
        actor = %actor.name,
        user_id = deleted.id,
        user_name = %deleted.name,
        "User deleted and sessions revoked"
    );
    StatusCode::NO_CONTENT
}

async fn read_users(path: &Path) -> Vec<StoredUser> {
    let _guard = AUTH_RECORDS_LOCK.read().await;
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

async fn write_users(path: &Path, users: &[StoredUser]) -> Result<(), StatusCode> {
    let _guard = AUTH_RECORDS_LOCK.write().await;
    // Account updates must preserve the same uninterrupted authentication reads.
    write_persisted_json(path, &users.to_vec()).await
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(windows)]
fn replace_private_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    if !destination.exists() {
        return std::fs::rename(temporary, destination);
    }
    let from = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let to = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_private_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(temporary, destination)
}

// Missing files are normal on first run; damaged or unreadable files are not.
async fn read_persisted_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    match tokio::fs::read(path).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => Some(value),
            Err(error) => {
                tracing::error!(%error, path = %path.display(), "Persisted JSON is corrupt; refusing subsequent overwrites");
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            tracing::error!(%error, path = %path.display(), "Could not read persisted JSON");
            None
        }
    }
}

async fn write_persisted_json<T: Serialize + serde::de::DeserializeOwned>(
    path: &Path,
    value: &T,
) -> Result<(), StatusCode> {
    // Never replace damaged state with defaults returned by legacy callers.
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            serde_json::from_slice::<T>(&bytes).map_err(|error| {
            tracing::error!(%error, path = %path.display(), "Refusing to overwrite corrupt persisted JSON");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        use std::io::Write;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            replace_private_file(&temporary, &path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|error| {
        tracing::error!(%error, "Could not atomically persist JSON");
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

async fn read_storage_ledger(path: &Path) -> StorageLedger {
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

async fn write_storage_ledger(path: &Path, ledger: &StorageLedger) -> Result<(), StatusCode> {
    write_persisted_json(path, ledger).await
}

fn storage_usage(ledger: &StorageLedger, user_id: u64) -> (u64, u64) {
    let used = ledger
        .allocations
        .iter()
        .filter(|allocation| allocation.user_id == user_id)
        .fold(0_u64, |total, allocation| {
            total.saturating_add(allocation.bytes)
        });
    let reserved = ledger
        .reservations
        .iter()
        .filter(|reservation| reservation.user_id == user_id)
        .fold(0_u64, |total, reservation| {
            total.saturating_add(reservation.bytes)
        });
    (used, reserved)
}

fn storage_quota_response(user: &StoredUser, ledger: &StorageLedger) -> StorageQuotaResponse {
    let (used_bytes, reserved_bytes) = storage_usage(ledger, user.id);
    let available_bytes = storage_quota_limit(user)
        .map(|limit| limit.saturating_sub(used_bytes.saturating_add(reserved_bytes)));
    StorageQuotaResponse {
        storage_quota_bytes: storage_quota_limit(user),
        used_bytes,
        reserved_bytes,
        available_bytes,
        unlimited: storage_quota_limit(user).is_none(),
    }
}

fn reserve_storage(
    ledger: &mut StorageLedger,
    user: &StoredUser,
    reservation_id: &str,
    source: &str,
    bytes: u64,
) -> bool {
    reserve_storage_with_override(ledger, user, reservation_id, source, bytes, false)
}

// Only trusted server-side admin request decisions may opt out of quota checks.
// The allocation still belongs to the selected user and counts toward usage.
fn reserve_storage_with_override(
    ledger: &mut StorageLedger,
    user: &StoredUser,
    reservation_id: &str,
    source: &str,
    bytes: u64,
    quota_override: bool,
) -> bool {
    ledger
        .reservations
        .retain(|reservation| reservation.id != reservation_id);
    let (used, reserved) = storage_usage(ledger, user.id);
    if !quota_override && storage_quota_limit(user)
        .is_some_and(|limit| used.saturating_add(reserved).saturating_add(bytes) > limit)
    {
        return false;
    }
    ledger.reservations.push(StorageReservation {
        id: reservation_id.to_owned(),
        user_id: user.id,
        source: source.to_owned(),
        bytes,
        created_at: unix_now(),
    });
    true
}

fn release_storage_reservation(ledger: &mut StorageLedger, reservation_id: &str) {
    ledger
        .reservations
        .retain(|reservation| reservation.id != reservation_id);
}

fn finalize_storage_reservation(
    ledger: &mut StorageLedger,
    reservation_id: &str,
    user_id: u64,
    source: &str,
    job_id: Option<&str>,
    files: &[(String, u64)],
) {
    release_storage_reservation(ledger, reservation_id);
    for (path, bytes) in files {
        ledger.allocations.push(StorageAllocation {
            id: uuid::Uuid::new_v4().to_string(),
            user_id,
            source: source.to_owned(),
            path: path.clone(),
            bytes: *bytes,
            created_at: unix_now(),
            trash_id: None,
            job_id: job_id.map(str::to_owned),
        });
    }
}

fn path_is_within(path: &str, parent: &str) -> bool {
    path == parent || path.starts_with(&format!("{parent}/"))
}

fn rewrite_storage_paths(ledger: &mut StorageLedger, source: &str, destination: &str) {
    for allocation in &mut ledger.allocations {
        if allocation.trash_id.is_some() || !path_is_within(&allocation.path, source) {
            continue;
        }
        allocation.path = if allocation.path == source {
            destination.to_owned()
        } else {
            format!("{destination}{}", &allocation.path[source.len()..])
        };
    }
}

fn mark_storage_trashed(ledger: &mut StorageLedger, original_path: &str, trash_id: &str) {
    for allocation in &mut ledger.allocations {
        if allocation.trash_id.is_none() && path_is_within(&allocation.path, original_path) {
            allocation.trash_id = Some(trash_id.to_owned());
        }
    }
}

fn restore_storage_from_trash(ledger: &mut StorageLedger, trash_id: &str) {
    for allocation in &mut ledger.allocations {
        if allocation.trash_id.as_deref() == Some(trash_id) {
            allocation.trash_id = None;
        }
    }
}

fn release_storage_from_trash(ledger: &mut StorageLedger, trash_id: &str) {
    ledger
        .allocations
        .retain(|allocation| allocation.trash_id.as_deref() != Some(trash_id));
}

async fn reconcile_storage_ledger(state: &AppState, ledger: &mut StorageLedger) {
    let trash_entries = read_trash(state).await;
    let trash_by_id = trash_entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let mut retained = Vec::with_capacity(ledger.allocations.len());
    for mut allocation in ledger.allocations.drain(..) {
        let physical = if let Some(trash_id) = allocation.trash_id.as_deref() {
            let Some(entry) = trash_by_id.get(trash_id) else {
                continue;
            };
            let mut path = trash_storage_path(state, entry);
            if allocation.path != entry.original_path {
                let suffix = allocation
                    .path
                    .strip_prefix(&format!("{}/", entry.original_path))
                    .unwrap_or("");
                path = path.join(suffix);
            }
            path
        } else {
            state.library_root.join(&allocation.path)
        };
        let Ok(metadata) = tokio::fs::metadata(&physical).await else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        allocation.bytes = metadata.len();
        retained.push(allocation);
    }
    ledger.allocations = retained;
}

async fn storage_quota(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StorageQuotaResponse>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let _guard = state.persistence_lock.lock().await;
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    reconcile_storage_ledger(&state, &mut ledger).await;
    write_storage_ledger(&state.storage_path, &ledger).await?;
    Ok(Json(storage_quota_response(&user, &ledger)))
}

fn spawn_storage_maintenance(state: AppState) {
    supervise("storage-maintenance", move || {
        let state = state.clone();
        async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
            loop {
                interval.tick().await;
                let _guard = state.persistence_lock.lock().await;
                let mut trash = read_trash(&state).await;
                let _ = purge_expired_trash(&state, &mut trash).await;
                let mut ledger = read_storage_ledger(&state.storage_path).await;
                reconcile_storage_ledger(&state, &mut ledger).await;
                let _ = write_storage_ledger(&state.storage_path, &ledger).await;
            }
        }
    });
}

async fn release_persisted_reservation(state: &AppState, reservation_id: &str) {
    let _guard = state.persistence_lock.lock().await;
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    release_storage_reservation(&mut ledger, reservation_id);
    let _ = write_storage_ledger(&state.storage_path, &ledger).await;
}

async fn libraries(State(state): State<AppState>) -> Json<BTreeMap<String, LibraryConfig>> {
    let mut libraries = read_libraries(&state).await;
    // Older versions could persist the internal data directory as a library.
    // Do not expose it or make it a deletion target.
    libraries.retain(|path, _| is_library_path(path));
    for library in libraries.values_mut() {
        if !matches!(
            library.content_type.as_str(),
            "mixed" | "movies_tv" | "music" | "files"
        ) {
            library.content_type = "mixed".to_owned();
        }
    }
    if let Ok(mut entries) = tokio::fs::read_dir(&state.library_root).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.file_name().to_string_lossy().into_owned();
            if is_library_path(&path)
                && entry
                    .file_type()
                    .await
                    .ok()
                    .is_some_and(|kind| kind.is_dir() && !kind.is_symlink())
            {
                libraries.entry(path).or_insert_with(|| LibraryConfig {
                    content_type: "mixed".to_owned(),
                    members: default_library_members(),
                    title_folders: BTreeSet::new(),
                    trickplay_enabled: false,
                    folder_structure_static: false,
                    source_path: None,
                    folder_mounts: Vec::new(),
                });
            }
        }
    }
    // Absolute server paths are administrative data. The normal library
    // contract only needs the logical top-level name.
    for library in libraries.values_mut() {
        library.source_path = None;
    }
    Json(libraries)
}

async fn admin_library_locations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<LibraryLocationsResponse>, StatusCode> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_libraries))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let libraries = read_libraries(&state).await;
    let locations = libraries
        .into_iter()
        .flat_map(|(name, config)| {
            let library_name = name.clone();
            let mount_path = state.library_root.join(&library_name);
            let source = config
                .source_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| mount_path.clone());
            let mut entries = vec![LibraryLocationEntry {
                name,
                path: display_absolute_path(&source),
                external: config.source_path.is_some(),
                available: source.is_dir() && mount_path.is_dir(),
                parent_library: None,
                folder_path: None,
            }];
            entries.extend(config.folder_mounts.into_iter().map(|mount| {
                let mount_path = state.library_root.join(&library_name).join(&mount.path);
                LibraryLocationEntry {
                    name: mount
                        .path
                        .rsplit('/')
                        .next()
                        .unwrap_or(&mount.path)
                        .to_owned(),
                    path: mount.source_path.clone(),
                    external: true,
                    available: Path::new(&mount.source_path).is_dir() && mount_path.is_dir(),
                    parent_library: Some(library_name.clone()),
                    folder_path: Some(mount.path),
                }
            }));
            entries
        })
        .collect();
    Ok(Json(LibraryLocationsResponse {
        main_root: display_absolute_path(&state.library_root),
        main_root_available: state.library_root.is_dir(),
        locations,
    }))
}

fn browser_is_localhost(headers: &HeaderMap) -> bool {
    let origin = headers
        .get("origin")
        .or_else(|| headers.get("referer"))
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if origin.is_empty() {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "[::1]"
}

async fn pick_library_location_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<PickFolderResponse>, (StatusCode, String)> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_libraries))
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Library management permission is required.".to_owned(),
        ));
    }
    if !browser_is_localhost(&headers) {
        return Err((
            StatusCode::FORBIDDEN,
            "The native folder picker is only available on this machine.".to_owned(),
        ));
    }
    #[cfg(windows)]
    {
        let picked = tokio::task::spawn_blocking(pick_library_folder_on_windows)
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "TMS could not open the folder picker.".to_owned(),
                )
            })?;
        let path = picked.map(|selected| {
            let canonical = std::fs::canonicalize(&selected).unwrap_or(selected);
            display_absolute_path(&canonical)
        });
        return Ok(Json(PickFolderResponse { path }));
    }
    #[cfg(not(windows))]
    {
        Err((
            StatusCode::NOT_IMPLEMENTED,
            "The native folder picker is only available on Windows.".to_owned(),
        ))
    }
}

async fn browse_library_locations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BrowseLibraryLocationsQuery>,
) -> Result<Json<FolderBrowserResponse>, (StatusCode, String)> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_libraries))
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Library management permission is required.".to_owned(),
        ));
    }
    let requested = query
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if requested.is_none() {
        return Ok(Json(FolderBrowserResponse {
            current_path: None,
            parent_path: None,
            folders: available_filesystem_roots(),
        }));
    }
    let path = PathBuf::from(requested.unwrap());
    if !path.is_absolute() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose an absolute server folder path.".to_owned(),
        ));
    }
    if !path.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            "That folder or drive is not currently available.".to_owned(),
        ));
    }
    let canonical = std::fs::canonicalize(&path).map_err(|_| {
        (
            StatusCode::FORBIDDEN,
            "TMS cannot access that folder.".to_owned(),
        )
    })?;
    let mut folders = std::fs::read_dir(&canonical)
        .map_err(|_| {
            (
                StatusCode::FORBIDDEN,
                "TMS cannot list that folder.".to_owned(),
            )
        })?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry.metadata().ok()?.is_dir().then(|| FolderBrowserEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: display_absolute_path(&entry.path()),
            })
        })
        .collect::<Vec<_>>();
    folders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(Json(FolderBrowserResponse {
        current_path: Some(display_absolute_path(&canonical)),
        parent_path: canonical.parent().map(display_absolute_path),
        folders,
    }))
}

async fn create_library_location(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateLibraryLocationRequest>,
) -> Result<(StatusCode, Json<LibraryLocationEntry>), (StatusCode, String)> {
    const VALID_TYPES: [&str; 4] = ["mixed", "movies_tv", "music", "files"];
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Sign in to add a library location.".to_owned(),
        ));
    };
    let name = request.name.trim();
    if !has_admin_capability(&user, |permissions| permissions.manage_libraries) {
        return Err((
            StatusCode::FORBIDDEN,
            "Library management permission is required.".to_owned(),
        ));
    }
    let destination_library = request
        .destination_library
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if !is_library_path(name)
        || (destination_library.is_none() && !VALID_TYPES.contains(&request.content_type.as_str()))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose a valid folder name and, when creating a library, a valid type.".to_owned(),
        ));
    }
    let requested_source = PathBuf::from(request.path.trim());
    if !requested_source.is_absolute() || !requested_source.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            "The selected folder is not currently available.".to_owned(),
        ));
    }
    let source = std::fs::canonicalize(&requested_source).map_err(|_| {
        (
            StatusCode::FORBIDDEN,
            "TMS cannot access the selected folder.".to_owned(),
        )
    })?;
    if source.parent().is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose a folder inside the drive, not the entire drive.".to_owned(),
        ));
    }
    // Opening the directory catches common ACL and disconnected-drive failures
    // before a persistent mount is created.
    std::fs::read_dir(&source).map_err(|_| {
        (
            StatusCode::FORBIDDEN,
            "TMS cannot read the selected folder.".to_owned(),
        )
    })?;
    let main_root =
        std::fs::canonicalize(&state.library_root).unwrap_or_else(|_| state.library_root.clone());
    if paths_overlap(&source, &main_root) {
        return Err((
            StatusCode::CONFLICT,
            "Choose a folder outside the main TMS folder.".to_owned(),
        ));
    }

    let _guard = state.persistence_lock.lock().await;
    let mut libraries = read_libraries(&state).await;
    if let Some(destination_library) = destination_library {
        let Some(destination_config) = libraries.get(destination_library) else {
            return Err((
                StatusCode::NOT_FOUND,
                "Choose an existing destination library.".to_owned(),
            ));
        };
        let destination_folder = request
            .destination_folder
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .replace('\\', "/")
            .trim_matches('/')
            .to_owned();
        if !destination_folder.is_empty() && !safe_relative_path(&destination_folder) {
            return Err((
                StatusCode::BAD_REQUEST,
                "Choose a folder inside the selected library.".to_owned(),
            ));
        }
        let mount_relative = if destination_folder.is_empty() {
            name.to_owned()
        } else {
            format!("{destination_folder}/{name}")
        };
        let destination_root = state.library_root.join(destination_library);
        let mount_path = destination_root.join(&mount_relative);
        if !destination_root.is_dir() {
            return Err((
                StatusCode::NOT_FOUND,
                "The selected destination library is not currently available.".to_owned(),
            ));
        }
        if !mount_path.parent().is_some_and(Path::is_dir) {
            return Err((
                StatusCode::NOT_FOUND,
                "Choose an existing folder inside the selected library.".to_owned(),
            ));
        }
        if mount_path.exists()
            || destination_config
                .folder_mounts
                .iter()
                .any(|mount| mount.path.eq_ignore_ascii_case(&mount_relative))
        {
            return Err((
                StatusCode::CONFLICT,
                "A folder or shortcut already exists at that location.".to_owned(),
            ));
        }
        for (existing_name, config) in &libraries {
            let sources = config
                .source_path
                .iter()
                .chain(config.folder_mounts.iter().map(|mount| &mount.source_path));
            for existing_source in sources {
                let comparable = std::fs::canonicalize(existing_source)
                    .unwrap_or_else(|_| PathBuf::from(existing_source));
                if paths_overlap(&source, &comparable) {
                    return Err((
                        StatusCode::CONFLICT,
                        format!(
                            "That folder overlaps the existing {existing_name} library location."
                        ),
                    ));
                }
            }
        }
        create_directory_mount(&source, &mount_path).map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("TMS could not attach that folder: {error}"),
            )
        })?;
        let source_path = display_absolute_path(&source);
        let config = libraries
            .get_mut(destination_library)
            .expect("destination library was checked above");
        config.folder_mounts.push(LibraryFolderMount {
            path: mount_relative.clone(),
            source_path: source_path.clone(),
        });
        let status = write_libraries(&state.libraries_path, &libraries).await;
        if status != StatusCode::NO_CONTENT {
            let _ = remove_directory_mount(&mount_path);
            return Err((status, "TMS could not save the folder shortcut.".to_owned()));
        }
        tracing::info!(user = %user.name, library = %destination_library, folder = %mount_relative, source = %source_path, "External folder shortcut attached inside library");
        // Library listings are cached; show this change on the next load.
        invalidate_library_cache(&state).await;
        return Ok((
            StatusCode::CREATED,
            Json(LibraryLocationEntry {
                name: name.to_owned(),
                path: source_path,
                external: true,
                available: true,
                parent_library: Some(destination_library.to_owned()),
                folder_path: Some(mount_relative),
            }),
        ));
    }
    if libraries
        .keys()
        .any(|existing| existing.eq_ignore_ascii_case(name))
        || state.library_root.join(name).exists()
    {
        return Err((
            StatusCode::CONFLICT,
            "A library with that name already exists.".to_owned(),
        ));
    }
    for (existing_name, config) in &libraries {
        let sources = config
            .source_path
            .iter()
            .chain(config.folder_mounts.iter().map(|mount| &mount.source_path));
        for existing_source in sources {
            let comparable = std::fs::canonicalize(existing_source)
                .unwrap_or_else(|_| PathBuf::from(existing_source));
            if paths_overlap(&source, &comparable) {
                return Err((
                    StatusCode::CONFLICT,
                    format!(
                        "That folder overlaps the existing {existing_name} library. Parent and child folders cannot both be attached."
                    ),
                ));
            }
        }
    }

    let mount_path = state.library_root.join(name);
    create_directory_mount(&source, &mount_path).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("TMS could not attach that folder: {error}"),
        )
    })?;
    let source_path = display_absolute_path(&source);
    libraries.insert(
        name.to_owned(),
        LibraryConfig {
            content_type: request.content_type,
            members: vec![LibraryMember {
                name: user.name.clone(),
                can_view: true,
                can_delete: true,
                can_move: true,
                can_create_folders: true,
                can_upload: true,
                can_download: true,
                can_rename: true,
            }],
            title_folders: BTreeSet::new(),
            trickplay_enabled: false,
            folder_structure_static: false,
            source_path: Some(source_path.clone()),
            folder_mounts: Vec::new(),
        },
    );
    let status = write_libraries(&state.libraries_path, &libraries).await;
    if status != StatusCode::NO_CONTENT {
        let _ = remove_directory_mount(&mount_path);
        return Err((
            status,
            "TMS could not save the new library location.".to_owned(),
        ));
    }
    tracing::info!(user = %user.name, library = name, source = %source_path, "External library location attached");
    // Library listings are cached; show this change on the next load.
    invalidate_library_cache(&state).await;
    Ok((
        StatusCode::CREATED,
        Json(LibraryLocationEntry {
            name: name.to_owned(),
            path: source_path,
            external: true,
            available: true,
            parent_library: None,
            folder_path: None,
        }),
    ))
}

async fn remove_library_folder_mount(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RemoveLibraryFolderMountRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Sign in to remove a folder shortcut.".to_owned(),
        ));
    };
    if !has_admin_capability(&user, |permissions| permissions.manage_libraries) {
        return Err((
            StatusCode::FORBIDDEN,
            "Library management permission is required.".to_owned(),
        ));
    }
    let library = request.library.trim();
    let folder_path = request.folder_path.trim().replace('\\', "/");
    if !is_library_path(library) || !safe_relative_path(&folder_path) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose a valid library folder shortcut.".to_owned(),
        ));
    }
    let _guard = state.persistence_lock.lock().await;
    let mut libraries = read_libraries(&state).await;
    let Some(config) = libraries.get_mut(library) else {
        return Err((
            StatusCode::NOT_FOUND,
            "The destination library no longer exists.".to_owned(),
        ));
    };
    let Some(index) = config
        .folder_mounts
        .iter()
        .position(|mount| mount.path.eq_ignore_ascii_case(&folder_path))
    else {
        return Err((
            StatusCode::NOT_FOUND,
            "That folder shortcut no longer exists.".to_owned(),
        ));
    };
    let mount_path = state.library_root.join(library).join(&folder_path);
    if let Err(error) = remove_directory_mount(&mount_path) {
        return Err((
            StatusCode::CONFLICT,
            format!("TMS could not remove that folder shortcut: {error}"),
        ));
    }
    let mount = config.folder_mounts.remove(index);
    let status = write_libraries(&state.libraries_path, &libraries).await;
    if status != StatusCode::NO_CONTENT {
        if let Err(error) = create_directory_mount(Path::new(&mount.source_path), &mount_path) {
            tracing::error!(library, folder = %folder_path, %error, "Could not restore folder shortcut after saving failed");
        }
        return Err((
            status,
            "TMS could not save the removed folder shortcut.".to_owned(),
        ));
    }
    tracing::info!(user = %user.name, library, folder = %folder_path, "External folder shortcut removed; source folder was preserved");
    // Library listings are cached; show this change on the next load.
    invalidate_library_cache(&state).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_library(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(update): Json<LibraryUpdate>,
) -> impl IntoResponse {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_libraries))
    {
        return StatusCode::FORBIDDEN;
    }
    const VALID_TYPES: [&str; 4] = ["mixed", "movies_tv", "music", "files"];
    if !is_library_path(&update.path)
        || !VALID_TYPES.contains(&update.content_type.as_str())
        || update.members.iter().any(|member| {
            member.name.trim().is_empty()
                || (!member.can_view
                    && (member.can_delete
                        || member.can_move
                        || member.can_create_folders
                        || member.can_upload
                        || member.can_download
                        || member.can_rename))
        })
    {
        return StatusCode::BAD_REQUEST;
    }
    let _guard = state.persistence_lock.lock().await;
    let mut libraries = read_libraries(&state).await;
    let library_path = update.path.clone();
    let title_folders = libraries
        .get(&update.path)
        .map(|library| library.title_folders.clone())
        .unwrap_or_default();
    let source_path = libraries
        .get(&update.path)
        .and_then(|library| library.source_path.clone());
    let folder_mounts = libraries
        .get(&update.path)
        .map(|library| library.folder_mounts.clone())
        .unwrap_or_default();
    libraries.insert(
        update.path,
        LibraryConfig {
            content_type: update.content_type,
            members: update.members,
            title_folders,
            trickplay_enabled: update.trickplay_enabled,
            folder_structure_static: update.folder_structure_static,
            source_path,
            folder_mounts,
        },
    );
    let status = write_libraries(&state.libraries_path, &libraries).await;
    drop(_guard);
    if status == StatusCode::NO_CONTENT {
        // Membership and content type shape the cached library listing.
        invalidate_library_cache(&state).await;
    }
    if status == StatusCode::NO_CONTENT && update.trickplay_enabled {
        schedule_library_preload(state, library_path, TrickplayRun::Automatic, None);
    }
    status
}

async fn run_trickplay_library(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(library): AxumPath<String>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::FORBIDDEN;
    };
    if !has_admin_capability(&user, |permissions| permissions.manage_libraries) {
        return StatusCode::FORBIDDEN;
    }
    if !is_library_path(&library)
        || !read_libraries(&state)
            .await
            .get(&library)
            .is_some_and(|config| config.trickplay_enabled)
    {
        return StatusCode::BAD_REQUEST;
    }
    schedule_library_preload(state, library, TrickplayRun::Manual, Some(user.name));
    StatusCode::ACCEPTED
}

async fn create_library(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateLibraryRequest>,
) -> StatusCode {
    const VALID_TYPES: [&str; 4] = ["mixed", "movies_tv", "music", "files"];
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let name = request.name.trim();
    if !has_admin_capability(&user, |permissions| permissions.manage_libraries)
        || !is_library_path(name)
        || !VALID_TYPES.contains(&request.content_type.as_str())
    {
        return StatusCode::FORBIDDEN;
    }
    let _guard = state.persistence_lock.lock().await;
    let library_path = state.library_root.join(name);
    if library_path.exists() {
        return StatusCode::CONFLICT;
    }
    if tokio::fs::create_dir(&library_path).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let mut libraries = read_libraries(&state).await;
    libraries.insert(
        name.to_owned(),
        LibraryConfig {
            content_type: request.content_type,
            members: vec![LibraryMember {
                name: user.name.clone(),
                can_view: true,
                can_delete: true,
                can_move: true,
                can_create_folders: true,
                can_upload: true,
                can_download: true,
                can_rename: true,
            }],
            trickplay_enabled: false,
            title_folders: BTreeSet::new(),
            folder_structure_static: false,
            source_path: None,
            folder_mounts: Vec::new(),
        },
    );
    let status = write_libraries(&state.libraries_path, &libraries).await;
    if status != StatusCode::NO_CONTENT {
        let _ = tokio::fs::remove_dir(&library_path).await;
        return status;
    }
    tracing::info!(user = %user.name, library = name, "Library created");
    // Library listings are cached; show this change on the next load.
    invalidate_library_cache(&state).await;
    drop(_guard);
    schedule_browser_media_library(state, name.to_owned());
    StatusCode::CREATED
}

async fn delete_library(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    if !has_admin_capability(&user, |permissions| permissions.manage_libraries)
        || !is_library_path(&name)
    {
        return StatusCode::FORBIDDEN;
    }
    let _guard = state.persistence_lock.lock().await;
    let target = state.library_root.join(&name);
    if target.parent() != Some(state.library_root.as_path()) {
        return StatusCode::NOT_FOUND;
    }
    let mut libraries = read_libraries(&state).await;
    let Some(config) = libraries.get(&name).cloned() else {
        return StatusCode::NOT_FOUND;
    };
    if config.source_path.is_some() {
        libraries.remove(&name);
        let status = write_libraries(&state.libraries_path, &libraries).await;
        if status != StatusCode::NO_CONTENT {
            return status;
        }
        if let Err(error) = remove_directory_mount(&target) {
            libraries.insert(name.clone(), config);
            let _ = write_libraries(&state.libraries_path, &libraries).await;
            tracing::error!(user = %user.name, library = %name, %error, "Could not detach external library location");
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
        clear_delete_requests_for_path(&state, &name).await;
        tracing::info!(user = %user.name, library = %name, "External library location detached; source folder was preserved");
        // Library listings are cached; show this change on the next load.
        invalidate_library_cache(&state).await;
        return StatusCode::NO_CONTENT;
    }
    if !target.is_dir() {
        return StatusCode::NOT_FOUND;
    }
    if config.folder_structure_static {
        tracing::warn!(user = %user.name, library = %name, "Library deletion rejected: folder structure is static");
        return StatusCode::FORBIDDEN;
    }
    let Some(entry) = move_to_trash(&state, &target, &name, "folder", user.id, Some(config)).await
    else {
        return StatusCode::INTERNAL_SERVER_ERROR;
    };
    libraries.remove(&name);
    let status = write_libraries(&state.libraries_path, &libraries).await;
    if status != StatusCode::NO_CONTENT {
        let _ = rename_with_retry(trash_storage_path(&state, &entry).as_path(), &target).await;
        return status;
    }
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    mark_storage_trashed(&mut ledger, &name, &entry.id);
    if write_storage_ledger(&state.storage_path, &ledger)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    clear_delete_requests_for_path(&state, &name).await;
    tracing::info!(user = %user.name, library = %name, "Library moved to trash with all contents");
    // Library listings are cached; show this change on the next load.
    invalidate_library_cache(&state).await;
    StatusCode::NO_CONTENT
}

async fn update_title_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(update): Json<TitleFolderUpdate>,
) -> impl IntoResponse {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_libraries))
    {
        return StatusCode::FORBIDDEN;
    }
    let Some((library_path, relative_folder)) = update.path.split_once('/') else {
        return StatusCode::BAD_REQUEST;
    };
    if !is_library_path(library_path) || relative_folder.trim().is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let _guard = state.persistence_lock.lock().await;
    let mut libraries = read_libraries(&state).await;
    let Some(library) = libraries.get_mut(library_path) else {
        return StatusCode::NOT_FOUND;
    };
    if library.content_type != "movies_tv" {
        return StatusCode::BAD_REQUEST;
    }
    if update.title_folder {
        library.title_folders.insert(relative_folder.to_owned());
    } else {
        library.title_folders.remove(relative_folder);
    }
    write_libraries(&state.libraries_path, &libraries).await
}

async fn invalidate_library_cache(state: &AppState) {
    let mut cache = state.library_cache.write().await;
    state
        .library_cache_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    cache.clear();
}

async fn create_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateFolderRequest>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let parent = request.parent_path.trim().replace('\\', "/");
    let name = request.name.trim();
    let Some(library_path) = parent.split('/').next().filter(|path| !path.is_empty()) else {
        return StatusCode::BAD_REQUEST;
    };
    if !is_library_path(library_path)
        || !safe_relative_path(&parent)
        || name.is_empty()
        || name.contains(['/', '\\'])
        || matches!(name, "." | "..")
    {
        return StatusCode::BAD_REQUEST;
    }
    let libraries = read_libraries(&state).await;
    let allowed = user.is_admin
        || libraries.get(library_path).is_some_and(|library| {
            library.members.iter().any(|member| {
                member.name.eq_ignore_ascii_case(&user.name) && member.can_create_folders
            })
        });
    if !allowed
        || libraries
            .get(library_path)
            .is_some_and(|library| library.folder_structure_static)
    {
        return StatusCode::FORBIDDEN;
    }
    let folder_path = state.library_root.join(&parent).join(name);
    match tokio::fs::create_dir(folder_path).await {
        Ok(()) => {
            invalidate_library_cache(&state).await;
            tracing::info!(event = "folder_created", user = %user.name, parent_path = %parent, folder_name = %name, "Folder created");
            StatusCode::CREATED
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => StatusCode::CONFLICT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// Called while persistence_lock is held by the media or library mutation.
async fn clear_delete_requests_for_path(state: &AppState, path: &str) {
    let mut requests = read_persisted_json::<Vec<DeleteRequest>>(&state.delete_requests_path).await.unwrap_or_default();
    requests.retain(|request| request.path != path && !request.path.starts_with(&format!("{path}/")));
    if let Err(status) = write_persisted_json(&state.delete_requests_path, &requests).await {
        tracing::error!(?status, path, "Could not clear delete requests for removed media");
    }
}

async fn request_media_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DeleteMediaRequest>,
) -> Result<Json<DeleteRequest>, StatusCode> {
    let user = authenticated_user(&state, &headers).await.ok_or(StatusCode::UNAUTHORIZED)?;
    let path = request.path.trim().replace('\\', "/");
    let library_path = path.split('/').next().ok_or(StatusCode::BAD_REQUEST)?;
    if !safe_relative_path(&path) || !path.contains('/') || !is_library_path(library_path) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _guard = state.persistence_lock.lock().await;
    let libraries = read_libraries(&state).await;
    let library = libraries.get(library_path).ok_or(StatusCode::NOT_FOUND)?;
    if !user.is_admin && !library.members.iter().any(|member| member.name.eq_ignore_ascii_case(&user.name) && member.can_view) {
        return Err(StatusCode::FORBIDDEN);
    }
    let metadata = tokio::fs::metadata(state.library_root.join(&path)).await.map_err(|_| StatusCode::NOT_FOUND)?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(StatusCode::NOT_FOUND);
    }
    if metadata.is_dir() && library.folder_structure_static {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut requests = read_persisted_json::<Vec<DeleteRequest>>(&state.delete_requests_path).await.unwrap_or_default();
    if let Some(existing) = requests.iter().find(|entry| entry.path == path && entry.requested_by == user.id) {
        return Ok(Json(existing.clone()));
    }
    let entry = DeleteRequest {
        id: uuid::Uuid::new_v4().to_string(),
        path,
        requested_by: user.id,
        requested_by_name: user.name.clone(),
        requested_at: current_unix_timestamp(),
    };
    requests.push(entry.clone());
    write_persisted_json(&state.delete_requests_path, &requests).await?;
    tracing::info!(event = "media_delete_requested", user = %user.name, path = %entry.path, "Media deletion requested");
    Ok(Json(entry))
}

async fn my_delete_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DeleteRequest>>, StatusCode> {
    let user = authenticated_user(&state, &headers).await.ok_or(StatusCode::UNAUTHORIZED)?;
    let _guard = state.persistence_lock.lock().await;
    let requests = read_persisted_json::<Vec<DeleteRequest>>(&state.delete_requests_path).await.unwrap_or_default();
    Ok(Json(requests.into_iter().filter(|entry| entry.requested_by == user.id).collect()))
}

async fn admin_delete_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DeleteRequest>>, StatusCode> {
    let user = authenticated_user(&state, &headers).await.ok_or(StatusCode::UNAUTHORIZED)?;
    if !user.is_admin { return Err(StatusCode::FORBIDDEN); }
    let _guard = state.persistence_lock.lock().await;
    Ok(Json(read_persisted_json(&state.delete_requests_path).await.unwrap_or_default()))
}

async fn resolve_delete_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<ResolveDeleteRequest>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else { return StatusCode::UNAUTHORIZED; };
    if !user.is_admin { return StatusCode::FORBIDDEN; }
    if request.action != "trash" && request.action != "dismiss" { return StatusCode::BAD_REQUEST; }
    let entry = {
        let _guard = state.persistence_lock.lock().await;
        read_persisted_json::<Vec<DeleteRequest>>(&state.delete_requests_path).await.unwrap_or_default()
            .into_iter().find(|entry| entry.id == id)
    };
    let Some(entry) = entry else { return StatusCode::NOT_FOUND; };
    if request.action == "trash" {
        let status = delete_media(State(state.clone()), headers, Json(DeleteMediaRequest { path: entry.path.clone() })).await;
        if status != StatusCode::NO_CONTENT { return status; }
    }
    let _guard = state.persistence_lock.lock().await;
    let mut requests = read_persisted_json::<Vec<DeleteRequest>>(&state.delete_requests_path).await.unwrap_or_default();
    requests.retain(|pending| pending.id != id);
    if write_persisted_json(&state.delete_requests_path, &requests).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    tracing::info!(event = "media_delete_request_resolved", admin = %user.name, path = %entry.path, action = %request.action, "Media deletion request resolved");
    StatusCode::NO_CONTENT
}

async fn delete_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DeleteMediaRequest>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let path = request.path.trim().replace('\\', "/");
    let Some(library_path) = path.split('/').next().filter(|segment| !segment.is_empty()) else {
        return StatusCode::BAD_REQUEST;
    };
    if !safe_relative_path(&path) || !is_library_path(library_path) {
        return StatusCode::BAD_REQUEST;
    }
    let libraries = read_libraries(&state).await;
    let allowed = user.is_admin
        || libraries.get(library_path).is_some_and(|library| {
            library
                .members
                .iter()
                .any(|member| member.name.eq_ignore_ascii_case(&user.name) && member.can_delete)
        });
    if !allowed {
        tracing::warn!(user = %user.name, path, "Delete rejected: permission denied");
        return StatusCode::FORBIDDEN;
    }
    let target = state.library_root.join(&path);
    let metadata = match tokio::fs::metadata(&target).await {
        Ok(metadata) => metadata,
        Err(error) => {
            tracing::warn!(
                user = %user.name,
                requested_path = %path,
                resolved_path = %target.display(),
                %error,
                "Delete target was not found"
            );
            return StatusCode::NOT_FOUND;
        }
    };
    let kind = if metadata.is_dir() {
        "folder"
    } else if metadata.is_file() {
        "file"
    } else {
        return StatusCode::NOT_FOUND;
    };
    if kind == "folder"
        && libraries
            .get(library_path)
            .is_some_and(|library| library.folder_structure_static)
    {
        tracing::warn!(user = %user.name, path, "Delete rejected: folder structure is static");
        return StatusCode::FORBIDDEN;
    }
    let _guard = state.persistence_lock.lock().await;
    // An active TMS HLS transcode keeps its input file open on Windows. Stop
    // only transcodes that read the item being trashed (or a file beneath a
    // folder being trashed), so the recoverable move is not blocked by our own
    // FFmpeg child process.
    stop_transcodes_for_path(&state, &path).await;
    if let Some(entry) = move_to_trash(&state, &target, &path, kind, user.id, None).await {
        let mut ledger = read_storage_ledger(&state.storage_path).await;
        mark_storage_trashed(&mut ledger, &path, &entry.id);
        if write_storage_ledger(&state.storage_path, &ledger)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
        invalidate_library_cache(&state).await;
        clear_delete_requests_for_path(&state, &path).await;
        tracing::info!(event = "media_trashed", user = %user.name, path, "Media moved to trash");
        StatusCode::NO_CONTENT
    } else {
        tracing::error!(user = %user.name, path, "Could not move media to trash");
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

async fn trash(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TrashEntry>>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !user.is_admin {
        return Err(StatusCode::FORBIDDEN);
    }
    let _guard = state.persistence_lock.lock().await;
    let mut entries = read_trash(&state).await;
    purge_expired_trash(&state, &mut entries).await?;
    entries.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    Ok(Json(entries))
}

async fn restore_trash(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    if !user.is_admin {
        return StatusCode::FORBIDDEN;
    }
    let _guard = state.persistence_lock.lock().await;
    let mut entries = read_trash(&state).await;
    if purge_expired_trash(&state, &mut entries).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let Some(index) = entries.iter().position(|entry| entry.id == id) else {
        return StatusCode::NOT_FOUND;
    };
    let entry = entries[index].clone();
    if !user.is_admin && entry.deleted_by != user.id {
        return StatusCode::FORBIDDEN;
    }
    if !safe_relative_path(&entry.original_path) {
        return StatusCode::BAD_REQUEST;
    }
    if entry.library_config.is_some() && !user.is_admin {
        return StatusCode::FORBIDDEN;
    }
    let destination = state.library_root.join(&entry.original_path);
    if destination.exists() {
        return StatusCode::CONFLICT;
    }
    let Some(parent) = destination.parent() else {
        return StatusCode::BAD_REQUEST;
    };
    if tokio::fs::create_dir_all(parent).await.is_err()
        || rename_with_retry(trash_storage_path(&state, &entry).as_path(), &destination)
            .await
            .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    if let Some(config) = entry.library_config.clone() {
        let mut libraries = read_libraries(&state).await;
        if libraries.contains_key(&entry.original_path) {
            let _ =
                rename_with_retry(&destination, trash_storage_path(&state, &entry).as_path()).await;
            return StatusCode::CONFLICT;
        }
        libraries.insert(entry.original_path.clone(), config);
        if write_libraries(&state.libraries_path, &libraries).await != StatusCode::NO_CONTENT {
            let _ =
                rename_with_retry(&destination, trash_storage_path(&state, &entry).as_path()).await;
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
    }
    entries.remove(index);
    if write_trash(&state.trash_path, &entries).await != StatusCode::NO_CONTENT {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    restore_storage_from_trash(&mut ledger, &entry.id);
    if write_storage_ledger(&state.storage_path, &ledger)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    invalidate_library_cache(&state).await;
    tracing::info!(user = %user.name, path = %entry.original_path, "Trash item restored");
    StatusCode::NO_CONTENT
}

async fn permanently_delete_trash(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    if !user.is_admin {
        return StatusCode::FORBIDDEN;
    }
    let _guard = state.persistence_lock.lock().await;
    let mut entries = read_trash(&state).await;
    if purge_expired_trash(&state, &mut entries).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let Some(index) = entries.iter().position(|entry| entry.id == id) else {
        return StatusCode::NOT_FOUND;
    };
    let entry = entries[index].clone();
    if !user.is_admin && entry.deleted_by != user.id {
        return StatusCode::FORBIDDEN;
    }
    remove_trickplay_for_trash_entry(&state, &entry).await;
    remove_browser_media_for_trash_entry(&state, &entry).await;
    if remove_transcodes_for_trash_entry(&state, &entry).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    if remove_trash_storage(&state, &entry).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    entries.remove(index);
    if write_trash(&state.trash_path, &entries).await != StatusCode::NO_CONTENT {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    release_storage_from_trash(&mut ledger, &entry.id);
    match write_storage_ledger(&state.storage_path, &ledger).await {
        Ok(()) => {
            tracing::info!(event = "trash_permanently_deleted", user = %user.name, path = %entry.original_path, kind = %entry.kind, "Trash item permanently deleted");
            StatusCode::NO_CONTENT
        }
        Err(status) => status,
    }
}

async fn empty_trash(State(state): State<AppState>, headers: HeaderMap) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    if !user.is_admin {
        return StatusCode::FORBIDDEN;
    }
    let _guard = state.persistence_lock.lock().await;
    let mut entries = read_trash(&state).await;
    if purge_expired_trash(&state, &mut entries).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let mut retained = Vec::new();
    let mut removed_ids = Vec::new();
    for entry in entries {
        if user.is_admin || entry.deleted_by == user.id {
            remove_trickplay_for_trash_entry(&state, &entry).await;
            remove_browser_media_for_trash_entry(&state, &entry).await;
            if remove_transcodes_for_trash_entry(&state, &entry).await.is_err()
                || remove_trash_storage(&state, &entry).await.is_err() {
                retained.push(entry);
            } else {
                removed_ids.push(entry.id);
            }
        } else {
            retained.push(entry);
        }
    }
    if write_trash(&state.trash_path, &retained).await != StatusCode::NO_CONTENT {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    let removed_count = removed_ids.len();
    for id in removed_ids {
        release_storage_from_trash(&mut ledger, &id);
    }
    match write_storage_ledger(&state.storage_path, &ledger).await {
        Ok(()) => {
            tracing::info!(event = "trash_emptied", user = %user.name, removed_count, "Trash emptied");
            StatusCode::NO_CONTENT
        }
        Err(status) => status,
    }
}

async fn persist_moved_metadata(
    state: &AppState,
    moves: &[(String, String)],
) -> Result<(), StatusCode> {
    let original_states = read_user_states(&state.user_state_path).await;
    let original_covers = read_folder_covers(&state.folder_covers_path).await;
    let original_ledger = read_storage_ledger(&state.storage_path).await;
    let mut states = original_states.clone();
    let mut covers = original_covers.clone();
    let mut ledger = original_ledger.clone();
    for (source, destination) in moves {
        rewrite_all_media_paths(&mut states, source, destination);
        covers = covers
            .into_iter()
            .map(|(path, cover)| (rewrite_path_prefix(&path, source, destination), cover))
            .collect();
        rewrite_storage_paths(&mut ledger, source, destination);
    }
    write_persisted_json(&state.user_state_path, &states).await?;
    if let Err(status) = write_folder_covers(&state.folder_covers_path, &covers).await {
        let _ = write_user_states(&state.user_state_path, &original_states).await;
        return Err(status);
    }
    if let Err(status) = write_storage_ledger(&state.storage_path, &ledger).await {
        let _ = write_user_states(&state.user_state_path, &original_states).await;
        let _ = write_folder_covers(&state.folder_covers_path, &original_covers).await;
        return Err(status);
    }
    Ok(())
}

fn next_available_name(destination_dir: &Path, requested_name: &std::ffi::OsStr) -> PathBuf {
    let requested = Path::new(requested_name);
    let stem = requested.file_stem().and_then(|value| value.to_str()).unwrap_or("item");
    let extension = requested.extension().and_then(|value| value.to_str());
    for index in 1..10_000usize {
        let candidate = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let path = destination_dir.join(candidate);
        if !path.exists() {
            return path;
        }
    }
    destination_dir.join(requested_name)
}

fn next_available_name_excluding(
    destination_dir: &Path,
    requested_name: &std::ffi::OsStr,
    reserved: &HashSet<PathBuf>,
) -> PathBuf {
    let requested = Path::new(requested_name);
    let stem = requested.file_stem().and_then(|value| value.to_str()).unwrap_or("item");
    let extension = requested.extension().and_then(|value| value.to_str());
    for index in 1..10_000usize {
        let candidate = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let path = destination_dir.join(candidate);
        if !path.exists() && !reserved.contains(&path) {
            return path;
        }
    }
    destination_dir.join(requested_name)
}

async fn move_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<MoveMediaRequest>,
) -> Result<Json<MediaMutationResponse>, StatusCode> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let source_path = request.source_path.trim().replace('\\', "/");
    let destination_path = request.destination_path.trim().replace('\\', "/");
    let Some(source_library) = source_path
        .split('/')
        .next()
        .filter(|part| !part.is_empty())
    else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let Some(destination_library) = destination_path
        .split('/')
        .next()
        .filter(|part| !part.is_empty())
    else {
        return Err(StatusCode::BAD_REQUEST);
    };
    if !safe_relative_path(&source_path)
        || !safe_relative_path(&destination_path)
        || !is_library_path(source_library)
        || !is_library_path(destination_library)
        || source_path == source_library
        || destination_path.starts_with(&format!("{source_path}/"))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let libraries = read_libraries(&state).await;
    let can_move_in = |library: &str| {
        user.is_admin
            || libraries.get(library).is_some_and(|config| {
                config
                    .members
                    .iter()
                    .any(|member| member.name.eq_ignore_ascii_case(&user.name) && member.can_move)
            })
    };
    if !can_move_in(source_library)
        || !can_move_in(destination_library)
        || libraries
            .get(source_library)
            .is_some_and(|library| library.folder_structure_static)
        || libraries
            .get(destination_library)
            .is_some_and(|library| library.folder_structure_static)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let source = state.library_root.join(&source_path);
    let destination_dir = state.library_root.join(&destination_path);
    if !(source.is_file() || source.is_dir()) || !destination_dir.is_dir() {
        return Err(StatusCode::NOT_FOUND);
    }
    let Some(name) = source.file_name() else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let mut destination = destination_dir.join(name);
    if destination.exists() {
        if request.conflict_strategy == Some(ConflictStrategy::AutoRename) {
            destination = next_available_name(&destination_dir, name);
        } else {
            return Err(StatusCode::CONFLICT);
        }
    }
    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_owned();
    let destination_item_path = format!(
        "{}/{}",
        destination_path.trim_end_matches('/'),
        destination_name
    );
    let _guard = state.persistence_lock.lock().await;
    match rename_with_retry(&source, &destination).await {
        Ok(()) => {
            if persist_moved_metadata(
                &state,
                &[(source_path.clone(), destination_item_path.clone())],
            )
            .await
            .is_err()
            {
                let _ = rename_with_retry(&destination, &source).await;
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
            invalidate_library_cache(&state).await;
            tracing::info!(event = "media_moved", user = %user.name, source = %source_path, destination = %destination_item_path, "Media moved");
            Ok(Json(MediaMutationResponse {
                path: destination_item_path,
                name: destination_name,
            }))
        }
        Err(error) => {
            tracing::error!(%error, source = %source_path, destination = %destination_path, "Media move failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn move_media_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<BatchMoveMediaRequest>,
) -> Result<Json<BatchMoveMediaResponse>, StatusCode> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if request.source_paths.is_empty() || request.source_paths.len() > 5_000 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let destination_path = request.destination_path.trim().replace('\\', "/");
    let Some(destination_library) = destination_path
        .split('/')
        .next()
        .filter(|part| !part.is_empty())
    else {
        return Err(StatusCode::BAD_REQUEST);
    };
    if !safe_relative_path(&destination_path) || !is_library_path(destination_library) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let libraries = read_libraries(&state).await;
    let can_move_in = |library: &str| {
        user.is_admin
            || libraries.get(library).is_some_and(|config| {
                config
                    .members
                    .iter()
                    .any(|member| member.name.eq_ignore_ascii_case(&user.name) && member.can_move)
            })
    };
    if !can_move_in(destination_library)
        || libraries
            .get(destination_library)
            .is_some_and(|library| library.folder_structure_static)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let destination_dir = state.library_root.join(&destination_path);
    if !destination_dir.is_dir() {
        return Err(StatusCode::NOT_FOUND);
    }

    let mut sources = HashSet::new();
    let mut destinations = HashSet::new();
    let mut moves = Vec::with_capacity(request.source_paths.len());
    for source_path in request.source_paths {
        let source_path = source_path.trim().replace('\\', "/");
        let Some(source_library) = source_path
            .split('/')
            .next()
            .filter(|part| !part.is_empty())
        else {
            return Err(StatusCode::BAD_REQUEST);
        };
        if !safe_relative_path(&source_path)
            || !is_library_path(source_library)
            || source_path == source_library
            || destination_path.starts_with(&format!("{source_path}/"))
            || !can_move_in(source_library)
            || libraries
                .get(source_library)
                .is_some_and(|library| library.folder_structure_static)
            || !sources.insert(source_path.clone())
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        let source = state.library_root.join(&source_path);
        if !(source.is_file() || source.is_dir()) {
            return Err(StatusCode::NOT_FOUND);
        }
        let Some(name) = source.file_name() else {
            return Err(StatusCode::BAD_REQUEST);
        };
        let mut destination = destination_dir.join(name);
        if destination.exists() || destinations.contains(&destination) {
            if request.conflict_strategy == Some(ConflictStrategy::AutoRename) {
                destination = next_available_name_excluding(&destination_dir, name, &destinations);
            } else {
                return Err(StatusCode::CONFLICT);
            }
        }
        destinations.insert(destination.clone());
        let destination_item_path = format!(
            "{}/{}",
            destination_path.trim_end_matches('/'),
            destination
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
        );
        moves.push((source_path, source, destination_item_path, destination));
    }

    let _guard = state.persistence_lock.lock().await;
    let mut completed = 0usize;
    for (source_path, source, _destination_item_path, destination) in &moves {
        if let Err(error) = rename_with_retry(source, destination).await {
            for (_, moved_source, _, moved_destination) in moves[..completed].iter().rev() {
                let _ = rename_with_retry(moved_destination, moved_source).await;
            }
            tracing::error!(%error, source = %source_path, destination = %destination_path, "Batch media move failed");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        completed += 1;
    }
    let path_moves = moves
        .iter()
        .map(|(source, _, destination, _)| (source.clone(), destination.clone()))
        .collect::<Vec<_>>();
    if persist_moved_metadata(&state, &path_moves).await.is_err() {
        for (_, source, _, destination) in moves[..completed].iter().rev() {
            let _ = rename_with_retry(destination, source).await;
        }
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    invalidate_library_cache(&state).await;
    tracing::info!(
        event = "media_batch_moved",
        user = %user.name,
        destination = %destination_path,
        moved_count = moves.len(),
        "Media batch moved"
    );
    Ok(Json(BatchMoveMediaResponse {
        moved_count: moves.len(),
    }))
}

fn rewrite_path_prefix(value: &str, source: &str, destination: &str) -> String {
    if value == source {
        return destination.to_owned();
    }
    value
        .strip_prefix(source)
        .and_then(|suffix| suffix.strip_prefix('/'))
        .map(|suffix| format!("{destination}/{suffix}"))
        .unwrap_or_else(|| value.to_owned())
}

fn swap_exact_path(value: &str, left: &str, right: &str) -> String {
    if value == left {
        right.to_owned()
    } else if value == right {
        left.to_owned()
    } else {
        value.to_owned()
    }
}

fn swap_all_media_paths(states: &mut UserStates, left: &str, right: &str) {
    for user_state in states.users.values_mut() {
        user_state.favorites = user_state
            .favorites
            .iter()
            .map(|path| swap_exact_path(path, left, right))
            .collect();
        user_state.playback = user_state
            .playback
            .iter()
            .map(|(path, playback)| (swap_exact_path(path, left, right), playback.clone()))
            .collect();
        user_state.last_accessed = user_state
            .last_accessed
            .iter()
            .map(|(path, timestamp)| (swap_exact_path(path, left, right), *timestamp))
            .collect();
        user_state.tags = user_state
            .tags
            .iter()
            .map(|(path, tags)| (swap_exact_path(path, left, right), tags.clone()))
            .collect();
        for playlist in user_state.playlists.values_mut() {
            playlist.paths = playlist
                .paths
                .iter()
                .map(|path| swap_exact_path(path, left, right))
                .collect();
        }
    }
}

fn swap_storage_paths(ledger: &mut StorageLedger, left: &str, right: &str) {
    for allocation in &mut ledger.allocations {
        if allocation.trash_id.is_some() {
            continue;
        }
        allocation.path = swap_exact_path(&allocation.path, left, right);
    }
}

async fn rename_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RenameMediaRequest>,
) -> Result<Json<MediaMutationResponse>, StatusCode> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let source_path = request.source_path.trim().replace('\\', "/");
    let requested_name = request.new_name.trim();
    let Some((library_path, _)) = source_path.split_once('/') else {
        return Err(StatusCode::BAD_REQUEST);
    };
    if !safe_relative_path(&source_path)
        || !is_library_path(library_path)
        || requested_name.is_empty()
        || requested_name.chars().count() > 255
        || matches!(requested_name, "." | "..")
        || Path::new(requested_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(requested_name)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _guard = state.persistence_lock.lock().await;
    let original_libraries = read_libraries(&state).await;
    let allowed = user.is_admin
        || original_libraries.get(library_path).is_some_and(|config| {
            config
                .members
                .iter()
                .any(|member| member.name.eq_ignore_ascii_case(&user.name) && member.can_rename)
        });
    if !allowed {
        return Err(StatusCode::FORBIDDEN);
    }
    let source = state.library_root.join(&source_path);
    if !(source.is_file() || source.is_dir()) {
        return Err(StatusCode::NOT_FOUND);
    }
    // File extensions are format identifiers, not part of the user-editable
    // display name. Preserve them even if a client calls this endpoint directly.
    let mut new_name = if source.is_file() {
        match source.extension().and_then(|extension| extension.to_str()) {
            Some(extension) if !extension.is_empty() => {
                let duplicate_extension = Path::new(requested_name)
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case(extension));
                let stem = if duplicate_extension {
                    requested_name
                        .strip_suffix(&format!(".{extension}"))
                        .or_else(|| requested_name.rsplit_once('.').map(|(stem, _)| stem))
                        .unwrap_or(requested_name)
                } else {
                    requested_name
                };
                format!("{stem}.{extension}")
            }
            _ => requested_name.to_owned(),
        }
    } else {
        requested_name.to_owned()
    };
    if new_name.chars().count() > 255 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let Some(parent) = source.parent() else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let mut destination = parent.join(&new_name);
    let mut destination_path = match Path::new(&source_path)
        .parent()
        .and_then(|parent| parent.to_str())
    {
        Some(parent) => format!("{}/{}", parent.replace('\\', "/"), new_name),
        None => return Err(StatusCode::BAD_REQUEST),
    };
    if destination_path == source_path {
        return Ok(Json(MediaMutationResponse {
            path: source_path,
            name: new_name,
        }));
    }
    let source_was_directory = source.is_dir();
    let mut destination_exists = destination.exists();
    if destination_exists && request.conflict_strategy == Some(ConflictStrategy::AutoRename) {
        destination = next_available_name(parent, std::ffi::OsStr::new(&new_name));
        new_name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&new_name)
            .to_owned();
        destination_path = match Path::new(&source_path).parent().and_then(|parent| parent.to_str()) {
            Some(parent) => format!("{}/{}", parent.replace('\\', "/"), new_name),
            None => return Err(StatusCode::BAD_REQUEST),
        };
        destination_exists = false;
    }
    let swapping = destination_exists && source.is_file() && destination.is_file();
    if destination_exists && !swapping {
        return Err(StatusCode::CONFLICT);
    }
    if source_was_directory
        && original_libraries
            .get(library_path)
            .is_some_and(|library| library.folder_structure_static)
    {
        tracing::warn!(user = %user.name, source_path, "Rename rejected: folder structure is static");
        return Err(StatusCode::FORBIDDEN);
    }
    let original_states = read_user_states(&state.user_state_path).await;
    let original_covers = read_folder_covers(&state.folder_covers_path).await;
    let original_ledger = read_storage_ledger(&state.storage_path).await;
    let mut next_libraries = original_libraries.clone();
    if source_was_directory {
        let source_relative = source_path
            .strip_prefix(&format!("{library_path}/"))
            .unwrap_or("");
        let destination_relative = destination_path
            .strip_prefix(&format!("{library_path}/"))
            .unwrap_or("");
        if let Some(library) = next_libraries.get_mut(library_path) {
            library.title_folders = library
                .title_folders
                .iter()
                .map(|path| rewrite_path_prefix(path, source_relative, destination_relative))
                .collect();
        }
    }
    let mut next_states = original_states.clone();
    let mut next_covers = serde_json::Map::new();
    let mut next_ledger = original_ledger.clone();
    if swapping {
        swap_all_media_paths(&mut next_states, &source_path, &destination_path);
        for (path, cover) in &original_covers {
            next_covers.insert(
                swap_exact_path(path, &source_path, &destination_path),
                cover.clone(),
            );
        }
        swap_storage_paths(&mut next_ledger, &source_path, &destination_path);
    } else {
        rewrite_all_media_paths(&mut next_states, &source_path, &destination_path);
        for (path, cover) in &original_covers {
            next_covers.insert(
                rewrite_path_prefix(path, &source_path, &destination_path),
                cover.clone(),
            );
        }
        rewrite_storage_paths(&mut next_ledger, &source_path, &destination_path);
    }
    if swapping {
        let temp_name = format!(".tms-swap-{}-{}", std::process::id(), unix_now());
        let temporary = parent.join(&temp_name);
        if temporary.exists() {
            return Err(StatusCode::CONFLICT);
        }
        if let Err(error) = rename_with_retry(&source, &temporary).await {
            tracing::warn!(user = %user.name, source = %source_path, destination = %destination_path, %error, "Swap rename failed at first step");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        if let Err(error) = rename_with_retry(&destination, &source).await {
            let _ = rename_with_retry(&temporary, &source).await;
            tracing::warn!(user = %user.name, source = %source_path, destination = %destination_path, %error, "Swap rename failed at second step");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        if let Err(error) = rename_with_retry(&temporary, &destination).await {
            let _ = rename_with_retry(&source, &destination).await;
            let _ = rename_with_retry(&temporary, &source).await;
            tracing::warn!(user = %user.name, source = %source_path, destination = %destination_path, %error, "Swap rename failed at third step");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    } else if let Err(error) = rename_with_retry(&source, &destination).await {
        tracing::warn!(
            user = %user.name,
            source = %source_path,
            destination = %destination_path,
            %error,
            "Rename failed"
        );
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let libraries_status = write_libraries(&state.libraries_path, &next_libraries).await;
    let states_status = write_user_states(&state.user_state_path, &next_states).await;
    let covers_status = write_folder_covers(&state.folder_covers_path, &next_covers)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let storage_status = write_storage_ledger(&state.storage_path, &next_ledger).await;
    if libraries_status != StatusCode::NO_CONTENT
        || states_status != StatusCode::NO_CONTENT
        || covers_status != StatusCode::NO_CONTENT
        || storage_status.is_err()
    {
        if swapping {
            let temp_name = format!(".tms-swap-rollback-{}-{}", std::process::id(), unix_now());
            let temporary = parent.join(&temp_name);
            let _ = rename_with_retry(&destination, &temporary).await;
            let _ = rename_with_retry(&source, &destination).await;
            let _ = rename_with_retry(&temporary, &source).await;
        } else {
            let _ = rename_with_retry(&destination, &source).await;
        }
        let _ = write_libraries(&state.libraries_path, &original_libraries).await;
        let _ = write_user_states(&state.user_state_path, &original_states).await;
        let _ = write_folder_covers(&state.folder_covers_path, &original_covers).await;
        let _ = write_storage_ledger(&state.storage_path, &original_ledger).await;
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    {
        let mut durations = state.library_duration_cache.lock().await;
        if source_was_directory {
            let prefix = format!("{source_path}/");
            let to_update: Vec<(String, String, CachedLibraryDuration)> = durations
                .iter()
                .filter(|(path, _)| path.starts_with(&prefix))
                .map(|(path, duration)| {
                    (
                        path.clone(),
                        rewrite_path_prefix(path, &source_path, &destination_path),
                        duration.clone(),
                    )
                })
                .collect();
            for (old_path, new_path, duration) in to_update {
                durations.remove(&old_path);
                durations.insert(new_path, duration);
            }
        } else if swapping {
            let left = durations.remove(&source_path);
            let right = durations.remove(&destination_path);
            if let Some(duration) = right {
                durations.insert(source_path.clone(), duration);
            }
            if let Some(duration) = left {
                durations.insert(destination_path.clone(), duration);
            }
        } else if let Some(duration) = durations.remove(&source_path) {
            durations.insert(destination_path.clone(), duration);
        }
    }
    invalidate_library_cache(&state).await;
    tracing::info!(
        event = if swapping { "media_swapped" } else { "media_renamed" },
        user = %user.name,
        source = %source_path,
        destination = %destination_path,
        "Media renamed"
    );
    Ok(Json(MediaMutationResponse {
        path: destination_path,
        name: new_name,
    }))
}

async fn upload_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        tracing::warn!("Upload rejected: no authenticated user");
        return StatusCode::UNAUTHORIZED;
    };
    let upload_started_at = Instant::now();
    let mut parent_path = None;
    let mut relative_path = None;
    let mut declared_size = None;
    loop {
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(%error, user = %user.name, "Upload rejected: invalid multipart request");
                return StatusCode::BAD_REQUEST;
            }
        };
        let field_name = field.name().map(str::to_owned);
        if field_name.as_deref() == Some("parent_path") {
            parent_path = match field.text().await {
                Ok(path) => Some(path.trim().replace('\\', "/")),
                Err(error) => {
                    tracing::warn!(%error, user = %user.name, "Upload rejected: could not read parent path");
                    return StatusCode::BAD_REQUEST;
                }
            };
            continue;
        }
        if field_name.as_deref() == Some("relative_path") {
            // Plain (non-folder) file pickers, including phone galleries,
            // report an empty relative path; the file name is used instead.
            relative_path = match field.text().await {
                Ok(path) => Some(path.trim().replace('\\', "/")).filter(|path| !path.is_empty()),
                Err(error) => {
                    tracing::warn!(%error, user = %user.name, "Upload rejected: could not read relative path");
                    return StatusCode::BAD_REQUEST;
                }
            };
            continue;
        }
        if field_name.as_deref() == Some("file_size") {
            declared_size = field
                .text()
                .await
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|value| *value > 0);
            if declared_size.is_none() {
                tracing::warn!(user = %user.name, "Upload rejected: missing or invalid file size");
                return StatusCode::BAD_REQUEST;
            }
            continue;
        }
        if field_name.as_deref() != Some("file") {
            continue;
        }
        let Some(parent_path) = parent_path.as_deref() else {
            tracing::warn!(user = %user.name, "Upload rejected: file sent before parent path");
            return StatusCode::BAD_REQUEST;
        };
        let Some(declared_size) = declared_size else {
            tracing::warn!(user = %user.name, parent_path, "Upload rejected: file sent before file size");
            return StatusCode::BAD_REQUEST;
        };
        let Some(filename) = field
            .file_name()
            .and_then(|name| Path::new(name).file_name())
            .and_then(|name| name.to_str())
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
        else {
            tracing::warn!(user = %user.name, parent_path, file_name = ?field.file_name(), "Upload rejected: missing or invalid file name");
            return StatusCode::BAD_REQUEST;
        };
        let relative_path = relative_path.as_deref().unwrap_or(&filename);
        tracing::info!(event = "upload_started", user = %user.name, parent_path, relative_path, request_bytes = ?headers.get("content-length").and_then(|value| value.to_str().ok()), "Upload started");
        let uploads::UploadTarget {
            content_type,
            destination_dir,
            destination,
        } = match uploads::resolve_upload_target(&state, &user, parent_path, relative_path, &filename).await {
            Ok(target) => target,
            Err((status, _)) => return status,
        };
        let Some(destination_parent) = destination.parent() else {
            return StatusCode::BAD_REQUEST;
        };
        if let Err(error) = tokio::fs::create_dir_all(destination_parent).await {
            tracing::error!(%error, destination = %destination.display(), "Upload failed: could not create destination folders");
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
        let reservation_id = format!("upload-{}", uuid::Uuid::new_v4());
        {
            let _guard = state.persistence_lock.lock().await;
            let mut ledger = read_storage_ledger(&state.storage_path).await;
            reconcile_storage_ledger(&state, &mut ledger).await;
            if !reserve_storage(&mut ledger, &user, &reservation_id, "upload", declared_size) {
                tracing::warn!(user = %user.name, parent_path, filename, declared_size, "Upload rejected: storage quota exceeded");
                return StatusCode::INSUFFICIENT_STORAGE;
            }
            if write_storage_ledger(&state.storage_path, &ledger)
                .await
                .is_err()
            {
                return StatusCode::INTERNAL_SERVER_ERROR;
            }
        }
        let temporary =
            destination_parent.join(format!(".{filename}.{}.uploading", uuid::Uuid::new_v4()));
        let mut file = match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
        {
            Ok(file) => file,
            Err(error) => {
                tracing::error!(%error, temporary = %temporary.display(), "Upload failed: could not create temporary file");
                release_persisted_reservation(&state, &reservation_id).await;
                return StatusCode::INTERNAL_SERVER_ERROR;
            }
        };
        let mut received_bytes = 0_u64;
        loop {
            let chunk = match field.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(error) => {
                    tracing::error!(%error, filename, "Upload failed while receiving file data");
                    let _ = tokio::fs::remove_file(&temporary).await;
                    release_persisted_reservation(&state, &reservation_id).await;
                    return StatusCode::INTERNAL_SERVER_ERROR;
                }
            };
            received_bytes = received_bytes.saturating_add(chunk.len() as u64);
            if received_bytes > declared_size {
                tracing::warn!(user = %user.name, parent_path, filename, declared_size, received_bytes, "Upload rejected: file is larger than its declared size");
                drop(file);
                let _ = tokio::fs::remove_file(&temporary).await;
                release_persisted_reservation(&state, &reservation_id).await;
                return StatusCode::INSUFFICIENT_STORAGE;
            }
            if let Err(error) = file.write_all(&chunk).await {
                tracing::error!(%error, temporary = %temporary.display(), "Upload failed while writing file data");
                let _ = tokio::fs::remove_file(&temporary).await;
                release_persisted_reservation(&state, &reservation_id).await;
                return StatusCode::INTERNAL_SERVER_ERROR;
            }
        }
        if received_bytes == 0 {
            tracing::warn!(user = %user.name, parent_path, filename, "Upload rejected: file is empty");
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            release_persisted_reservation(&state, &reservation_id).await;
            return StatusCode::BAD_REQUEST;
        }
        if let Err(error) = file.flush().await {
            tracing::error!(%error, temporary = %temporary.display(), "Upload failed while flushing file");
            let _ = tokio::fs::remove_file(&temporary).await;
            release_persisted_reservation(&state, &reservation_id).await;
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
        if let Err(error) = tokio::fs::rename(&temporary, &destination).await {
            tracing::error!(%error, temporary = %temporary.display(), destination = %destination.display(), "Upload failed while finalizing file");
            let _ = tokio::fs::remove_file(&temporary).await;
            release_persisted_reservation(&state, &reservation_id).await;
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
        let mut final_path = format!("{}/{}", parent_path.trim_end_matches('/'), relative_path);
        if upload_should_organize_movie_tv(&content_type, relative_path) {
            match organize_movie_tv_media(&state, &destination, &destination_dir, &filename, None)
                .await
            {
                Ok(result) => {
                    if let Some((_, organized)) = result.moves.first()
                        && let Ok(relative) = organized.strip_prefix(&state.library_root)
                    {
                        final_path = relative.to_string_lossy().replace('\\', "/");
                    }
                    tracing::info!(user = %user.name, parent_path, relative_path, episodes = result.moved, "Uploaded Movies & TV media organized into the library");
                }
                Err(error) => {
                    tracing::info!(user = %user.name, parent_path, relative_path, error = %error.message, "Uploaded Movies & TV media was left in its selected folder")
                }
            }
        }
        {
            let _guard = state.persistence_lock.lock().await;
            let mut ledger = read_storage_ledger(&state.storage_path).await;
            finalize_storage_reservation(
                &mut ledger,
                &reservation_id,
                user.id,
                "upload",
                None,
                &[(final_path.clone(), received_bytes)],
            );
            let saved = write_storage_ledger(&state.storage_path, &ledger)
                .await
                .is_ok();
            drop(_guard);
            if !saved {
                let _ = tokio::fs::remove_file(state.library_root.join(&final_path)).await;
                release_persisted_reservation(&state, &reservation_id).await;
                return StatusCode::INTERNAL_SERVER_ERROR;
            }
        }
        let upload_elapsed = upload_started_at.elapsed();
        let upload_mebibytes_per_second =
            received_bytes as f64 / (1024.0 * 1024.0) / upload_elapsed.as_secs_f64().max(0.001);
        tracing::info!(
            event = "upload_completed",
            user = %user.name,
            parent_path,
            relative_path,
            uploaded_bytes = received_bytes,
            upload_duration_ms = upload_elapsed.as_millis() as u64,
            upload_mebibytes_per_second,
            "Upload completed"
        );
        invalidate_library_cache(&state).await;
        return StatusCode::CREATED;
    }
    tracing::warn!(user = %user.name, "Upload rejected: no file field supplied");
    StatusCode::BAD_REQUEST
}

fn valid_upload_extension(content_type: &str, extension: &str) -> bool {
    const VIDEO: [&str; 12] = [
        "mp4", "mkv", "webm", "mov", "avi", "m4v", "mpeg", "mpg", "wmv", "3gp", "ts", "m2ts",
    ];
    const AUDIO: [&str; 11] = [
        "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "aiff", "alac",
    ];
    const IMAGE: [&str; 11] = [
        "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif",
    ];
    content_type == "files"
        || VIDEO.contains(&extension)
        || (content_type != "movies_tv"
            && (AUDIO.contains(&extension) || IMAGE.contains(&extension)))
}

fn upload_should_organize_movie_tv(content_type: &str, _relative_path: &str) -> bool {
    content_type == "movies_tv"
}

fn is_library_path(path: &str) -> bool {
    !path.trim().is_empty()
        && !path.contains('/')
        && !path.contains('\\')
        && path != "."
        && path != ".."
        // Application data lives inside the library root but is never media.
        && !path.eq_ignore_ascii_case(".tms-data")
}

fn safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

async fn read_libraries(state: &AppState) -> BTreeMap<String, LibraryConfig> {
    let mut libraries = if let Some(libraries) =
        read_persisted_json::<BTreeMap<String, LibraryConfig>>(&state.libraries_path).await
    {
        libraries
    } else {
        tokio::fs::read(&state.legacy_folder_types_path)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<BTreeMap<String, String>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|(path, content_type)| is_library_path(path) && content_type == "movies_tv")
            .map(|(path, content_type)| (path, default_library_config(content_type)))
            .collect()
    };
    libraries.retain(|name, _| is_library_path(name));
    if let Ok(mut entries) = tokio::fs::read_dir(&state.library_root).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_library_path(&name)
                && entry
                    .file_type()
                    .await
                    .is_ok_and(|file_type| file_type.is_dir() && !file_type.is_symlink())
            {
                libraries
                    .entry(name)
                    .or_insert_with(|| default_library_config("mixed".to_owned()));
            }
        }
    }
    libraries
}

async fn ensure_external_library_mounts(state: &AppState) {
    for (name, config) in read_libraries(state).await {
        if let Some(source_path) = config.source_path {
            let source = PathBuf::from(&source_path);
            let mount_path = state.library_root.join(&name);
            if std::fs::symlink_metadata(&mount_path).is_err() {
                if !source.is_dir() {
                    tracing::warn!(library = %name, source = %source_path, "External library source is offline; its mount will be restored when it is added again or TMS restarts with the source available");
                } else if let Err(error) = create_directory_mount(&source, &mount_path) {
                    tracing::error!(library = %name, source = %source_path, %error, "Could not restore external library mount");
                } else {
                    tracing::info!(library = %name, source = %source_path, "External library mount restored");
                }
            }
        }
        for mount in config.folder_mounts {
            let source = PathBuf::from(&mount.source_path);
            let mount_path = state.library_root.join(&name).join(&mount.path);
            if std::fs::symlink_metadata(&mount_path).is_ok() {
                continue;
            }
            if !source.is_dir() || !mount_path.parent().is_some_and(Path::is_dir) {
                tracing::warn!(library = %name, folder = %mount.path, source = %mount.source_path, "External folder shortcut is unavailable and could not be restored");
            } else if let Err(error) = create_directory_mount(&source, &mount_path) {
                tracing::error!(library = %name, folder = %mount.path, source = %mount.source_path, %error, "Could not restore external folder shortcut");
            } else {
                tracing::info!(library = %name, folder = %mount.path, source = %mount.source_path, "External folder shortcut restored");
            }
        }
    }
}

fn default_library_config(content_type: String) -> LibraryConfig {
    LibraryConfig {
        content_type,
        members: default_library_members(),
        title_folders: BTreeSet::new(),
        trickplay_enabled: false,
        folder_structure_static: false,
        source_path: None,
        folder_mounts: Vec::new(),
    }
}

fn default_library_members() -> Vec<LibraryMember> {
    vec![LibraryMember {
        name: "Tariq".to_owned(),
        can_view: true,
        can_delete: true,
        can_move: true,
        can_create_folders: true,
        can_upload: true,
        can_download: true,
        can_rename: true,
    }]
}

async fn write_libraries(path: &Path, libraries: &BTreeMap<String, LibraryConfig>) -> StatusCode {
    match write_persisted_json(path, libraries).await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(status) => status,
    }
}

const TRASH_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

async fn read_trash(state: &AppState) -> Vec<TrashEntry> {
    read_persisted_json(&state.trash_path)
        .await
        .unwrap_or_default()
}

async fn write_trash(path: &Path, entries: &[TrashEntry]) -> StatusCode {
    match write_persisted_json(path, &entries.to_vec()).await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(status) => status,
    }
}

fn trash_storage_path(state: &AppState, entry: &TrashEntry) -> PathBuf {
    state.trash_dir.join(&entry.stored_name)
}

async fn remove_trash_storage(state: &AppState, entry: &TrashEntry) -> std::io::Result<()> {
    let path = trash_storage_path(state, entry);
    let result = if entry.kind == "folder" {
        tokio::fs::remove_dir_all(path).await
    } else {
        tokio::fs::remove_file(path).await
    };
    if result.is_ok() {
        remove_empty_trash_parents(state, &trash_storage_path(state, entry)).await?;
    }
    result
}

async fn remove_empty_trash_parents(state: &AppState, path: &Path) -> std::io::Result<()> {
    let mut parent = path.parent();
    while let Some(directory) = parent {
        if directory == state.trash_dir {
            break;
        }
        match tokio::fs::remove_dir(directory).await {
            Ok(()) => parent = directory.parent(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                parent = directory.parent()
            }
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

async fn purge_expired_trash(
    state: &AppState,
    entries: &mut Vec<TrashEntry>,
) -> Result<(), StatusCode> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut retained = Vec::new();
    let mut removed_ids = Vec::new();
    for entry in entries.drain(..) {
        if now.saturating_sub(entry.deleted_at) >= TRASH_RETENTION.as_secs() {
            remove_trickplay_for_trash_entry(state, &entry).await;
            let cleanup = match remove_transcodes_for_trash_entry(state, &entry).await {
                Ok(()) => remove_trash_storage(state, &entry).await,
                Err(error) => Err(error),
            };
            if let Err(error) = cleanup {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::error!(%error, id = %entry.id, "Expired trash cleanup failed");
                    retained.push(entry);
                } else {
                    removed_ids.push(entry.id);
                }
            } else {
                removed_ids.push(entry.id);
            }
        } else {
            retained.push(entry);
        }
    }
    *entries = retained;
    if write_trash(&state.trash_path, entries).await != StatusCode::NO_CONTENT {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    if !removed_ids.is_empty() {
        let mut ledger = read_storage_ledger(&state.storage_path).await;
        for id in removed_ids {
            release_storage_from_trash(&mut ledger, &id);
        }
        write_storage_ledger(&state.storage_path, &ledger).await?;
    }
    Ok(())
}

async fn move_to_trash(
    state: &AppState,
    source: &Path,
    original_path: &str,
    kind: &str,
    deleted_by: u64,
    library_config: Option<LibraryConfig>,
) -> Option<TrashEntry> {
    let name = source.file_name()?.to_string_lossy().to_string();
    let metadata = tokio::fs::metadata(source).await.ok()?;
    tokio::fs::create_dir_all(&state.trash_dir).await.ok()?;
    let id = uuid::Uuid::new_v4().to_string();
    let entry = TrashEntry {
        id: id.clone(),
        original_path: original_path.to_owned(),
        // Each deletion gets its own snapshot directory, then retains the
        // library-relative path below it: <trash>/<id>/Library/Show/Season.
        stored_name: trash_stored_name(&id, original_path)?,
        name,
        kind: kind.to_owned(),
        size: metadata.len(),
        deleted_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        deleted_by,
        library_config,
    };
    let destination = trash_storage_path(state, &entry);
    tokio::fs::create_dir_all(destination.parent()?)
        .await
        .ok()?;
    if let Err(error) = rename_with_retry(source, &destination).await {
        tracing::error!(
            source = %source.display(),
            destination = %destination.display(),
            %error,
            "Could not move item to trash"
        );
        return None;
    }
    let mut entries = read_trash(state).await;
    if purge_expired_trash(state, &mut entries).await.is_err() {
        let _ = rename_with_retry(&destination, source).await;
        return None;
    }
    entries.push(entry.clone());
    if write_trash(&state.trash_path, &entries).await != StatusCode::NO_CONTENT {
        let _ = rename_with_retry(&destination, source).await;
        return None;
    }
    Some(entry)
}

fn trash_stored_name(id: &str, original_path: &str) -> Option<String> {
    safe_relative_path(original_path).then(|| format!("{id}/{original_path}"))
}

// Antivirus, Explorer, and download clients can hold a handle briefly after a
// folder changes. Keep the delete request alive long enough for that handle to
// close, instead of making users repeatedly retry the same Trash action.
const RENAME_RETRY_ATTEMPTS: usize = 60;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(500);

fn is_transient_rename_error(error: &std::io::Error) -> bool {
    matches!(error.kind(), std::io::ErrorKind::PermissionDenied)
        || matches!(error.raw_os_error(), Some(32 | 33))
}

/// Windows may temporarily deny a rename while a media reader or downloader is
/// releasing a handle. A trash operation should wait through that brief lock
/// rather than failing immediately and leaving the item in the library.
async fn rename_with_retry(source: &Path, destination: &Path) -> std::io::Result<()> {
    for attempt in 0..RENAME_RETRY_ATTEMPTS {
        match move_path(source, destination).await {
            Ok(()) => return Ok(()),
            Err(error)
                if is_transient_rename_error(&error) && attempt + 1 < RENAME_RETRY_ATTEMPTS =>
            {
                tracing::debug!(
                    source = %source.display(),
                    destination = %destination.display(),
                    attempt = attempt + 1,
                    %error,
                    "Media path is temporarily locked; retrying rename"
                );
                tokio::time::sleep(RENAME_RETRY_DELAY).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("rename retry loop always returns")
}

/// Windows Explorer can move folders that the lower-level rename APIs reject,
/// and it transparently handles a move between two drive volumes. Use its
/// filesystem provider for Trash and library moves on Windows; other platforms
/// use the normal filesystem rename operation.
async fn move_path(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // Files in the same library volume can use a direct rename. Starting
        // PowerShell for every selected track made large music moves look stuck.
        // Keep the Explorer-compatible provider for folders and as a fallback
        // for cross-volume file moves.
        if source.is_file() {
            match native_move(source, destination).await {
                Ok(()) => Ok(()),
                Err(_) => windows_shell_move(source, destination).await,
            }
        } else {
            windows_shell_move(source, destination).await
        }
    }
    #[cfg(not(windows))]
    {
        native_move(source, destination).await
    }
}

async fn native_move(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source = source.to_owned();
    let destination = destination.to_owned();
    tokio::task::spawn_blocking(move || native_move_blocking(&source, &destination))
        .await
        .map_err(std::io::Error::other)?
}

fn native_move_blocking(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
async fn windows_shell_move(source: &Path, destination: &Path) -> std::io::Result<()> {
    let status = hidden_async_command("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Move-Item -LiteralPath $env:TMS_MOVE_SOURCE -Destination $env:TMS_MOVE_DESTINATION -ErrorAction Stop",
        ])
        .env("TMS_MOVE_SOURCE", source)
        .env("TMS_MOVE_DESTINATION", destination)
        .status()
        .await?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("Windows shell move failed"))
    }
}

async fn user_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UserState>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let user_state = read_user_states(&state.user_state_path)
        .await
        .users
        .remove(&user.id)
        .unwrap_or_default();
    Ok(Json(user_state))
}

fn valid_playback_preferences(preferences: &PlaybackPreferences) -> bool {
    preferences.intro_seconds <= 600
        && preferences.ending_seconds <= 600
        && preferences.image_seconds >= 1
        && preferences.image_seconds <= 300
        && matches!(preferences.buffer_size_mb, 100 | 250 | 500)
        && preferences.caption_preferences.font_size >= 50
        && preferences.caption_preferences.font_size <= 200
        && is_caption_color(&preferences.caption_preferences.text_color)
        && is_caption_color(&preferences.caption_preferences.background_color)
        && (0.0..=1.0).contains(&preferences.caption_preferences.background_opacity)
        && matches!(
            preferences.caption_preferences.font_family.as_str(),
            "system" | "serif" | "monospace"
        )
        && matches!(
            preferences.caption_preferences.text_edge.as_str(),
            "outline" | "shadow" | "none"
        )
        && (5.0..=95.0).contains(&preferences.caption_preferences.position_x)
        && (5.0..=95.0).contains(&preferences.caption_preferences.position_y)
        && preferences.auto_skip_by_show.len() <= 1_000
        && preferences.auto_skip_by_show.keys().all(|key| !key.trim().is_empty() && key.len() <= 500)
}

fn is_caption_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_hexdigit())
}

async fn update_playback_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(preferences): Json<PlaybackPreferences>,
) -> Result<Json<PlaybackPreferences>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !valid_playback_preferences(&preferences) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    states
        .users
        .entry(user.id)
        .or_default()
        .playback_preferences = preferences.clone();
    if write_user_states(&state.user_state_path, &states).await != StatusCode::NO_CONTENT {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    tracing::info!(
        target: "tms_server::playback",
        user = %user.name,
        auto_skip = preferences.auto_skip_enabled,
        auto_next = preferences.auto_next_enabled,
        intro_seconds = preferences.intro_seconds,
        ending_seconds = preferences.ending_seconds,
        image_seconds = preferences.image_seconds,
        buffer_size_mb = preferences.buffer_size_mb,
        "Playback preferences updated"
    );
    Ok(Json(preferences))
}

async fn update_caption_selection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(selection): Json<CaptionSelectionUpdate>,
) -> Result<StatusCode, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let key = selection.key.trim();
    if key.is_empty()
        || key.len() > 500
        || !matches!(selection.source.as_str(), "off" | "local" | "local_pgs" | "remote")
        || selection.track_label.as_ref().is_some_and(|label| label.len() > 500)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    states.users.entry(user.id).or_default().caption_selections.insert(
        key.to_owned(),
        CaptionSelection {
            source: selection.source,
            track_label: selection.track_label,
        },
    );
    if write_user_states(&state.user_state_path, &states).await != StatusCode::NO_CONTENT {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn favorites(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<BTreeSet<String>>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(
        read_user_states(&state.user_state_path)
            .await
            .users
            .remove(&user.id)
            .unwrap_or_default()
            .favorites,
    ))
}

async fn update_favorite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(update): Json<FavoriteUpdate>,
) -> impl IntoResponse {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    if update.path.trim().is_empty()
        || safe_library_path(&state.library_root, &update.path).is_err()
    {
        return StatusCode::BAD_REQUEST;
    }
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    let favorites = &mut states.users.entry(user.id).or_default().favorites;
    if update.favorite {
        favorites.insert(update.path);
    } else {
        favorites.remove(&update.path);
    }
    write_user_states(&state.user_state_path, &states).await
}

fn clean_playlist_name(value: &str) -> Option<String> {
    clean_folder_name(value)
}

fn clean_folder_name(value: &str) -> Option<String> {
    let name = value.trim();
    (!name.is_empty()
        && name.chars().count() <= 80
        && !name.contains(['/', '\\'])
        && !matches!(name, "." | "..")
        && !name.chars().any(char::is_control))
    .then(|| name.to_owned())
}

fn normalize_tags(values: Vec<String>) -> Option<BTreeSet<String>> {
    if values.len() > 20 {
        return None;
    }
    let mut tags = BTreeSet::new();
    let mut lowercase = BTreeSet::new();
    for value in values {
        let tag = value.trim().trim_start_matches('#').trim();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > 32 || tag.chars().any(char::is_control) {
            return None;
        }
        if lowercase.insert(tag.to_lowercase()) {
            tags.insert(tag.to_owned());
        }
    }
    Some(tags)
}

async fn organize_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<OrganizeItemRequest>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let path = request
        .path
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned();
    let Some(library_path) = path.split('/').next().filter(|part| !part.is_empty()) else {
        return StatusCode::BAD_REQUEST;
    };
    let Some(tags) = normalize_tags(request.tags) else {
        return StatusCode::BAD_REQUEST;
    };
    if !safe_relative_path(&path) {
        return StatusCode::NOT_FOUND;
    }
    let target = state.library_root.join(&path);
    let is_folder = target.is_dir();
    if !is_folder && !target.is_file() {
        return StatusCode::NOT_FOUND;
    }
    if is_folder && !request.playlist_ids.is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let libraries = read_libraries(&state).await;
    let allowed = user.is_admin
        || libraries.get(library_path).is_some_and(|library| {
            library
                .members
                .iter()
                .any(|member| member.can_view && member.name.eq_ignore_ascii_case(&user.name))
        });
    if !allowed {
        return StatusCode::FORBIDDEN;
    }
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    let user_state = states.users.entry(user.id).or_default();
    if !request
        .playlist_ids
        .iter()
        .all(|id| user_state.playlists.contains_key(id))
    {
        return StatusCode::NOT_FOUND;
    }
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if tags.is_empty() {
        user_state.tags.remove(&path);
    } else {
        for tag in &tags {
            user_state
                .tag_catalog
                .entry(tag.clone())
                .or_insert_with(|| TagDefinition {
                    name: tag.clone(),
                    created_at: updated_at,
                    updated_at,
                })
                .updated_at = updated_at;
        }
        user_state.tags.insert(path.clone(), tags);
    }
    for playlist in user_state.playlists.values_mut() {
        if request.playlist_ids.contains(&playlist.id) {
            if playlist.paths.insert(path.clone()) {
                playlist.updated_at = updated_at;
            }
        } else {
            if playlist.paths.remove(&path) {
                playlist.updated_at = updated_at;
            }
        }
    }
    let status = write_user_states(&state.user_state_path, &states).await;
    if status == StatusCode::NO_CONTENT {
        tracing::info!(user = %user.name, path, "Media organization updated");
    }
    status
}

fn display_absolute_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    }
}

fn comparable_path(path: &Path) -> String {
    display_absolute_path(path)
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = comparable_path(left);
    let right = comparable_path(right);
    left == right
        || left
            .strip_prefix(&right)
            .is_some_and(|rest| rest.starts_with('\\'))
        || right
            .strip_prefix(&left)
            .is_some_and(|rest| rest.starts_with('\\'))
}

#[cfg(windows)]
fn create_directory_mount(source: &Path, mount_path: &Path) -> std::io::Result<()> {
    junction::create(source, mount_path)
}

#[cfg(not(windows))]
fn create_directory_mount(source: &Path, mount_path: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, mount_path)
}

#[cfg(windows)]
fn remove_directory_mount(mount_path: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(mount_path).is_err() {
        return Ok(());
    }
    if !junction::exists(mount_path)? {
        return Err(std::io::Error::other(
            "the managed mount path is no longer an NTFS junction",
        ));
    }
    junction::delete(mount_path)?;
    std::fs::remove_dir(mount_path)
}

#[cfg(not(windows))]
fn remove_directory_mount(mount_path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(mount_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => std::fs::remove_file(mount_path),
        Ok(_) => Err(std::io::Error::other(
            "the managed mount path is no longer a symbolic link",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
#[allow(dead_code)]
fn create_picker_parent_window() -> windows_sys::Win32::Foundation::HWND {
    use std::sync::Once;
    use windows_sys::Win32::{
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            BringWindowToTop, CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW,
            RegisterClassW, SW_SHOW, SetForegroundWindow, ShowWindow, WNDCLASSW, WS_EX_TOOLWINDOW,
            WS_EX_TOPMOST, WS_POPUP,
        },
    };

    static CLASS_NAME: [u16; 10] = [
        b'T' as u16,
        b'm' as u16,
        b's' as u16,
        b'P' as u16,
        b'i' as u16,
        b'c' as u16,
        b'k' as u16,
        b'e' as u16,
        b'r' as u16,
        0,
    ];
    static REGISTER_CLASS: Once = Once::new();

    unsafe {
        REGISTER_CLASS.call_once(|| {
            let wnd_class = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(DefWindowProcW),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: GetModuleHandleW(std::ptr::null()),
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: CLASS_NAME.as_ptr(),
            };
            RegisterClassW(&wnd_class);
        });

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            CLASS_NAME.as_ptr(),
            CLASS_NAME.as_ptr(),
            WS_POPUP,
            0,
            0,
            1,
            1,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);
        hwnd
    }
}

#[cfg(windows)]
#[allow(dead_code)]
fn destroy_picker_parent_window(hwnd: windows_sys::Win32::Foundation::HWND) {
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow;
    if !hwnd.is_null() {
        unsafe {
            DestroyWindow(hwnd);
        }
    }
}

#[cfg(windows)]
#[allow(dead_code)]
fn pick_folder_on_windows() -> Option<PathBuf> {
    use raw_window_handle::{
        DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawWindowHandle,
        Win32WindowHandle, WindowHandle,
    };
    use std::num::NonZeroIsize;
    use windows_sys::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize,
    };

    struct WindowParent(windows_sys::Win32::Foundation::HWND);

    impl HasWindowHandle for WindowParent {
        fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
            let hwnd = NonZeroIsize::new(self.0 as isize).ok_or(HandleError::Unavailable)?;
            let handle = Win32WindowHandle::new(hwnd);
            Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(handle)) })
        }
    }

    impl HasDisplayHandle for WindowParent {
        fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
            Ok(DisplayHandle::windows())
        }
    }

    let owned_parent = create_picker_parent_window();
    let use_owned = !owned_parent.is_null();
    let parent_hwnd = if use_owned {
        owned_parent
    } else {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        unsafe { GetForegroundWindow() }
    };
    if parent_hwnd.is_null() {
        return None;
    }
    let parent = WindowParent(parent_hwnd);
    unsafe {
        let com_result = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let com_started = com_result == 0;
        let picked = rfd::FileDialog::new()
            .set_title("Choose a folder for TMS")
            .set_parent(&parent)
            .pick_folder();
        if com_started {
            CoUninitialize();
        }
        if use_owned {
            destroy_picker_parent_window(owned_parent);
        }
        picked
    }
}

/// TMS normally starts at boot as SYSTEM (Session 0), where a native dialog is
/// invisible. Queue a request for the per-user broker running on the interactive
/// desktop, then read its one-time result file.
#[cfg(windows)]
fn pick_library_folder_on_windows() -> Option<PathBuf> {
    use std::time::Duration;

    let request_id = uuid::Uuid::new_v4();
    let temp = PathBuf::from(r"C:\Users\Public\Documents\TMS Folder Picker");
    if std::fs::create_dir_all(&temp).is_err() {
        return None;
    }
    let ready = temp.join("broker.ready");
    let broker_is_ready = std::fs::metadata(&ready)
        .and_then(|metadata| metadata.modified())
        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
        .is_ok_and(|elapsed| elapsed < Duration::from_secs(5));
    if !broker_is_ready {
        tracing::warn!("Interactive Windows folder picker broker is not running");
        return None;
    }
    let script = temp.join(format!("tms-folder-picker-{request_id}.ps1"));
    let result = temp.join(format!("tms-folder-picker-{request_id}.txt"));
    let error = temp.join(format!("tms-folder-picker-{request_id}.txt.error"));
    let script_contents = r#"param([string]$ResultPath)
$ErrorActionPreference = 'Stop'
trap {
    [System.IO.File]::WriteAllText(($ResultPath + '.error'), ($_ | Out-String), [System.Text.Encoding]::UTF8)
    exit 1
}
[System.IO.File]::WriteAllText(($ResultPath + '.started'), 'started', [System.Text.Encoding]::UTF8)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class TmsModernFolderPicker {
    [Flags]
    private enum FOS : uint {
        PICKFOLDERS = 0x00000020,
        FORCEFILESYSTEM = 0x00000040,
        PATHMUSTEXIST = 0x00000800,
        NOCHANGEDIR = 0x00000008
    }
    private enum SIGDN : uint { FILESYSPATH = 0x80058000 }

    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_SHOWWINDOW = 0x0040;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    public static void FocusWhenShown(string title) {
        Thread focusThread = new Thread(() => {
            for (int attempt = 0; attempt < 100; attempt++) {
                IntPtr picker = FindWindow(null, title);
                if (picker != IntPtr.Zero) {
                    IntPtr foreground = GetForegroundWindow();
                    uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
                    uint currentThread = GetCurrentThreadId();
                    bool attached = foregroundThread != 0 && AttachThreadInput(currentThread, foregroundThread, true);
                    try {
                        SetWindowPos(picker, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                        BringWindowToTop(picker);
                        SetForegroundWindow(picker);
                    } finally {
                        if (attached) AttachThreadInput(currentThread, foregroundThread, false);
                    }
                    return;
                }
                Thread.Sleep(50);
            }
        });
        focusThread.IsBackground = true;
        focusThread.Start();
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    private interface IFileDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(FOS options);
        void GetOptions(out FOS options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int alignment);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int error);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    private interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(SIGDN sigdn, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    public static string Pick(IntPtr owner) {
        IFileDialog dialog = (IFileDialog)new FileOpenDialog();
        try {
            dialog.SetOptions(FOS.PICKFOLDERS | FOS.FORCEFILESYSTEM | FOS.PATHMUSTEXIST | FOS.NOCHANGEDIR);
            dialog.SetTitle("Choose a folder for TMS");
            dialog.SetOkButtonLabel("Select folder");
            if (dialog.Show(owner) != 0) return "";
            IShellItem item;
            dialog.GetResult(out item);
            IntPtr path;
            item.GetDisplayName(SIGDN.FILESYSPATH, out path);
            try { return Marshal.PtrToStringUni(path) ?? ""; }
            finally { Marshal.FreeCoTaskMem(path); Marshal.ReleaseComObject(item); }
        } finally {
            Marshal.ReleaseComObject(dialog);
        }
    }
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'TMS Folder Picker'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()
[TmsModernFolderPicker]::FocusWhenShown('Choose a folder for TMS')
$selected = [TmsModernFolderPicker]::Pick($owner.Handle)
$owner.Close()
[System.IO.File]::WriteAllText($ResultPath, $selected, [System.Text.Encoding]::UTF8)
"#;
    if std::fs::write(&script, script_contents).is_err() {
        return None;
    }
    tracing::info!(request_id = %request_id, "Queued interactive Windows folder picker");
    for _ in 0..1_200 {
        if let Ok(value) = std::fs::read_to_string(&result) {
            let _ = std::fs::remove_file(&result);
            let _ = std::fs::remove_file(&script);
            let value = value.trim_start_matches('\u{feff}').trim();
            let selected = (!value.is_empty()).then(|| PathBuf::from(value));
            tracing::info!(request_id = %request_id, selected = selected.is_some(), "Interactive Windows folder picker completed");
            return selected;
        }
        if let Ok(message) = std::fs::read_to_string(&error) {
            let _ = std::fs::remove_file(&error);
            let _ = std::fs::remove_file(&script);
            tracing::warn!(request_id = %request_id, error = %message.trim(), "Interactive Windows folder picker failed");
            return None;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = std::fs::remove_file(&script);
    tracing::warn!(request_id = %request_id, "Interactive Windows folder picker timed out");
    None
}

#[cfg(windows)]
fn available_filesystem_roots() -> Vec<FolderBrowserEntry> {
    (b'A'..=b'Z')
        .filter_map(|letter| {
            let path = PathBuf::from(format!("{}:\\", letter as char));
            path.is_dir().then(|| FolderBrowserEntry {
                name: format!("{}: drive", letter as char),
                path: display_absolute_path(&path),
            })
        })
        .collect()
}

#[cfg(not(windows))]
fn available_filesystem_roots() -> Vec<FolderBrowserEntry> {
    vec![FolderBrowserEntry {
        name: "Filesystem".to_owned(),
        path: "/".to_owned(),
    }]
}

async fn apply_ytdlp_organization(
    state: &AppState,
    user_id: u64,
    paths: &[String],
    tags: Vec<String>,
    playlist_id: Option<String>,
    new_playlist_name: Option<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let has_tags = !tags.is_empty();
    let has_playlist = playlist_id.is_some() || new_playlist_name.is_some();
    if !has_tags && !has_playlist {
        return Ok(());
    }
    let normalized_tags = if has_tags {
        normalize_tags(tags).ok_or_else(|| "One or more tags are invalid.".to_owned())?
    } else {
        BTreeSet::new()
    };
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    let user_state = states.users.entry(user_id).or_default();
    let target_playlist_id = if let Some(name) = new_playlist_name {
        if let Some(existing) = user_state
            .playlists
            .values()
            .find(|playlist| playlist.name.eq_ignore_ascii_case(&name))
        {
            Some(existing.id.clone())
        } else {
            let created_at = unix_now();
            let playlist = Playlist {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                paths: BTreeSet::new(),
                created_at,
                updated_at: created_at,
            };
            let id = playlist.id.clone();
            user_state.playlists.insert(id.clone(), playlist);
            Some(id)
        }
    } else {
        playlist_id
    };
    if let Some(id) = target_playlist_id.as_ref()
        && !user_state.playlists.contains_key(id)
    {
        return Err("The selected playlist no longer exists.".to_owned());
    }
    let updated_at = unix_now();
    for path in paths {
        if !normalized_tags.is_empty() {
            for tag in &normalized_tags {
                user_state
                    .tag_catalog
                    .entry(tag.clone())
                    .or_insert_with(|| TagDefinition {
                        name: tag.clone(),
                        created_at: updated_at,
                        updated_at,
                    })
                    .updated_at = updated_at;
            }
            user_state
                .tags
                .insert(path.clone(), normalized_tags.iter().cloned().collect());
        }
        if let Some(id) = target_playlist_id.as_ref()
            && let Some(playlist) = user_state.playlists.get_mut(id)
            && playlist.paths.insert(path.clone())
        {
            playlist.updated_at = updated_at;
        }
    }
    if write_user_states(&state.user_state_path, &states).await != StatusCode::NO_CONTENT {
        return Err("Downloaded media could not be organized.".to_owned());
    }
    Ok(())
}

async fn create_tag(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateTagRequest>,
) -> Result<(StatusCode, Json<TagDefinition>), StatusCode> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let Some(name) = normalize_tags(vec![request.name]).and_then(|mut tags| tags.pop_first())
    else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    let user_state = states.users.entry(user.id).or_default();
    if user_state
        .tag_catalog
        .keys()
        .chain(user_state.tags.values().flatten())
        .any(|tag| tag.eq_ignore_ascii_case(&name))
    {
        return Err(StatusCode::CONFLICT);
    }
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let tag = TagDefinition {
        name: name.clone(),
        created_at,
        updated_at: created_at,
    };
    user_state.tag_catalog.insert(name, tag.clone());
    if write_user_states(&state.user_state_path, &states).await != StatusCode::NO_CONTENT {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    tracing::info!(user = %user.name, tag = %tag.name, "Tag created");
    Ok((StatusCode::CREATED, Json(tag)))
}

async fn delete_tag(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let Some(name) = normalize_tags(vec![name]).and_then(|mut tags| tags.pop_first()) else {
        return StatusCode::BAD_REQUEST;
    };
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    let user_state = states.users.entry(user.id).or_default();
    let catalog_name = user_state
        .tag_catalog
        .keys()
        .find(|tag| tag.eq_ignore_ascii_case(&name))
        .cloned();
    let was_assigned = user_state
        .tags
        .values()
        .any(|tags| tags.iter().any(|tag| tag.eq_ignore_ascii_case(&name)));
    if catalog_name.is_none() && !was_assigned {
        return StatusCode::NOT_FOUND;
    }
    if let Some(catalog_name) = catalog_name {
        user_state.tag_catalog.remove(&catalog_name);
    }
    for tags in user_state.tags.values_mut() {
        tags.retain(|tag| !tag.eq_ignore_ascii_case(&name));
    }
    user_state.tags.retain(|_, tags| !tags.is_empty());
    match write_user_states(&state.user_state_path, &states).await {
        StatusCode::NO_CONTENT => {
            tracing::info!(user = %user.name, tag = %name, "Tag deleted");
            StatusCode::NO_CONTENT
        }
        status => status,
    }
}

async fn create_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreatePlaylistRequest>,
) -> Result<(StatusCode, Json<Playlist>), StatusCode> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let Some(name) = clean_playlist_name(&request.name) else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    let user_state = states.users.entry(user.id).or_default();
    if user_state
        .playlists
        .values()
        .any(|playlist| playlist.name.eq_ignore_ascii_case(&name))
    {
        return Err(StatusCode::CONFLICT);
    }
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let playlist = Playlist {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        paths: BTreeSet::new(),
        created_at,
        updated_at: created_at,
    };
    user_state
        .playlists
        .insert(playlist.id.clone(), playlist.clone());
    if write_user_states(&state.user_state_path, &states).await != StatusCode::NO_CONTENT {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    tracing::info!(user = %user.name, playlist = %playlist.name, "Playlist created");
    Ok((StatusCode::CREATED, Json(playlist)))
}

async fn update_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<UpdatePlaylistRequest>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let Some(name) = clean_playlist_name(&request.name) else {
        return StatusCode::BAD_REQUEST;
    };
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    let user_state = states.users.entry(user.id).or_default();
    if user_state.playlists.iter().any(|(playlist_id, playlist)| {
        playlist_id != &id && playlist.name.eq_ignore_ascii_case(&name)
    }) {
        return StatusCode::CONFLICT;
    }
    let Some(playlist) = user_state.playlists.get_mut(&id) else {
        return StatusCode::NOT_FOUND;
    };
    playlist.name = name;
    write_user_states(&state.user_state_path, &states).await
}

async fn delete_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> StatusCode {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return StatusCode::UNAUTHORIZED;
    };
    let _guard = state.persistence_lock.lock().await;
    let mut states = read_user_states(&state.user_state_path).await;
    let user_state = states.users.entry(user.id).or_default();
    if user_state.playlists.remove(&id).is_none() {
        return StatusCode::NOT_FOUND;
    }
    write_user_states(&state.user_state_path, &states).await
}

async fn clean_playlist_filenames(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    let Some(user) = authenticated_user(&state, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let _guard = state.persistence_lock.lock().await;
    let libraries = read_libraries(&state).await;
    let mut states = read_user_states(&state.user_state_path).await;
    let playlist_paths = states
        .users
        .get(&user.id)
        .and_then(|user_state| user_state.playlists.get(&id))
        .map(|playlist| playlist.paths.clone())
        .ok_or(StatusCode::NOT_FOUND)?;
    let mut renamed = Vec::new();
    for path in playlist_paths {
        let file_name = Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let Some(cleaned_name) = cleaned_ytdlp_file_name(file_name) else {
            continue;
        };
        let Some(library_path) = path.split('/').next() else {
            continue;
        };
        let allowed = user.is_admin
            || libraries.get(library_path).is_some_and(|config| {
                config
                    .members
                    .iter()
                    .any(|member| member.name.eq_ignore_ascii_case(&user.name) && member.can_rename)
            });
        if !allowed {
            continue;
        }
        let destination_path = match Path::new(&path).parent().and_then(|parent| parent.to_str()) {
            Some(parent) => format!("{}/{}", parent.replace('\\', "/"), cleaned_name),
            None => cleaned_name.clone(),
        };
        if destination_path == path {
            continue;
        }
        let source = state.library_root.join(&path);
        let destination = unique_destination_path(&state.library_root.join(&destination_path));
        if !source.is_file() {
            continue;
        }
        if let Some(parent) = destination.parent()
            && tokio::fs::create_dir_all(parent).await.is_err()
        {
            continue;
        }
        if tokio::fs::rename(&source, &destination).await.is_err() {
            continue;
        }
        let final_path = destination
            .strip_prefix(&state.library_root)
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or(destination_path);
        rewrite_all_media_paths(&mut states, &path, &final_path);
        renamed.push(serde_json::json!({ "from": path, "to": final_path }));
    }
    if renamed.is_empty() {
        return Ok((
            StatusCode::OK,
            Json(serde_json::json!({ "renamed": 0, "items": [] })),
        ));
    }
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    for item in &renamed {
        if let (Some(from), Some(to)) = (
            item.get("from").and_then(Value::as_str),
            item.get("to").and_then(Value::as_str),
        ) {
            rewrite_storage_paths(&mut ledger, from, to);
        }
    }
    let states_status = write_user_states(&state.user_state_path, &states).await;
    let storage_status = write_storage_ledger(&state.storage_path, &ledger).await;
    if states_status != StatusCode::NO_CONTENT || storage_status.is_err() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({
            "renamed": renamed.len(),
            "items": renamed,
        })),
    ))
}

fn rewrite_all_media_paths(states: &mut UserStates, source: &str, destination: &str) {
    for user_state in states.users.values_mut() {
        user_state.favorites = user_state
            .favorites
            .iter()
            .map(|path| rewrite_path_prefix(path, source, destination))
            .collect();
        user_state.playback = user_state
            .playback
            .iter()
            .map(|(path, playback)| {
                (
                    rewrite_path_prefix(path, source, destination),
                    playback.clone(),
                )
            })
            .collect();
        user_state.last_accessed = user_state
            .last_accessed
            .iter()
            .map(|(path, timestamp)| (rewrite_path_prefix(path, source, destination), *timestamp))
            .collect();
        user_state.tags = user_state
            .tags
            .iter()
            .map(|(path, tags)| (rewrite_path_prefix(path, source, destination), tags.clone()))
            .collect();
        for playlist in user_state.playlists.values_mut() {
            playlist.paths = playlist
                .paths
                .iter()
                .map(|path| rewrite_path_prefix(path, source, destination))
                .collect();
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct EpisodeName {
    title: String,
    season: u16,
    episode: u16,
}

#[derive(Debug, PartialEq, Eq)]
struct ReleaseSeason {
    title: String,
    season: u16,
}

/// Get the show and season from either an episode release (`S03E05`) or a
/// season pack (`S03.COMPLETE`).  Torrent display names normally arrive before
/// their file list, so this deliberately does not require an episode number.
fn release_season_from_name(value: &str) -> Option<ReleaseSeason> {
    let stem = Path::new(value).file_stem()?.to_string_lossy();
    let bytes = stem.as_bytes();
    for index in 0..bytes.len() {
        if !matches!(bytes[index], b's' | b'S')
            || (index > 0 && bytes[index - 1].is_ascii_alphanumeric())
        {
            continue;
        }
        let mut cursor = index + 1;
        let season_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() && cursor - season_start < 2 {
            cursor += 1;
        }
        if cursor == season_start {
            continue;
        }
        let season = stem[season_start..cursor].parse::<u16>().ok()?;
        let title = clean_media_component(&stem[..index]);
        if !title.is_empty() {
            return Some(ReleaseSeason { title, season });
        }
    }
    // Some torrent indexes spell a season out (`Show Name Season 1`) rather
    // than using the release-standard `Show.Name.S01`. Recognize that form
    // before qBittorrent has exposed episode filenames, so each pack is
    // seeded beneath the same show directory from the outset.
    let lower = stem.to_ascii_lowercase();
    let marker = " season ";
    let index = lower.rfind(marker)?;
    let season_start = index + marker.len();
    let digits = lower[season_start..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() || digits.len() > 2 {
        return None;
    }
    let season = digits.parse::<u16>().ok()?;
    let title = clean_media_component(&stem[..index]);
    (!title.is_empty()).then_some(ReleaseSeason { title, season })
}

/// Recognize the release-name convention used by almost all TV torrents, for
/// example `House.of.the.Dragon.S03E05.1080p...`.
fn episode_name_from_release(value: &str) -> Option<EpisodeName> {
    let stem = Path::new(value).file_stem()?.to_string_lossy();
    let bytes = stem.as_bytes();
    for index in 0..bytes.len() {
        if !matches!(bytes[index], b's' | b'S')
            || (index > 0 && bytes[index - 1].is_ascii_alphanumeric())
        {
            continue;
        }
        let mut cursor = index + 1;
        let season_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() && cursor - season_start < 2 {
            cursor += 1;
        }
        if cursor == season_start || cursor >= bytes.len() || !matches!(bytes[cursor], b'e' | b'E')
        {
            continue;
        }
        let season = stem[season_start..cursor].parse::<u16>().ok()?;
        cursor += 1;
        let episode_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() && cursor - episode_start < 3 {
            cursor += 1;
        }
        if cursor == episode_start {
            continue;
        }
        let episode = stem[episode_start..cursor].parse::<u16>().ok()?;
        let title = clean_media_component(&stem[..index]);
        if !title.is_empty() {
            return Some(EpisodeName {
                title,
                season,
                episode,
            });
        }
    }
    anime_episode_from_release(value)
}

/// Fansub batches commonly use `[Group] Title - 01 [quality].mkv`.
/// Require the spaced separator and a short number so movie years and
/// resolution/codec suffixes cannot become episodes.
fn anime_episode_from_release(value: &str) -> Option<EpisodeName> {
    let filename = value.rsplit(['/', '\\']).next()?;
    let stem = Path::new(filename).file_stem()?.to_str()?;
    let (mut title, suffix) = stem.rsplit_once(" - ")?;
    let digits: String = suffix.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 3 {
        return None;
    }
    let remainder = suffix[digits.len()..].trim();
    if !remainder.is_empty() && !remainder.starts_with('[') && !remainder.starts_with('(') {
        return None;
    }
    while title.starts_with('[') {
        title = title.split_once(']')?.1.trim_start();
    }
    let title = clean_media_component(title);
    let episode = digits.parse::<u16>().ok()?;
    if title.is_empty() || episode == 0 {
        return None;
    }
    Some(EpisodeName {
        title,
        season: release_season_from_name(value).map_or(1, |release| release.season),
        episode,
    })
}

fn clean_media_component(value: &str) -> String {
    let mut cleaned = String::with_capacity(value.len());
    let mut spacing = false;
    for character in value.trim().chars() {
        if matches!(character, '.' | '_' | '-' | ' ' | '\t') {
            spacing = !cleaned.is_empty();
        } else if !matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        ) && !character.is_control()
        {
            if spacing {
                cleaned.push(' ');
                spacing = false;
            }
            cleaned.push(character);
        }
    }
    cleaned.trim().chars().take(120).collect()
}

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mkv" | "mp4" | "m4v" | "avi" | "mov" | "wmv" | "webm"
            )
        })
}


#[derive(Debug)]
struct OrganizeError {
    message: String,
    retryable: bool,
}

struct OrganizeResult {
    moved: usize,
    moves: Vec<(PathBuf, PathBuf)>,
}

impl OrganizeError {
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    fn media_move(error: std::io::Error) -> Self {
        Self {
            retryable: error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(32),
            message: error.to_string(),
        }
    }
}

async fn organize_completed_episode(
    state: &AppState,
    torrent: &QbittorrentTorrent,
    canonical_destination: Option<&Path>,
) -> Result<OrganizeResult, OrganizeError> {
    let source_root = torrent_content_path(torrent);
    let save_path = PathBuf::from(&torrent.save_path);
    organize_movie_tv_media(
        state,
        &source_root,
        &save_path,
        &torrent.name,
        canonical_destination,
    )
    .await
}

async fn organize_movie_tv_media(
    state: &AppState,
    source_root: &Path,
    save_path: &Path,
    release_name: &str,
    canonical_destination: Option<&Path>,
) -> Result<OrganizeResult, OrganizeError> {
    if !source_root.starts_with(&save_path) || !source_root.starts_with(&state.library_root) {
        return Err(OrganizeError::permanent(
            "media was placed outside the selected library",
        ));
    }
    let organization_started_at = Instant::now();
    let sources = if source_root.is_file() {
        vec![source_root.to_path_buf()]
    } else {
        WalkDir::new(source_root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file() && is_video_file(entry.path()))
            .map(|entry| entry.into_path())
            .collect()
    };
    let source_count = sources.len();
    let mut moved = 0;
    let mut moves = Vec::new();
    for source in sources {
        let Some(mut episode) =
            episode_name_from_release(&source.file_name().unwrap_or_default().to_string_lossy())
                .or_else(|| episode_name_from_release(release_name))
        else {
            continue;
        };
        if anime_episode_from_release(&source.file_name().unwrap_or_default().to_string_lossy()).is_some()
            && let Some(release) = release_season_from_name(release_name)
        {
            episode.season = release.season;
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("mkv");
        // A magnet can be seeded into `Show/Season 01` before qBittorrent has
        // exposed its files. Treat that as the canonical *show* location, not
        // as the parent for every later season in a multi-season pack.
        let destination_dir = canonical_destination
            .filter(|destination| destination.starts_with(&state.library_root))
            .and_then(|destination| {
                let show_dir = destination.parent()?;
                let is_season_dir = destination.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .strip_prefix("Season ")
                        .and_then(|value| value.parse::<u16>().ok())
                        .is_some()
                });
                // The canonical path has the stable title from the magnet. Do
                // not rebuild it from a file name that may omit the release year.
                is_season_dir.then(|| show_dir.join(format!("Season {:02}", episode.season)))
            })
            .unwrap_or_else(|| {
                save_path
                    .join(&episode.title)
                    .join(format!("Season {:02}", episode.season))
            });
        tokio::fs::create_dir_all(&destination_dir)
            .await
            .map_err(|error| OrganizeError::permanent(error.to_string()))?;
        let destination = destination_dir.join(format!(
            "{} - S{:02}E{:02}.{}",
            episode.title, episode.season, episode.episode, extension
        ));
        if destination.exists() {
            return Err(OrganizeError::permanent(format!(
                "{} already exists",
                destination.display()
            )));
        }
        tokio::fs::rename(&source, &destination)
            .await
            .map_err(OrganizeError::media_move)?;
        moves.push((source.clone(), destination.clone()));
        cleanup_empty_media_directories(&source, save_path).await;
        tracing::info!(source = %source.display(), destination = %destination.display(), "TV episode organized into its show and season folder");
        moved += 1;
    }
    if moved == 0 {
        return Err(OrganizeError::permanent(
            "no TV episode filename was recognized; leaving the completed download in its selected folder",
        ));
    }
    let organization_elapsed = organization_started_at.elapsed();
    tracing::info!(
        source_root = %source_root.display(),
        source_count,
        episodes_moved = moved,
        organization_duration_ms = organization_elapsed.as_millis() as u64,
        "Movies & TV organization completed"
    );
    Ok(OrganizeResult { moved, moves })
}

/// Folder uploads are staged using their relative path before their episodes are
/// moved into the canonical show/season layout. Remove only empty staging
/// folders afterwards, stopping at the selected library's root.
async fn cleanup_empty_media_directories(source: &Path, library_root: &Path) {
    let mut current = source.parent();
    while let Some(directory) = current {
        if directory == library_root || !directory.starts_with(library_root) {
            break;
        }
        if tokio::fs::remove_dir(directory).await.is_err() {
            break;
        }
        current = directory.parent();
    }
}



async fn launch_local_helper(path: &Path, arguments: &[&str]) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{} is not installed.", path.display()));
    }
    hidden_async_command(path)
        .args(arguments)
        .spawn()
        .map(|_| ())
        .map_err(|_| format!("Could not start {}.", path.display()))
}


fn decode_base32_info_hash(value: &str) -> Option<String> {
    let mut accumulator = 0_u32;
    let mut bit_count = 0_u8;
    let mut bytes = Vec::with_capacity(20);
    for character in value.chars() {
        let digit = match character.to_ascii_uppercase() {
            'A'..='Z' => character.to_ascii_uppercase() as u8 - b'A',
            '2'..='7' => character as u8 - b'2' + 26,
            _ => return None,
        };
        accumulator = (accumulator << 5) | u32::from(digit);
        bit_count += 5;
        while bit_count >= 8 {
            bit_count -= 8;
            bytes.push(((accumulator >> bit_count) & 0xff) as u8);
        }
    }
    (bytes.len() == 20).then(|| bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn magnet_info_hash(value: &str) -> Option<String> {
    let value = value.trim();
    if value.len() > 8192 || !value.to_ascii_lowercase().starts_with("magnet:?") {
        return None;
    }
    let query = value.split_once('?')?.1;
    for parameter in query.split('&') {
        let decoded = urlencoding::decode(parameter).ok()?;
        let lower = decoded.to_ascii_lowercase();
        let Some(hash) = lower.strip_prefix("xt=urn:btih:") else {
            continue;
        };
        if hash.len() == 40 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Some(hash.to_owned());
        }
        if hash.len() == 32 {
            return decode_base32_info_hash(hash);
        }
    }
    None
}

/// The `dn` parameter is the torrent's advertised name.  It is available as
/// soon as a magnet is submitted, unlike qBittorrent's file list.
fn magnet_display_name(value: &str) -> Option<String> {
    let query = value.trim().split_once('?')?.1;
    query.split('&').find_map(|parameter| {
        let parameter = parameter.replace('+', " ");
        let decoded = urlencoding::decode(&parameter).ok()?;
        decoded
            .split_once('=')
            .filter(|(key, _)| key.eq_ignore_ascii_case("dn"))
            .map(|(_, name)| name)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn allocation_files_after_moves(
    state: &AppState,
    files: Vec<(PathBuf, u64)>,
    moves: &[(PathBuf, PathBuf)],
) -> Vec<(String, u64)> {
    files
        .into_iter()
        .filter_map(|(path, bytes)| {
            let final_path = moves
                .iter()
                .find(|(source, _)| source == &path)
                .map(|(_, destination)| destination)
                .unwrap_or(&path);
            final_path
                .strip_prefix(&state.library_root)
                .ok()
                .map(|relative| (relative.to_string_lossy().replace('\\', "/"), bytes))
        })
        .collect()
}


async fn read_user_states(path: &Path) -> UserStates {
    read_persisted_json(path).await.unwrap_or_default()
}

async fn write_user_states(path: &Path, states: &UserStates) -> StatusCode {
    match write_persisted_json(path, states).await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(status) => status,
    }
}

async fn folder_covers(State(state): State<AppState>) -> Json<serde_json::Map<String, Value>> {
    Json(read_all_folder_covers(&state).await)
}

/// Folder art must be an image, not a browser-decoded video: mobile browsers
/// routinely abandon muted preview videos while cards are scrolling. Generated
/// covers live separately from manually uploaded covers so resetting a custom
/// image goes back to the durable automatic JPEG instead of redoing FFmpeg.
async fn generate_automatic_folder_cover(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AutomaticFolderCoverRequest>,
) -> Result<Json<Value>, StatusCode> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_libraries))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let folder_path = request.folder_path.trim();
    let folder = safe_library_path(&state.library_root, folder_path)?;
    if !folder.is_dir() {
        return Err(StatusCode::NOT_FOUND);
    }
    // Title and season artwork comes from the metadata provider.  Never turn
    // a release screenshot, NFO-adjacent image, or episode frame into the
    // catalog poster just because it happens to live below a Movies & TV
    // folder.
    if is_movies_tv_folder_path(folder_path, &read_libraries(&state).await) {
        return Err(StatusCode::CONFLICT);
    }

    let custom_covers = read_folder_covers(&state.folder_covers_path).await;
    let replaced_custom_filename = custom_covers
        .get(folder_path)
        .and_then(Value::as_str)
        .map(str::to_owned);
    if !request.refresh {
        if let Some(filename) = replaced_custom_filename
            .as_deref()
            .filter(|filename| state.folder_covers_dir.join(filename).is_file())
        {
            return Ok(Json(serde_json::json!({ "filename": filename })));
        }
    }
    let automatic_covers = read_folder_covers(&state.automatic_folder_covers_path).await;
    let previous_filename = automatic_covers
        .get(folder_path)
        .and_then(Value::as_str)
        .map(str::to_owned);
    if !request.refresh {
        if let Some(filename) = previous_filename
            .as_deref()
            .filter(|filename| state.folder_covers_dir.join(filename).is_file())
        {
            return Ok(Json(serde_json::json!({ "filename": filename })));
        }
    }
    let previous_cover = previous_filename
        .as_deref()
        .map(|filename| state.folder_covers_dir.join(filename))
        .filter(|path| path.is_file())
        .or_else(|| {
            replaced_custom_filename
                .as_deref()
                .map(|filename| state.folder_covers_dir.join(filename))
                .filter(|path| path.is_file())
        });

    // Folder covers and trickplay share this lock: one low-priority FFmpeg
    // process is enough, and preview work must never compete with playback.
    let _preview_lock = state.trickplay_run_lock.lock().await;
    let seed = if request.refresh {
        format!("{folder_path}:{}", uuid::Uuid::new_v4())
    } else {
        folder_path.to_owned()
    };
    let candidate_seed = seed.clone();
    let scan_root = state.library_root.clone();
    let scan_folder = folder.clone();
    let candidate = tokio::task::spawn_blocking(move || {
        automatic_folder_cover_candidate(
            &scan_root,
            &scan_folder,
            &candidate_seed,
            previous_cover.as_deref(),
            request.refresh,
        )
    })
    .await
    .ok()
    .flatten()
    .ok_or(StatusCode::NOT_FOUND)?;

    if candidate.1 == "video" && !state.ffmpeg_path.is_file() {
        tracing::warn!(folder = %folder_path, ffmpeg = %state.ffmpeg_path.display(), "Cannot create automatic video folder cover because FFmpeg is unavailable");
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    tokio::fs::create_dir_all(&state.folder_covers_dir)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let filename = automatic_folder_cover_filename(
        folder_path,
        &candidate.0,
        candidate.1,
        request.refresh.then_some(seed.as_str()),
    );
    let output = state.folder_covers_dir.join(&filename);
    let staging_extension = if candidate.1 == "image" {
        candidate
            .0
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("jpg")
            .to_owned()
    } else {
        "jpg".to_owned()
    };
    let staging = state
        .folder_covers_dir
        .join(format!("{filename}.tmp.{staging_extension}"));
    let created = if candidate.1 == "image" {
        tokio::fs::copy(&candidate.0, &staging).await.is_ok()
    } else {
        create_video_folder_cover(&state, &candidate.0, &staging, folder_path).await
    };
    if !created || !staging.is_file() {
        let _ = tokio::fs::remove_file(&staging).await;
        tracing::warn!(folder = %folder_path, source = %candidate.0.display(), kind = candidate.1, "Could not create automatic folder cover");
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    tokio::fs::rename(&staging, &output)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let _guard = state.persistence_lock.lock().await;
    if request.refresh {
        let mut saved_custom_covers = read_folder_covers(&state.folder_covers_path).await;
        if let Some(previous_filename) = saved_custom_covers
            .remove(folder_path)
            .and_then(|value| value.as_str().map(str::to_owned))
        {
            write_folder_covers(&state.folder_covers_path, &saved_custom_covers).await?;
            let _ = tokio::fs::remove_file(state.folder_covers_dir.join(previous_filename)).await;
        }
    }
    let mut saved = read_folder_covers(&state.automatic_folder_covers_path).await;
    if request.refresh {
        if let Some(previous_filename) = saved
            .remove(folder_path)
            .and_then(|value| value.as_str().map(str::to_owned))
        {
            if previous_filename != filename {
                let _ =
                    tokio::fs::remove_file(state.folder_covers_dir.join(previous_filename)).await;
            }
        }
    }
    saved.insert(folder_path.to_owned(), Value::String(filename.clone()));
    write_folder_covers(&state.automatic_folder_covers_path, &saved).await?;
    tracing::info!(folder = %folder_path, source = %candidate.0.display(), kind = candidate.1, cover = %filename, "Generated persistent automatic folder cover");
    Ok(Json(serde_json::json!({ "filename": filename })))
}

async fn update_folder_cover(
    State(state): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> impl IntoResponse {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_libraries))
    {
        return StatusCode::FORBIDDEN;
    }
    let Some(folder_path) = headers
        .get("x-folder-path")
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::BAD_REQUEST;
    };
    let Some(content_type) = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::BAD_REQUEST;
    };
    if folder_path.trim().is_empty()
        || !content_type.starts_with("image/")
        || bytes.is_empty()
        || bytes.len() > 25 * 1024 * 1024
    {
        return StatusCode::BAD_REQUEST;
    }
    let extension = match content_type.split(';').next().unwrap_or("") {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        _ => return StatusCode::UNSUPPORTED_MEDIA_TYPE,
    };
    let _guard = state.persistence_lock.lock().await;
    let mut hasher = DefaultHasher::new();
    folder_path.hash(&mut hasher);
    bytes.hash(&mut hasher);
    let filename = format!("{:016x}.{extension}", hasher.finish());
    if tokio::fs::create_dir_all(&state.folder_covers_dir)
        .await
        .is_err()
        || tokio::fs::write(state.folder_covers_dir.join(&filename), bytes)
            .await
            .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let mut covers = read_folder_covers(&state.folder_covers_path).await;
    covers.insert(folder_path.to_owned(), Value::String(filename));
    if write_folder_covers(&state.folder_covers_path, &covers)
        .await
        .is_ok()
    {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

async fn clear_folder_cover(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_libraries))
    {
        return StatusCode::FORBIDDEN;
    }
    let Some(folder_path) = headers
        .get("x-folder-path")
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::BAD_REQUEST;
    };
    let _guard = state.persistence_lock.lock().await;
    let mut covers = read_folder_covers(&state.folder_covers_path).await;
    if let Some(filename) = covers
        .remove(folder_path)
        .and_then(|value| value.as_str().map(str::to_owned))
    {
        let _ = tokio::fs::remove_file(state.folder_covers_dir.join(filename)).await;
    }
    if write_folder_covers(&state.folder_covers_path, &covers)
        .await
        .is_ok()
    {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

async fn read_folder_covers(path: &Path) -> serde_json::Map<String, Value> {
    read_persisted_json(path).await.unwrap_or_default()
}

async fn read_all_folder_covers(state: &AppState) -> serde_json::Map<String, Value> {
    let mut covers = read_folder_covers(&state.automatic_folder_covers_path).await;
    // Older versions generated automatic covers for every folder.  Do not
    // return those legacy images for catalog folders; manually uploaded covers
    // below still take precedence and are intentionally retained.
    let libraries = read_libraries(state).await;
    covers.retain(|folder_path, _| !is_movies_tv_folder_path(folder_path, &libraries));
    covers.extend(read_folder_covers(&state.folder_covers_path).await);
    covers
}

fn is_movies_tv_folder_path(
    folder_path: &str,
    libraries: &BTreeMap<String, LibraryConfig>,
) -> bool {
    folder_path
        .split('/')
        .next()
        .and_then(|library_name| libraries.get(library_name))
        .is_some_and(|library| library.content_type == "movies_tv")
}

async fn write_folder_covers(
    path: &Path,
    covers: &serde_json::Map<String, Value>,
) -> Result<(), StatusCode> {
    write_persisted_json(path, covers).await
}

/// First-time automatic covers prefer a real image. A user-triggered refresh,
/// however, chooses from both images and video frames so "Change cover" can
/// actually rotate through all available artwork.
fn automatic_folder_cover_candidate(
    root: &Path,
    folder: &Path,
    seed: &str,
    previous_cover: Option<&Path>,
    include_videos_with_images: bool,
) -> Option<(PathBuf, &'static str)> {
    let mut image: Option<(u64, PathBuf)> = None;
    let mut video: Option<(u64, PathBuf)> = None;
    for entry in WalkDir::new(folder)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.into_path();
        let kind = if is_cover_image_file(&path) {
            "image"
        } else if is_folder_cover_video_file(&path) {
            "video"
        } else {
            continue;
        };
        // An automatic image is a direct copy of its source. When changing a
        // cover, skip that exact source so an available alternative is visibly
        // different rather than merely written under a new name.
        if kind == "image"
            && previous_cover.is_some_and(|previous| {
                previous.metadata().ok().map(|metadata| metadata.len())
                    == path.metadata().ok().map(|metadata| metadata.len())
                    && std::fs::read(previous).ok() == std::fs::read(&path).ok()
            })
        {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let mut hasher = DefaultHasher::new();
        seed.hash(&mut hasher);
        relative.hash(&mut hasher);
        let scored = (hasher.finish(), path);
        let target = if kind == "image" {
            &mut image
        } else {
            &mut video
        };
        if target.as_ref().is_none_or(|(score, _)| scored.0 < *score) {
            *target = Some(scored);
        }
    }
    if include_videos_with_images {
        image
            .into_iter()
            .chain(video)
            .min_by_key(|(score, _)| *score)
            .map(|(_, path)| {
                let kind = if is_cover_image_file(&path) {
                    "image"
                } else {
                    "video"
                };
                (path, kind)
            })
    } else {
        image
            .map(|(_, path)| (path, "image"))
            .or_else(|| video.map(|(_, path)| (path, "video")))
    }
}

fn is_cover_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif"
            )
        })
}

const LIBRARY_BATCH_LIMIT: usize = 100;
const LIBRARY_VISUAL_BATCH_LIMIT: usize = 15;

fn is_library_visual_entry(entry: &LibraryEntry) -> bool {
    entry.kind != "folder" && matches!(library_media_type(entry), "image" | "video")
}

fn paginate_library_folder_page(
    entries: &[LibraryEntry],
    offset: usize,
    load_all: bool,
) -> (Vec<LibraryEntry>, usize, bool) {
    if load_all {
        let consumed = entries.len().saturating_sub(offset);
        return (
            entries.get(offset..).unwrap_or(&[]).to_vec(),
            consumed,
            false,
        );
    }

    let mut page = Vec::new();
    let mut visuals = 0usize;
    let mut index = offset;

    while index < entries.len() {
        if page.len() >= LIBRARY_BATCH_LIMIT {
            break;
        }
        let entry = &entries[index];
        let is_visual = is_library_visual_entry(entry);

        if is_visual {
            visuals += 1;
        }

        page.push(entry.clone());
        index += 1;
        if visuals >= LIBRARY_VISUAL_BATCH_LIMIT {
            break;
        }
    }

    let consumed = index.saturating_sub(offset);
    let has_more = index < entries.len();
    (page, consumed, has_more)
}

async fn populate_library_thumbnail_metadata(state: &AppState, entries: &mut [LibraryEntry]) {
    for entry in entries
        .iter_mut()
        .filter(|entry| is_library_visual_entry(entry))
    {
        let Ok(input) = safe_library_path(&state.library_root, &entry.path) else {
            continue;
        };
        let Ok(metadata) = tokio::fs::metadata(&input).await else {
            continue;
        };
        let key = grid_thumb_key(&entry.path, &metadata);
        let thumbnail_path = state.grid_thumbs_dir.join(format!("{key}.jpg"));
        if !thumbnail_path.is_file() {
            continue;
        }
        entry.thumbnail_aspect_ratio = tokio::task::spawn_blocking(move || {
            let (width, height) = image::image_dimensions(thumbnail_path).ok()?;
            (height > 0).then(|| width as f64 / height as f64)
        })
        .await
        .ok()
        .flatten();
    }
}

fn is_folder_cover_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp4"
                    | "mkv"
                    | "webm"
                    | "mov"
                    | "avi"
                    | "m4v"
                    | "mpeg"
                    | "mpg"
                    | "wmv"
                    | "3gp"
                    | "ts"
                    | "m2ts"
            )
        })
}

fn automatic_folder_cover_filename(
    folder_path: &str,
    source: &Path,
    kind: &str,
    variation: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(folder_path.as_bytes());
    hasher.update(source.to_string_lossy().as_bytes());
    hasher.update(kind.as_bytes());
    if let Some(variation) = variation {
        hasher.update(variation.as_bytes());
    }
    let extension = if kind == "image" {
        source
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("jpg")
            .to_ascii_lowercase()
    } else {
        "jpg".to_owned()
    };
    format!("auto-{:x}.{extension}", hasher.finalize())
}

async fn create_video_folder_cover(
    state: &AppState,
    input: &Path,
    output: &Path,
    seed: &str,
) -> bool {
    let duration = hidden_async_command(&state.ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(input)
        .output()
        .await
        .ok()
        .filter(|result| result.status.success())
        .and_then(|result| String::from_utf8(result.stdout).ok())
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0);
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    input.hash(&mut hasher);
    let frame_at = (hasher.finish() % 10_000) as f64 / 10_000.0 * (duration * 0.8).max(0.1);
    let mut command = hidden_async_command(&state.ffmpeg_path);
    command
        .args([
            "-y",
            "-v",
            "error",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-ss",
            &format!("{frame_at:.3}"),
            "-i",
        ])
        .arg(input)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-2:force_original_aspect_ratio=decrease",
            "-q:v",
            "4",
        ])
        .arg(output);
    #[cfg(windows)]
    command
        .as_std_mut()
        .creation_flags(0x0800_0000 | IDLE_PRIORITY_CLASS);
    command.status().await.is_ok_and(|status| status.success())
}

#[derive(Default, Deserialize, Serialize)]
struct SharedTodo {
    #[serde(default)]
    text: String,
}

async fn read_shared_todo(path: &Path) -> SharedTodo {
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SharedTodo>(&bytes).ok())
        .unwrap_or_default()
}

async fn shared_todo(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SharedTodo>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !has_admin_capability(&user, |permissions| permissions.access_admin_panel) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(Json(read_shared_todo(&state.shared_todo_path).await))
}

async fn update_shared_todo(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SharedTodo>,
) -> Result<StatusCode, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !has_admin_capability(&user, |permissions| permissions.access_admin_panel) {
        return Err(StatusCode::FORBIDDEN);
    }
    if payload.text.len() > 50_000_000 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let _guard = state.persistence_lock.lock().await;
    let Ok(bytes) = serde_json::to_vec_pretty(&payload) else {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    };
    if tokio::fs::write(&state.shared_todo_path, bytes)
        .await
        .is_ok()
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::INTERNAL_SERVER_ERROR)
    }
}

const SKIP_SEGMENTS_CACHE_SECONDS: u64 = 7 * 24 * 60 * 60;

async fn skip_segments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SkipSegmentsQuery>,
) -> Result<Json<SkipSegmentsResponse>, StatusCode> {
    authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if (!query.imdb_id.is_empty() && !valid_imdb_id(&query.imdb_id))
        || !query.duration.is_finite()
        || !(5.0..=21_600.0).contains(&query.duration)
        || query.season.is_some() != query.episode.is_some()
        || query.season == Some(0)
        || query.episode == Some(0)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let input = safe_library_path(&state.library_root, &query.video_path)?;
    let metadata = tokio::fs::metadata(&input)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !metadata.is_file() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_secs());
    let identity = SkipSegmentIdentity {
        video_path: query.video_path.clone(),
        imdb_id: query.imdb_id.clone(),
        season: query.season,
        episode: query.episode,
        duration: (query.duration * 1000.0).round() / 1000.0,
        file_size: metadata.len(),
        modified_at,
    };
    let cache_key = skip_cache_key(&identity);
    if !query.refresh {
        if let Some(mut cached) = read_skip_segments_cache(&state.skip_segments_path)
            .await
            .entries
            .remove(&cache_key)
            .filter(|entry| {
                unix_now().saturating_sub(entry.fetched_at) < SKIP_SEGMENTS_CACHE_SECONDS
            })
        {
            cached.cache_status = "hit".to_owned();
            tracing::info!(
                target: "tms_server::playback",
                video_path = %query.video_path,
                imdb_id = %query.imdb_id,
                provider_count = cached.providers.len(),
                decisions = cached.segments.len(),
                "Skip-segment lookup served from cache"
            );
            return Ok(Json(cached));
        }
    }

    tracing::info!(
        target: "tms_server::playback",
        video_path = %query.video_path,
        imdb_id = %query.imdb_id,
        season = ?query.season,
        episode = ?query.episode,
        refresh = query.refresh,
        "Skip-segment lookup started"
    );

    let (the_intro_db, intro_db, aniskip, local_chapters, local_fingerprint) = tokio::join!(
        fetch_the_intro_db(&state.http, &identity),
        fetch_intro_db_app(&state.http, &identity),
        fetch_aniskip(&state.http, &identity),
        inspect_skip_chapters(&state, &input, identity.duration),
        inspect_local_fingerprint(&state, &input, &identity),
    );
    let providers = vec![
        the_intro_db,
        intro_db,
        aniskip,
        local_chapters,
        local_fingerprint,
    ];
    let segments = decide_skip_segments(&providers, identity.duration);
    let provider_summary = providers
        .iter()
        .map(|provider| {
            format!(
                "{}:{}:{}",
                provider.provider,
                provider.status,
                provider.segments.len()
            )
        })
        .collect::<Vec<_>>();
    let response = SkipSegmentsResponse {
        identity,
        providers,
        segments,
        fetched_at: unix_now(),
        cache_status: if query.refresh { "refreshed" } else { "miss" }.to_owned(),
    };
    {
        let _guard = state.persistence_lock.lock().await;
        let mut cache = read_skip_segments_cache(&state.skip_segments_path).await;
        cache.entries.insert(cache_key, response.clone());
        if cache.entries.len() > 5_000 {
            let mut oldest = cache
                .entries
                .iter()
                .map(|(key, value)| (key.clone(), value.fetched_at))
                .collect::<Vec<_>>();
            oldest.sort_by_key(|(_, fetched_at)| *fetched_at);
            for (key, _) in oldest.into_iter().take(cache.entries.len() - 5_000) {
                cache.entries.remove(&key);
            }
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&cache) {
            if let Err(error) = tokio::fs::write(&state.skip_segments_path, bytes).await {
                tracing::warn!(%error, "Could not persist skip-segment evidence");
            }
        }
    }
    tracing::info!(
        target: "tms_server::playback",
        video_path = %query.video_path,
        imdb_id = %query.imdb_id,
        providers = ?provider_summary,
        decisions = response.segments.len(),
        "Skip-segment evidence collected"
    );
    Ok(Json(response))
}

fn valid_imdb_id(value: &str) -> bool {
    matches!(value.len(), 9 | 10)
        && value.starts_with("tt")
        && value[2..].bytes().all(|byte| byte.is_ascii_digit())
}

fn anizip_season_number(entry: &Value) -> Option<u32> {
    entry
        .get("seasonNumber")
        .and_then(Value::as_u64)
        .or_else(|| entry.get("season").and_then(Value::as_u64))
        .and_then(|value| u32::try_from(value).ok())
}

fn anizip_episode_number(entry: &Value) -> Option<u32> {
    entry
        .get("episodeNumber")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .or_else(|| {
            entry
                .get("episode")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
        })
        .or_else(|| {
            entry
                .get("episode")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<u32>().ok())
        })
}

fn anizip_absolute_episode(entry: &Value) -> Option<u64> {
    entry
        .get("absoluteEpisodeNumber")
        .and_then(Value::as_u64)
        .or_else(|| {
            entry
                .get("episode")
                .and_then(Value::as_str)
                .filter(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
                .and_then(|value| value.parse::<u64>().ok())
        })
        .or_else(|| entry.get("episode").and_then(Value::as_u64))
}

fn absolute_episode_from_anizip(mapping: &Value, season: u32, episode: u32) -> Option<u64> {
    let episodes = mapping.get("episodes")?.as_object()?;
    for entry in episodes.values() {
        if anizip_season_number(entry) == Some(season)
            && anizip_episode_number(entry) == Some(episode)
        {
            return anizip_absolute_episode(entry);
        }
    }
    if season <= 1 {
        if let Some(entry) = episodes.get(&episode.to_string()) {
            return anizip_absolute_episode(entry).or(Some(u64::from(episode)));
        }
        return Some(u64::from(episode));
    }
    let prior = episodes
        .values()
        .filter(|entry| {
            anizip_season_number(entry).is_some_and(|value| value > 0 && value < season)
                && anizip_episode_number(entry).is_some()
        })
        .count() as u64;
    (prior > 0).then_some(prior + u64::from(episode))
}

fn skip_cache_key(identity: &SkipSegmentIdentity) -> String {
    let mut digest = Sha256::new();
    digest.update(identity.video_path.as_bytes());
    digest.update(identity.imdb_id.as_bytes());
    digest.update(identity.season.unwrap_or_default().to_le_bytes());
    digest.update(identity.episode.unwrap_or_default().to_le_bytes());
    digest.update(identity.duration.to_bits().to_le_bytes());
    digest.update(identity.file_size.to_le_bytes());
    digest.update(identity.modified_at.to_le_bytes());
    format!("{:x}", digest.finalize())
}

async fn read_skip_segments_cache(path: &Path) -> SkipSegmentsCache {
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

async fn fetch_the_intro_db(
    http: &reqwest::Client,
    identity: &SkipSegmentIdentity,
) -> SkipProviderEvidence {
    let started = Instant::now();
    if !valid_imdb_id(&identity.imdb_id) {
        return SkipProviderEvidence {
            provider: "theintrodb.org".to_owned(),
            status: "not_applicable".to_owned(),
            latency_ms: 0,
            segments: Vec::new(),
            error: None,
            raw: None,
        };
    }
    let mut url = match reqwest::Url::parse("https://api.theintrodb.org/v3/media") {
        Ok(url) => url,
        Err(error) => return provider_error("theintrodb.org", started, error.to_string()),
    };
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("imdb_id", &identity.imdb_id)
            .append_pair("duration_ms", &format!("{:.0}", identity.duration * 1000.0));
        if let (Some(season), Some(episode)) = (identity.season, identity.episode) {
            pairs
                .append_pair("season", &season.to_string())
                .append_pair("episode", &episode.to_string());
        }
    }
    let response = match http.get(url).send().await {
        Ok(response) => response,
        Err(error) => return provider_error("theintrodb.org", started, error.to_string()),
    };
    if response.status() == StatusCode::NOT_FOUND {
        return provider_miss("theintrodb.org", started);
    }
    if !response.status().is_success() {
        return provider_error(
            "theintrodb.org",
            started,
            format!("HTTP {}", response.status()),
        );
    }
    let raw: Value = match response.json().await {
        Ok(raw) => raw,
        Err(error) => return provider_error("theintrodb.org", started, error.to_string()),
    };
    let mut segments = Vec::new();
    for (source_key, kind) in [
        ("intro", "intro"),
        ("recap", "recap"),
        ("credits", "credits"),
        ("preview", "preview"),
    ] {
        for item in raw
            .get(source_key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let start = item
                .get("start_ms")
                .and_then(Value::as_f64)
                .map(|value| value / 1000.0)
                .unwrap_or(0.0);
            let end = item
                .get("end_ms")
                .and_then(Value::as_f64)
                .map(|value| value / 1000.0)
                .unwrap_or(identity.duration);
            if let Some(segment) = normalized_skip_evidence(kind, start, end, identity.duration) {
                segments.push(segment);
            }
        }
    }
    provider_success("theintrodb.org", started, segments, raw)
}

async fn fetch_intro_db_app(
    http: &reqwest::Client,
    identity: &SkipSegmentIdentity,
) -> SkipProviderEvidence {
    let started = Instant::now();
    if !valid_imdb_id(&identity.imdb_id) {
        return SkipProviderEvidence {
            provider: "introdb.app".to_owned(),
            status: "not_applicable".to_owned(),
            latency_ms: 0,
            segments: Vec::new(),
            error: None,
            raw: None,
        };
    }
    let (Some(season), Some(episode)) = (identity.season, identity.episode) else {
        return SkipProviderEvidence {
            provider: "introdb.app".to_owned(),
            status: "not_applicable".to_owned(),
            latency_ms: 0,
            segments: Vec::new(),
            error: None,
            raw: None,
        };
    };
    let mut url = match reqwest::Url::parse("https://api.introdb.app/segments") {
        Ok(url) => url,
        Err(error) => return provider_error("introdb.app", started, error.to_string()),
    };
    url.query_pairs_mut()
        .append_pair("imdb_id", &identity.imdb_id)
        .append_pair("season", &season.to_string())
        .append_pair("episode", &episode.to_string());
    let response = match http.get(url).send().await {
        Ok(response) => response,
        Err(error) => return provider_error("introdb.app", started, error.to_string()),
    };
    if response.status() == StatusCode::NOT_FOUND {
        return provider_miss("introdb.app", started);
    }
    if !response.status().is_success() {
        return provider_error(
            "introdb.app",
            started,
            format!("HTTP {}", response.status()),
        );
    }
    let raw: Value = match response.json().await {
        Ok(raw) => raw,
        Err(error) => return provider_error("introdb.app", started, error.to_string()),
    };
    let mut segments = Vec::new();
    for (source_key, kind) in [("intro", "intro"), ("recap", "recap"), ("outro", "credits")] {
        let Some(item) = raw.get(source_key).filter(|item| !item.is_null()) else {
            continue;
        };
        let start = item
            .get("start_sec")
            .and_then(Value::as_f64)
            .or_else(|| {
                item.get("start_ms")
                    .and_then(Value::as_f64)
                    .map(|value| value / 1000.0)
            })
            .unwrap_or(0.0);
        let end = item
            .get("end_sec")
            .and_then(Value::as_f64)
            .or_else(|| {
                item.get("end_ms")
                    .and_then(Value::as_f64)
                    .map(|value| value / 1000.0)
            })
            .unwrap_or(identity.duration);
        if let Some(mut segment) = normalized_skip_evidence(kind, start, end, identity.duration) {
            segment.provider_confidence = item.get("confidence").and_then(Value::as_f64);
            segment.submission_count = item.get("submission_count").and_then(Value::as_u64);
            segments.push(segment);
        }
    }
    provider_success("introdb.app", started, segments, raw)
}

async fn fetch_aniskip(
    http: &reqwest::Client,
    identity: &SkipSegmentIdentity,
) -> SkipProviderEvidence {
    let started = Instant::now();
    let (Some(season), Some(episode)) = (identity.season, identity.episode) else {
        return SkipProviderEvidence {
            provider: "aniskip.com".to_owned(),
            status: "not_applicable".to_owned(),
            latency_ms: 0,
            segments: Vec::new(),
            error: None,
            raw: None,
        };
    };
    if !valid_imdb_id(&identity.imdb_id) {
        return SkipProviderEvidence {
            provider: "aniskip.com".to_owned(),
            status: "not_applicable".to_owned(),
            latency_ms: 0,
            segments: Vec::new(),
            error: None,
            raw: None,
        };
    }
    let mapping_url = format!(
        "https://api.ani.zip/mappings?imdb_id={}",
        urlencoding::encode(&identity.imdb_id)
    );
    let mapping: Value = match http.get(mapping_url).send().await {
        Ok(response) if response.status() == StatusCode::NOT_FOUND => {
            return provider_miss("aniskip.com", started);
        }
        Ok(response) if response.status().is_success() => match response.json().await {
            Ok(raw) => raw,
            Err(error) => return provider_error("aniskip.com", started, error.to_string()),
        },
        Ok(response) => {
            return provider_error(
                "aniskip.com",
                started,
                format!("ani.zip HTTP {}", response.status()),
            );
        }
        Err(error) => return provider_error("aniskip.com", started, error.to_string()),
    };
    let Some(mal_id) = mapping
        .pointer("/mappings/mal_id")
        .and_then(Value::as_u64)
        .or_else(|| mapping.get("mal_id").and_then(Value::as_u64))
    else {
        return provider_miss("aniskip.com", started);
    };
    let Some(absolute_episode) = absolute_episode_from_anizip(&mapping, season, episode) else {
        return provider_success(
            "aniskip.com",
            started,
            Vec::new(),
            serde_json::json!({
                "mal_id": mal_id,
                "reason": "Could not map season/episode to an absolute AniSkip episode number",
                "season": season,
                "episode": episode,
                "mapping": mapping,
            }),
        );
    };
    let mut url = match reqwest::Url::parse(&format!(
        "https://api.aniskip.com/v2/skip-times/{mal_id}/{absolute_episode}"
    )) {
        Ok(url) => url,
        Err(error) => return provider_error("aniskip.com", started, error.to_string()),
    };
    {
        let mut pairs = url.query_pairs_mut();
        for skip_type in ["op", "ed", "mixed-op", "mixed-ed", "recap"] {
            pairs.append_pair("types", skip_type);
        }
        pairs.append_pair("episodeLength", &format!("{:.0}", identity.duration));
    }
    let response = match http.get(url).send().await {
        Ok(response) => response,
        Err(error) => return provider_error("aniskip.com", started, error.to_string()),
    };
    if response.status() == StatusCode::NOT_FOUND {
        return provider_success(
            "aniskip.com",
            started,
            Vec::new(),
            serde_json::json!({
                "mal_id": mal_id,
                "absolute_episode": absolute_episode,
                "found": false,
            }),
        );
    }
    if !response.status().is_success() {
        return provider_error(
            "aniskip.com",
            started,
            format!("HTTP {}", response.status()),
        );
    }
    let raw: Value = match response.json().await {
        Ok(raw) => raw,
        Err(error) => return provider_error("aniskip.com", started, error.to_string()),
    };
    let mut segments = Vec::new();
    for item in raw
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let skip_type = item.get("skipType").and_then(Value::as_str).unwrap_or("");
        let kind = match skip_type {
            "op" | "mixed-op" => "intro",
            "ed" | "mixed-ed" => "credits",
            "recap" => "recap",
            _ => continue,
        };
        let start = item
            .pointer("/interval/startTime")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let end = item
            .pointer("/interval/endTime")
            .and_then(Value::as_f64)
            .unwrap_or(identity.duration);
        if let Some(mut segment) = normalized_skip_evidence(kind, start, end, identity.duration) {
            segment.label = Some(format!("AniSkip {skip_type}"));
            segments.push(segment);
        }
    }
    provider_success(
        "aniskip.com",
        started,
        segments,
        serde_json::json!({
            "mal_id": mal_id,
            "absolute_episode": absolute_episode,
            "aniskip": raw,
        }),
    )
}

async fn inspect_skip_chapters(
    state: &AppState,
    input: &Path,
    duration: f64,
) -> SkipProviderEvidence {
    let started = Instant::now();
    let output = match hidden_async_command(&state.ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_chapters",
            "-show_entries",
            "chapter=start_time,end_time:chapter_tags=title",
            "-of",
            "json",
        ])
        .arg(input)
        .output()
        .await
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return provider_error(
                "local_chapters",
                started,
                format!("ffprobe exited with {:?}", output.status.code()),
            );
        }
        Err(error) => return provider_error("local_chapters", started, error.to_string()),
    };
    let raw: Value = match serde_json::from_slice(&output.stdout) {
        Ok(raw) => raw,
        Err(error) => return provider_error("local_chapters", started, error.to_string()),
    };
    let mut segments = Vec::new();
    for chapter in raw
        .get("chapters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(label) = chapter
            .get("tags")
            .and_then(|tags| tags.get("title"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
        else {
            continue;
        };
        let Some(kind) = chapter_segment_kind(label) else {
            continue;
        };
        let start = chapter
            .get("start_time")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let end = chapter
            .get("end_time")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(duration);
        if let Some(mut segment) = normalized_skip_evidence(kind, start, end, duration) {
            segment.label = Some(label.to_owned());
            segments.push(segment);
        }
    }
    if segments.is_empty() {
        SkipProviderEvidence {
            provider: "local_chapters".to_owned(),
            status: "miss".to_owned(),
            latency_ms: started.elapsed().as_millis() as u64,
            segments,
            error: None,
            raw: Some(raw),
        }
    } else {
        provider_success("local_chapters", started, segments, raw)
    }
}

fn chapter_segment_kind(label: &str) -> Option<&'static str> {
    let label = label.to_ascii_lowercase();
    if label.contains("opening credits")
        || label.contains("intro")
        || label == "op"
        || label.starts_with("opening")
    {
        Some("intro")
    } else if label.contains("recap") || label.contains("previously") {
        Some("recap")
    } else if label.contains("preview") || label.contains("next time") {
        Some("preview")
    } else if label.contains("credit")
        || label.contains("outro")
        || label == "ed"
        || label.starts_with("ending")
    {
        Some("credits")
    } else {
        None
    }
}

const CHROMAPRINT_SAMPLE_DURATION: f64 = 4096.0 / 11_025.0 / 3.0;
const LOCAL_INTRO_ANALYSIS_LIMIT_SECONDS: f64 = 600.0;
const LOCAL_INTRO_MINIMUM_ANCHOR_SECONDS: f64 = 6.0;
const LOCAL_INTRO_MAXIMUM_POINT_GAP_SECONDS: f64 = 3.5;

async fn inspect_local_fingerprint(
    state: &AppState,
    input: &Path,
    identity: &SkipSegmentIdentity,
) -> SkipProviderEvidence {
    let started = Instant::now();
    if identity.season.is_none() || identity.episode.is_none() {
        return SkipProviderEvidence {
            provider: "local_fingerprint".to_owned(),
            status: "not_applicable".to_owned(),
            latency_ms: 0,
            segments: Vec::new(),
            error: None,
            raw: None,
        };
    }
    if !state.ffmpeg_path.is_file() {
        return provider_error(
            "local_fingerprint",
            started,
            format!("FFmpeg was not found at {}", state.ffmpeg_path.display()),
        );
    }
    let analysis_seconds = (identity.duration * 0.25)
        .min(LOCAL_INTRO_ANALYSIS_LIMIT_SECONDS)
        .max(30.0);
    let peers = match sibling_episode_paths(input).await {
        Ok(peers) => peers,
        Err(error) => return provider_error("local_fingerprint", started, error),
    };
    if peers.is_empty() {
        return provider_success(
            "local_fingerprint",
            started,
            Vec::new(),
            serde_json::json!({
                "algorithm": "chromaprint_with_black_frame_boundaries",
                "analysis_seconds": analysis_seconds,
                "reason": "At least two episodes in the same season folder are required",
            }),
        );
    }

    let (target_points, target_cache_hit) =
        match local_fingerprint_points(state, input, analysis_seconds).await {
            Ok(points) => points,
            Err(error) => return provider_error("local_fingerprint", started, error),
        };
    let mut matches = Vec::new();
    let mut peer_names = Vec::new();
    let mut cache_hits = usize::from(target_cache_hit);
    let mut peer_errors = Vec::new();
    let concurrency = Arc::new(tokio::sync::Semaphore::new(3));
    let mut tasks = tokio::task::JoinSet::new();
    let selected_peers = select_fingerprint_peers(&peers, 24);
    for (index, peer) in selected_peers.into_iter().enumerate() {
        let task_state = state.clone();
        let permit = concurrency.clone();
        tasks.spawn(async move {
            let _permit = permit.acquire_owned().await;
            let result = local_fingerprint_points(&task_state, &peer, analysis_seconds).await;
            (index, peer, result)
        });
    }
    let mut peer_results = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(result) => peer_results.push(result),
            Err(error) => peer_errors.push(serde_json::json!({
                "error": format!("Fingerprint worker failed: {error}"),
            })),
        }
    }
    peer_results.sort_by_key(|(index, _, _)| *index);
    for (_, peer, result) in peer_results {
        match result {
            Ok((peer_points, cache_hit)) => {
                cache_hits += usize::from(cache_hit);
                if let Some(range) = compare_local_fingerprints(&target_points, &peer_points) {
                    matches.push(range);
                    peer_names.push(
                        peer.file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("episode")
                            .to_owned(),
                    );
                }
            }
            Err(error) => peer_errors.push(serde_json::json!({
                "file": peer.file_name().and_then(|value| value.to_str()),
                "error": error,
            })),
        }
    }

    let match_raw = matches
        .iter()
        .enumerate()
        .map(|(index, range)| {
            serde_json::json!({
                "peer": peer_names.get(index),
                "target_start": range.target_start,
                "target_end": range.target_end,
                "peer_start": range.peer_start,
                "peer_end": range.peer_end,
            })
        })
        .collect::<Vec<_>>();
    let Some((anchor, agreeing_indexes)) = best_fingerprint_cluster(&matches) else {
        return provider_success(
            "local_fingerprint",
            started,
            Vec::new(),
            serde_json::json!({
                "algorithm": "chromaprint_with_black_frame_boundaries",
                "analysis_seconds": analysis_seconds,
                "fingerprint_cache_hits": cache_hits,
                "matches": match_raw,
                "peer_errors": peer_errors,
                "reason": "No recurring audio anchor of at least six seconds was found",
            }),
        );
    };

    let boundary_search_start = (anchor.target_start - 20.0).max(0.0);
    let boundary_search_end = (anchor.target_end + 90.0).min(analysis_seconds);
    let black_intervals = match detect_black_intervals(
        state,
        input,
        boundary_search_start,
        boundary_search_end,
    )
    .await
    {
        Ok(intervals) => intervals,
        Err(error) => {
            return provider_error(
                "local_fingerprint",
                started,
                format!("Audio anchor found, but boundary detection failed: {error}"),
            );
        }
    };
    let black_boundary =
        refine_intro_from_black_intervals(anchor, &black_intervals, identity.duration);
    let boundary =
        black_boundary.or_else(|| fallback_intro_from_audio_anchor(anchor, identity.duration));
    let black_raw = black_intervals
        .iter()
        .map(|interval| {
            serde_json::json!({
                "start": interval.start,
                "end": interval.end,
                "duration": interval.end - interval.start,
            })
        })
        .collect::<Vec<_>>();
    let agreeing_peers = agreeing_indexes
        .iter()
        .filter_map(|index| peer_names.get(*index))
        .cloned()
        .collect::<Vec<_>>();
    let mut segments = Vec::new();
    if let Some((start, end)) = boundary {
        if let Some(mut segment) = normalized_skip_evidence("intro", start, end, identity.duration)
        {
            let corroboration = agreeing_indexes.len() as u64;
            segment.provider_confidence =
                Some((0.78 + corroboration.min(4) as f64 * 0.04).min(0.94));
            segment.label = Some(if black_boundary.is_some() {
                format!("Chromaprint + black-frame boundaries ({corroboration} episode matches)")
            } else {
                format!("Chromaprint audio anchor ({corroboration} episode matches)")
            });
            segments.push(segment);
        }
    }
    provider_success(
        "local_fingerprint",
        started,
        segments,
        serde_json::json!({
            "algorithm": "chromaprint_with_black_frame_boundaries",
            "analysis_seconds": analysis_seconds,
            "fingerprint_sample_seconds": CHROMAPRINT_SAMPLE_DURATION,
            "fingerprint_cache_hits": cache_hits,
            "audio_anchor": {
                "start": anchor.target_start,
                "end": anchor.target_end,
            },
            "agreeing_peers": agreeing_peers,
            "matches": match_raw,
            "black_intervals": black_raw,
            "boundary": boundary.map(|(start, end)| serde_json::json!({
                "start": start,
                "end": end,
            })),
            "peer_errors": peer_errors,
            "safety": "Local analysis remains one provider; peer matches do not count as independent providers",
        }),
    )
}

async fn sibling_episode_paths(input: &Path) -> Result<Vec<PathBuf>, String> {
    let parent = input
        .parent()
        .ok_or_else(|| "Episode has no season folder".to_owned())?;
    let mut entries = tokio::fs::read_dir(parent)
        .await
        .map_err(|error| format!("Could not read season folder: {error}"))?;
    let mut peers = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("Could not inspect season folder: {error}"))?
    {
        let path = entry.path();
        if path != input
            && entry.file_type().await.is_ok_and(|kind| kind.is_file())
            && is_video_file(&path)
        {
            peers.push(path);
        }
    }
    peers.sort();
    Ok(peers)
}

fn select_fingerprint_peers(peers: &[PathBuf], limit: usize) -> Vec<PathBuf> {
    if peers.len() <= limit {
        return peers.to_vec();
    }
    if limit <= 1 {
        return peers.first().cloned().into_iter().collect();
    }
    (0..limit)
        .map(|index| {
            let position = index * (peers.len() - 1) / (limit - 1);
            peers[position].clone()
        })
        .collect()
}

async fn local_fingerprint_points(
    state: &AppState,
    input: &Path,
    analysis_seconds: f64,
) -> Result<(Vec<u32>, bool), String> {
    let metadata = tokio::fs::metadata(input)
        .await
        .map_err(|error| format!("Could not inspect {}: {error}", input.display()))?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_secs());
    let mut digest = Sha256::new();
    digest.update(b"tms-local-chromaprint-v1");
    digest.update(input.as_os_str().to_string_lossy().as_bytes());
    digest.update(metadata.len().to_le_bytes());
    digest.update(modified_at.to_le_bytes());
    digest.update(analysis_seconds.round().to_bits().to_le_bytes());
    let cache_path = state
        .skip_fingerprints_dir
        .join(format!("{:x}.fp", digest.finalize()));
    if let Ok(bytes) = tokio::fs::read(&cache_path).await {
        if let Some(points) = decode_fingerprint_points(&bytes) {
            return Ok((points, true));
        }
    }

    let mut command = hidden_async_command(&state.ffmpeg_path);
    command.args(["-v", "error", "-i"]).arg(input).args([
        "-t",
        &format!("{analysis_seconds:.3}"),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "11025",
        "-f",
        "chromaprint",
        "-fp_format",
        "raw",
        "pipe:1",
    ]);
    let output = tokio::time::timeout(Duration::from_secs(45), command.output())
        .await
        .map_err(|_| format!("Chromaprint timed out for {}", input.display()))?
        .map_err(|error| format!("Could not start FFmpeg for {}: {error}", input.display()))?;
    if !output.status.success() {
        return Err(format!(
            "Chromaprint failed for {}: {}",
            input.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let points = decode_fingerprint_points(&output.stdout).ok_or_else(|| {
        format!(
            "Chromaprint returned malformed data for {}",
            input.display()
        )
    })?;
    tokio::fs::create_dir_all(&state.skip_fingerprints_dir)
        .await
        .map_err(|error| format!("Could not create fingerprint cache: {error}"))?;
    if let Err(error) = tokio::fs::write(&cache_path, &output.stdout).await {
        tracing::warn!(%error, path = %cache_path.display(), "Could not cache local fingerprint");
    }
    Ok((points, false))
}

fn decode_fingerprint_points(bytes: &[u8]) -> Option<Vec<u32>> {
    if bytes.len() < 4 || bytes.len() % 4 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect(),
    )
}

fn compare_local_fingerprints(target: &[u32], peer: &[u32]) -> Option<FingerprintRange> {
    if target.is_empty() || peer.is_empty() {
        return None;
    }
    let mut target_index = HashMap::new();
    let mut peer_index = HashMap::new();
    for (index, point) in target.iter().copied().enumerate() {
        target_index.insert(point, index);
    }
    for (index, point) in peer.iter().copied().enumerate() {
        peer_index.insert(point, index);
    }
    let mut shifts = BTreeSet::new();
    for (point, target_position) in &target_index {
        for delta in -2_i32..=2 {
            let modified = if delta < 0 {
                point.wrapping_sub(delta.unsigned_abs())
            } else {
                point.wrapping_add(delta as u32)
            };
            if let Some(peer_position) = peer_index.get(&modified) {
                shifts.insert(*peer_position as isize - *target_position as isize);
            }
        }
    }

    let maximum_gap_points =
        (LOCAL_INTRO_MAXIMUM_POINT_GAP_SECONDS / CHROMAPRINT_SAMPLE_DURATION).ceil() as usize;
    let mut best = None;
    for shift in shifts {
        let target_offset = if shift < 0 { (-shift) as usize } else { 0 };
        let peer_offset = if shift > 0 { shift as usize } else { 0 };
        let upper_limit = target
            .len()
            .saturating_sub(target_offset)
            .min(peer.len().saturating_sub(peer_offset));
        let mut current_start = None;
        let mut previous = 0_usize;
        for position in 0..upper_limit {
            let target_position = position + target_offset;
            let peer_position = position + peer_offset;
            if (target[target_position] ^ peer[peer_position]).count_ones() > 6 {
                continue;
            }
            if current_start.is_some()
                && target_position.saturating_sub(previous) > maximum_gap_points
            {
                update_best_fingerprint_range(
                    &mut best,
                    current_start.take().unwrap_or(previous),
                    previous,
                    shift,
                );
            }
            current_start.get_or_insert(target_position);
            previous = target_position;
        }
        if let Some(start) = current_start {
            update_best_fingerprint_range(&mut best, start, previous, shift);
        }
    }
    best.filter(|range: &FingerprintRange| {
        range.target_end - range.target_start >= LOCAL_INTRO_MINIMUM_ANCHOR_SECONDS
    })
}

fn update_best_fingerprint_range(
    best: &mut Option<FingerprintRange>,
    target_start: usize,
    target_end: usize,
    shift: isize,
) {
    let peer_start = (target_start as isize + shift).max(0) as usize;
    let peer_end = (target_end as isize + shift).max(0) as usize;
    let candidate = FingerprintRange {
        target_start: target_start as f64 * CHROMAPRINT_SAMPLE_DURATION,
        target_end: target_end as f64 * CHROMAPRINT_SAMPLE_DURATION,
        peer_start: peer_start as f64 * CHROMAPRINT_SAMPLE_DURATION,
        peer_end: peer_end as f64 * CHROMAPRINT_SAMPLE_DURATION,
    };
    if best.is_none_or(|saved| {
        candidate.target_end - candidate.target_start > saved.target_end - saved.target_start
    }) {
        *best = Some(candidate);
    }
}

fn best_fingerprint_cluster(
    matches: &[FingerprintRange],
) -> Option<(FingerprintRange, Vec<usize>)> {
    let mut best_indexes: Vec<usize> = Vec::new();
    for (seed_index, seed) in matches.iter().enumerate() {
        let indexes = matches
            .iter()
            .enumerate()
            .filter(|(_, candidate)| {
                (candidate.target_start - seed.target_start).abs() <= 4.0
                    && (candidate.target_end - seed.target_end).abs() <= 4.0
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let duration = seed.target_end - seed.target_start;
        let best_duration = best_indexes
            .first()
            .map(|index| {
                let saved = matches[*index];
                saved.target_end - saved.target_start
            })
            .unwrap_or(0.0);
        if indexes.len() > best_indexes.len()
            || (indexes.len() == best_indexes.len() && duration > best_duration)
        {
            best_indexes = indexes;
        } else if seed_index == 0 && best_indexes.is_empty() {
            best_indexes.push(0);
        }
    }
    if best_indexes.is_empty() {
        return None;
    }
    let count = best_indexes.len() as f64;
    let target_start = best_indexes
        .iter()
        .map(|index| matches[*index].target_start)
        .sum::<f64>()
        / count;
    let target_end = best_indexes
        .iter()
        .map(|index| matches[*index].target_end)
        .sum::<f64>()
        / count;
    Some((
        FingerprintRange {
            target_start,
            target_end,
            peer_start: 0.0,
            peer_end: 0.0,
        },
        best_indexes,
    ))
}

async fn detect_black_intervals(
    state: &AppState,
    input: &Path,
    search_start: f64,
    search_end: f64,
) -> Result<Vec<BlackInterval>, String> {
    let search_duration = (search_end - search_start).max(1.0);
    let mut command = hidden_async_command(&state.ffmpeg_path);
    command
        .args(["-hide_banner", "-ss", &format!("{search_start:.3}"), "-i"])
        .arg(input)
        .args([
            "-t",
            &format!("{search_duration:.3}"),
            "-an",
            "-vf",
            "blackdetect=d=0.15:pix_th=0.10",
            "-f",
            "null",
            "NUL",
        ]);
    let output = tokio::time::timeout(Duration::from_secs(45), command.output())
        .await
        .map_err(|_| format!("Black-frame detection timed out for {}", input.display()))?
        .map_err(|error| format!("Could not start black-frame detection: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "FFmpeg exited with {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(
        parse_black_intervals(&String::from_utf8_lossy(&output.stderr))
            .into_iter()
            .map(|interval| BlackInterval {
                start: interval.start + search_start,
                end: interval.end + search_start,
            })
            .collect(),
    )
}

fn parse_black_intervals(output: &str) -> Vec<BlackInterval> {
    output
        .lines()
        .filter_map(|line| {
            let mut start = None;
            let mut end = None;
            for item in line.split_ascii_whitespace() {
                if let Some(value) = item.strip_prefix("black_start:") {
                    start = value.parse::<f64>().ok();
                } else if let Some(value) = item.strip_prefix("black_end:") {
                    end = value.parse::<f64>().ok();
                }
            }
            let (Some(start), Some(end)) = (start, end) else {
                return None;
            };
            (end > start).then_some(BlackInterval { start, end })
        })
        .collect()
}

fn refine_intro_from_black_intervals(
    anchor: FingerprintRange,
    intervals: &[BlackInterval],
    duration: f64,
) -> Option<(f64, f64)> {
    const MIN_BLACK_SECONDS: f64 = 0.3;
    let start_boundary = intervals
        .iter()
        .filter(|interval| {
            interval.end - interval.start >= MIN_BLACK_SECONDS
                && interval.start <= anchor.target_start
                && interval.end >= anchor.target_start - 20.0
        })
        .max_by(|left, right| left.start.total_cmp(&right.start))
        .map(|interval| interval.start)
        .or_else(|| (anchor.target_start <= 2.0).then_some(0.0))?;
    let end_boundary = intervals
        .iter()
        .filter(|interval| {
            interval.end - interval.start >= MIN_BLACK_SECONDS
                && interval.start >= anchor.target_end - 1.5
                && interval.start <= anchor.target_end + 90.0
        })
        .min_by(|left, right| left.start.total_cmp(&right.start))
        .map(|interval| interval.end)?;
    let start = start_boundary.clamp(0.0, duration);
    let end = end_boundary.clamp(start, duration);
    ((8.0..=150.0).contains(&(end - start))).then_some((start, end))
}

fn fallback_intro_from_audio_anchor(anchor: FingerprintRange, duration: f64) -> Option<(f64, f64)> {
    let start = if anchor.target_start <= 2.0 {
        0.0
    } else {
        anchor.target_start
    }
    .clamp(0.0, duration);
    let end = anchor.target_end.clamp(start, duration);
    ((8.0..=150.0).contains(&(end - start))).then_some((start, end))
}

fn normalized_skip_evidence(
    kind: &str,
    start: f64,
    end: f64,
    duration: f64,
) -> Option<SkipSegmentEvidence> {
    if !start.is_finite() || !end.is_finite() {
        return None;
    }
    let start = start.clamp(0.0, duration);
    let end = end.clamp(0.0, duration);
    let segment_duration = end - start;
    let maximum = match kind {
        "intro" => 240.0,
        "recap" => 1_200.0,
        "credits" | "preview" => 1_800.0,
        _ => return None,
    };
    if segment_duration < 1.0 || segment_duration > maximum {
        return None;
    }
    Some(SkipSegmentEvidence {
        kind: kind.to_owned(),
        start,
        end,
        provider_confidence: None,
        submission_count: None,
        label: None,
    })
}

fn provider_success(
    provider: &str,
    started: Instant,
    segments: Vec<SkipSegmentEvidence>,
    raw: Value,
) -> SkipProviderEvidence {
    SkipProviderEvidence {
        provider: provider.to_owned(),
        status: if segments.is_empty() {
            "miss"
        } else {
            "success"
        }
        .to_owned(),
        latency_ms: started.elapsed().as_millis() as u64,
        segments,
        error: None,
        raw: Some(raw),
    }
}

fn provider_miss(provider: &str, started: Instant) -> SkipProviderEvidence {
    SkipProviderEvidence {
        provider: provider.to_owned(),
        status: "miss".to_owned(),
        latency_ms: started.elapsed().as_millis() as u64,
        segments: Vec::new(),
        error: None,
        raw: None,
    }
}

fn provider_error(provider: &str, started: Instant, error: String) -> SkipProviderEvidence {
    SkipProviderEvidence {
        provider: provider.to_owned(),
        status: "error".to_owned(),
        latency_ms: started.elapsed().as_millis() as u64,
        segments: Vec::new(),
        error: Some(error),
        raw: None,
    }
}

fn decide_skip_segments(
    providers: &[SkipProviderEvidence],
    duration: f64,
) -> Vec<SkipSegmentDecision> {
    let mut candidates = providers
        .iter()
        .flat_map(|provider| {
            provider
                .segments
                .iter()
                .cloned()
                .map(|segment| (provider.provider.clone(), segment))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.1
            .kind
            .cmp(&right.1.kind)
            .then_with(|| left.1.start.total_cmp(&right.1.start))
    });
    let mut used = vec![false; candidates.len()];
    let mut decisions = Vec::new();
    for index in 0..candidates.len() {
        if used[index] {
            continue;
        }
        used[index] = true;
        let (_, seed) = &candidates[index];
        let tolerance = if seed.kind == "credits" { 15.0 } else { 8.0 };
        let mut cluster = vec![index];
        for other in index + 1..candidates.len() {
            if used[other]
                || candidates[other].1.kind != seed.kind
                || (candidates[other].1.start - seed.start).abs() > tolerance
                || (candidates[other].1.end - seed.end).abs() > tolerance
            {
                continue;
            }
            used[other] = true;
            cluster.push(other);
        }
        let mut unique_providers = BTreeSet::new();
        let mut weighted_start = 0.0;
        let mut weighted_end = 0.0;
        let mut total_weight = 0.0;
        for candidate in &cluster {
            let (provider, evidence) = &candidates[*candidate];
            unique_providers.insert(provider.clone());
            let weight = match provider.as_str() {
                "local_chapters" => 1.15,
                "local_fingerprint" => 1.1,
                "theintrodb.org" => 1.0,
                "aniskip.com" => 0.95,
                "introdb.app" => 0.9,
                _ => 0.75,
            };
            weighted_start += evidence.start * weight;
            weighted_end += evidence.end * weight;
            total_weight += weight;
        }
        let agreement = unique_providers.len();
        let best_evidence_confidence = cluster
            .iter()
            .filter_map(|candidate| candidates[*candidate].1.provider_confidence)
            .fold(0.0_f64, f64::max);
        let best_submission_count = cluster
            .iter()
            .filter_map(|candidate| candidates[*candidate].1.submission_count)
            .max()
            .unwrap_or(0);
        let confidence = if agreement >= 2 {
            (0.92 + (agreement.saturating_sub(2) as f64 * 0.035)).min(0.99)
        } else {
            let source = unique_providers
                .iter()
                .next()
                .map(String::as_str)
                .unwrap_or("");
            let base: f64 = match source {
                "local_chapters" => 0.88,
                "local_fingerprint" => 0.82,
                "theintrodb.org" => 0.78,
                "aniskip.com" => 0.76,
                "introdb.app" => 0.68,
                _ => 0.55,
            };
            let corroboration = if best_submission_count >= 3 {
                0.08
            } else if best_submission_count >= 2 {
                0.04
            } else {
                0.0
            };
            base.max(best_evidence_confidence * 0.8).min(0.9) + corroboration
        }
        .min(0.99);
        let start = (weighted_start / total_weight).clamp(0.0, duration);
        let end = (weighted_end / total_weight).clamp(start, duration);
        let auto_skip_safe = agreement >= 2 && confidence >= 0.9;
        decisions.push(SkipSegmentDecision {
            kind: seed.kind.clone(),
            start,
            end,
            confidence,
            agreement,
            providers: unique_providers.into_iter().collect(),
            reason: if agreement >= 2 {
                format!("{agreement} independent sources agree within {tolerance:.0} seconds")
            } else {
                "Single-source result; available for manual skipping only".to_owned()
            },
            auto_skip_safe,
        });
    }
    decisions.sort_by(|left, right| left.start.total_cmp(&right.start));
    decisions
}

async fn title_metadata(
    State(state): State<AppState>,
    Query(query): Query<MetadataQuery>,
) -> Result<Json<Value>, StatusCode> {
    let cache_path = title_metadata_cache_path(&state, &query);
    if let Some(cached) = read_title_metadata_cache(&cache_path).await {
        tracing::debug!(title = %query.title, kind = %query.kind, "Title metadata cache hit");
        return Ok(Json(cached));
    }
    tracing::debug!(title = %query.title, kind = %query.kind, "Title metadata cache miss");
    let catalog = format!(
        "https://v3-cinemeta.strem.io/catalog/{}/top/search={}.json",
        if query.kind == "series" {
            "series"
        } else {
            "movie"
        },
        urlencoding::encode(&query.title)
    );
    let search: Value = state
        .http
        .get(catalog)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .error_for_status()
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .json()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let normalized_title = normalize_catalog_title(&query.title);
    let media_type = if query.kind == "series" {
        "series"
    } else {
        "movie"
    };
    let mut tmdb_detail = None;
    if let Some(tmdb_id) = query.tmdb_id
        && let Some(items) = search.get("metas").and_then(Value::as_array)
    {
        for item in items.iter().take(8) {
            let Some(candidate_id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            let candidate_name =
                normalize_catalog_title(item.get("name").and_then(Value::as_str).unwrap_or(""));
            if candidate_name != normalized_title {
                continue;
            }
            let url = format!("https://v3-cinemeta.strem.io/meta/{media_type}/{candidate_id}.json");
            let Ok(response) = state.http.get(url).send().await else {
                continue;
            };
            let Ok(payload) = response.error_for_status() else {
                continue;
            };
            let Ok(payload) = payload.json::<Value>().await else {
                continue;
            };
            if payload
                .get("meta")
                .and_then(|meta| meta.get("moviedb_id"))
                .and_then(Value::as_u64)
                == Some(tmdb_id)
            {
                tmdb_detail = Some(payload);
                break;
            }
        }
    }
    let id = search
        .get("metas")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .enumerate()
                .filter(|(_, item)| {
                    let name = normalize_catalog_title(
                        item.get("name").and_then(Value::as_str).unwrap_or(""),
                    );
                    catalog_title_match_score(&normalized_title, &name, None, "") > 0
                })
                .max_by_key(|(index, item)| {
                    let name = normalize_catalog_title(
                        item.get("name").and_then(Value::as_str).unwrap_or(""),
                    );
                    let release = item
                        .get("releaseInfo")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let mut score = catalog_title_match_score(
                        &normalized_title,
                        &name,
                        query.year.as_deref(),
                        release,
                    );
                    if query.kind == "series"
                        && (query.seasons.unwrap_or(0) > 0 || query.episodes.unwrap_or(0) > 1)
                    {
                        score += 20;
                    }
                    score * 1000 - *index as i32
                })
                .map(|(_, item)| item)
        })
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .ok_or(StatusCode::NOT_FOUND)?;
    let detail: Value = if let Some(detail) = tmdb_detail {
        detail
    } else {
        let detail_url = format!("https://v3-cinemeta.strem.io/meta/{media_type}/{id}.json");
        state
            .http
            .get(detail_url)
            .send()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?
            .error_for_status()
            .map_err(|_| StatusCode::BAD_GATEWAY)?
            .json()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?
    };
    let mut metadata = detail.get("meta").cloned().ok_or(StatusCode::NOT_FOUND)?;
    let has_trailer = metadata
        .get("trailers")
        .and_then(Value::as_array)
        .is_some_and(|trailers| {
            trailers.iter().any(|trailer| {
                trailer
                    .get("source")
                    .and_then(Value::as_str)
                    .is_some_and(|source| !source.is_empty())
            })
        });
    if !has_trailer {
        if let Some(source) = find_youtube_trailer(&state.http, &query.title).await {
            metadata["trailers"] = serde_json::json!([{ "source": source, "type": "Trailer" }]);
        }
    }
    if let Err(error) = write_title_metadata_cache(&cache_path, &metadata).await {
        tracing::warn!(title = %query.title, error = %error, "Could not persist title metadata cache");
    }
    Ok(Json(metadata))
}

const TITLE_METADATA_CACHE_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

fn title_metadata_cache_path(state: &AppState, query: &MetadataQuery) -> PathBuf {
    let mut digest = Sha256::new();
    // Invalidate unrelated search results accepted by the old matcher.
    digest.update(b"tms-title-metadata-v5");
    digest.update(query.kind.as_bytes());
    digest.update([0]);
    digest.update(query.title.trim().to_ascii_lowercase().as_bytes());
    digest.update([0]);
    digest.update(query.year.as_deref().unwrap_or("").as_bytes());
    digest.update([0]);
    digest.update(
        query
            .tmdb_id
            .map(|id| id.to_string())
            .unwrap_or_default()
            .as_bytes(),
    );
    state
        .title_metadata_dir
        .join(format!("{:x}.json", digest.finalize()))
}

async fn read_title_metadata_cache(path: &Path) -> Option<Value> {
    let fresh = tokio::fs::metadata(path)
        .await
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < TITLE_METADATA_CACHE_TTL);
    if !fresh {
        return None;
    }
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

async fn write_title_metadata_cache(path: &Path, metadata: &Value) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec(metadata).map_err(std::io::Error::other)?;
    tokio::fs::write(path, bytes).await
}

async fn find_youtube_trailer(http: &reqwest::Client, title: &str) -> Option<String> {
    let search = format!(
        "https://www.youtube.com/results?search_query={}",
        urlencoding::encode(&format!("{title} official trailer"))
    );
    let page = http
        .get(search)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    page.match_indices("watch?v=").find_map(|(index, _)| {
        let candidate: String = page[index + "watch?v=".len()..]
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            })
            .take(11)
            .collect();
        (candidate.len() == 11).then_some(candidate)
    })
}

#[derive(Clone)]
struct EmbeddedSubtitleStream {
    index: u32,
    language: String,
    label: String,
    burn_in: bool,
}

async fn embedded_subtitle_streams(state: &AppState, input: &Path) -> Vec<EmbeddedSubtitleStream> {
    let output = match hidden_async_command(&state.ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "s",
            "-show_entries",
            "stream=index,codec_name:stream_tags=language,title",
            "-of",
            "json",
        ])
        .arg(input)
        .output()
        .await
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            tracing::warn!(status = ?output.status.code(), "Could not inspect embedded subtitles");
            return Vec::new();
        }
        Err(error) => {
            tracing::warn!(%error, "Could not start embedded subtitle inspection");
            return Vec::new();
        }
    };
    let payload: Value = match serde_json::from_slice(&output.stdout) {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!(%error, "Embedded subtitle inspection returned invalid data");
            return Vec::new();
        }
    };
    let streams = payload
        .get("streams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let detected_codecs = streams
        .iter()
        .filter_map(|stream| stream.get("codec_name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let tracks = streams
        .into_iter()
        .filter_map(|stream| {
            let codec = stream.get("codec_name")?.as_str()?.to_ascii_lowercase();
            // PGS is the Blu-ray image subtitle format used by the local Hunter
            // × Hunter files. It belongs in the local caption picker too; the
            // player can decide how to render it.
            if !matches!(
                codec.as_str(),
                "subrip" | "webvtt" | "ass" | "ssa" | "hdmv_pgs_subtitle"
            ) {
                return None;
            }
            let index = stream.get("index")?.as_u64()?.try_into().ok()?;
            let language = stream
                .get("tags")
                .and_then(|tags| tags.get("language"))
                .and_then(Value::as_str)
                .unwrap_or("und")
                .to_owned();
            if !matches!(language.to_ascii_lowercase().as_str(), "en" | "eng") {
                return None;
            }
            let title = stream
                .get("tags")
                .and_then(|tags| tags.get("title"))
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| language.clone());
            Some(EmbeddedSubtitleStream {
                index,
                language,
                label: format!(
                    "{title} (Local{})",
                    if codec == "hdmv_pgs_subtitle" { " PGS" } else { "" }
                ),
                burn_in: codec == "hdmv_pgs_subtitle",
            })
        })
        .collect::<Vec<_>>();
    tracing::info!(
        input = %input.display(),
        embedded_streams = detected_codecs.len(),
        codecs = ?detected_codecs,
        usable_webvtt_tracks = tracks.len(),
        "Embedded caption streams inspected"
    );
    tracks
}

async fn subtitles(
    State(state): State<AppState>,
    Query(query): Query<VideoPathQuery>,
) -> Result<Json<Vec<SubtitleTrack>>, StatusCode> {
    let lookup_started_at = Instant::now();
    let video = safe_library_path(&state.library_root, &query.video_path)?;
    let parent = video.parent().ok_or(StatusCode::BAD_REQUEST)?;
    let stem = video
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mut tracks = Vec::new();
    let mut entries = tokio::fs::read_dir(parent)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("srt"))
        {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let lower = name.to_lowercase();
            if lower.contains("english")
                || lower.contains(".en.")
                || lower.contains(".eng.")
                || lower == format!("{stem}.srt")
            {
                let relative = path
                    .strip_prefix(&state.library_root)
                    .map_err(|_| StatusCode::BAD_REQUEST)?
                    .to_string_lossy()
                    .replace('\\', "/");
                tracks.push(SubtitleTrack {
                    label: format!("English (File: {name})"),
                    language: "en".to_owned(),
                    url: format!("/api/subtitle?path={}", urlencoding::encode(&relative)),
                    mode: None,
                    stream_index: None,
                });
            }
        }
    }
    for track in embedded_subtitle_streams(&state, &video).await {
        tracks.push(SubtitleTrack {
            label: track.label,
            language: track.language,
            url: format!(
                "/api/embedded-subtitle?video_path={}&stream_index={}",
                urlencoding::encode(&query.video_path),
                track.index
            ),
            mode: track.burn_in.then(|| "burn_in".to_owned()),
            stream_index: track.burn_in.then_some(track.index),
        });
    }
    tracks.sort_by(|left, right| {
        let left_is_english = matches!(left.language.as_str(), "en" | "eng");
        let right_is_english = matches!(right.language.as_str(), "en" | "eng");
        right_is_english
            .cmp(&left_is_english)
            .then_with(|| left.label.cmp(&right.label))
    });
    let local_track_count = tracks.len();

    let remote_lookup = video
        .file_name()
        .and_then(|name| episode_name_from_release(&name.to_string_lossy()))
        .map(|episode| (episode.title, None, Some((episode.season, episode.episode))))
        .or_else(|| inferred_movie_title(parent).map(|(title, year)| (title, year, None)));
    if let Some((title, year, episode)) = remote_lookup {
        let catalog_type = if episode.is_some() { "series" } else { "movie" };
        match find_media_imdb_id(&state.http, &title, year.as_deref(), catalog_type).await {
            Some(imdb_id) => {
                tracing::info!(
                    video_path = %query.video_path,
                    %imdb_id,
                    title,
                    season = ?episode.map(|value| value.0),
                    episode = ?episode.map(|value| value.1),
                    wyzie_configured = state.wyzie_api_key.is_some(),
                    subdl_configured = state.subdl_api_key.is_some(),
                    "Remote caption lookup matched IMDb metadata"
                );
                let endpoint = match episode {
                    Some((season, episode)) => format!(
                        "https://opensubtitles-v3.strem.io/subtitles/series/{imdb_id}:{season}:{episode}.json"
                    ),
                    None => {
                        format!("https://opensubtitles-v3.strem.io/subtitles/movie/{imdb_id}.json")
                    }
                };
                match state.http.get(endpoint).send().await {
                    Ok(response) => match response.error_for_status() {
                        Ok(response) => match response.json::<Value>().await {
                            Ok(payload) => {
                                // The public Stremio OpenSubtitles feed occasionally returns an
                                // English file from another Hunter × Hunter episode.  Its minimal
                                // result payload does not include a release or episode number, so
                                // verify the subtitle's on-screen episode title before we offer it.
                                // This is deliberately restricted to this series: other shows do
                                // not consistently put their title card in the caption text.
                                let hunter_episode_title = if imdb_id == "tt2098220" {
                                    match episode {
                                        Some((season, number)) => {
                                            hunter_x_hunter_episode_title(
                                                &state.http,
                                                season,
                                                number,
                                            )
                                            .await
                                        }
                                        None => None,
                                    }
                                } else {
                                    None
                                };
                                let candidates: Vec<_> = payload
                                    .get("subtitles")
                                    .and_then(Value::as_array)
                                    .into_iter()
                                    .flatten()
                                    .filter_map(|value| {
                                        serde_json::from_value::<StremioSubtitle>(value.clone())
                                            .ok()
                                    })
                                    .filter(|track| track.lang == "eng")
                                    .take(3)
                                    .collect();
                                tracing::info!(%imdb_id, candidates = candidates.len(), "OpenSubtitles caption search completed");
                                for candidate in candidates {
                                    if let Some(expected_title) = hunter_episode_title.as_deref() {
                                        match hunter_x_hunter_caption_matches_episode(
                                            &state.http,
                                            &candidate.url,
                                            expected_title,
                                        )
                                        .await
                                        {
                                            Some(true) => {}
                                            Some(false) => {
                                                tracing::warn!(
                                                    %imdb_id,
                                                    subtitle_id = %candidate.id,
                                                    expected_title,
                                                    "Ignoring OpenSubtitles caption from a different Hunter x Hunter episode"
                                                );
                                                continue;
                                            }
                                            // A transient provider failure should not make the
                                            // remaining remote options disappear.
                                            None => {}
                                        }
                                    }
                                    tracks.push(SubtitleTrack {
                                        label: format!("English (OpenSubtitles #{})", candidate.id),
                                        language: "en".to_owned(),
                                        url: format!(
                                            "/api/remote-subtitle?url={}",
                                            urlencoding::encode(&candidate.url)
                                        ),
                                        mode: None,
                                        stream_index: None,
                                    });
                                }
                            }
                            Err(error) => {
                                tracing::warn!(%error, %imdb_id, "OpenSubtitles returned unreadable data")
                            }
                        },
                        Err(error) => {
                            tracing::warn!(%error, %imdb_id, "OpenSubtitles request was rejected")
                        }
                    },
                    Err(error) => tracing::warn!(%error, %imdb_id, "OpenSubtitles request failed"),
                }
                let (wyzie_tracks, subdl_tracks) = tokio::join!(
                    search_wyzie_subtitles(
                        &state.http,
                        state.wyzie_api_key.as_deref(),
                        &imdb_id,
                        episode
                    ),
                    search_subdl_subtitles(
                        &state.http,
                        state.subdl_api_key.as_deref(),
                        &imdb_id,
                        episode
                    ),
                );
                tracing::info!(
                    %imdb_id,
                    opensubtitles_tracks = tracks.len().saturating_sub(local_track_count),
                    wyzie_tracks = wyzie_tracks.len(),
                    subdl_tracks = subdl_tracks.len(),
                    "Remote caption providers completed"
                );
                tracks.extend(wyzie_tracks);
                tracks.extend(subdl_tracks);
            }
            None => {
                tracing::debug!(title, year = ?year, "Remote subtitle lookup skipped: no IMDb match")
            }
        }
    } else {
        tracing::debug!(video_path = %query.video_path, "Remote subtitle lookup skipped: title could not be inferred");
    }
    let lookup_elapsed = lookup_started_at.elapsed();
    tracing::info!(
        video_path = %query.video_path,
        local_tracks = local_track_count,
        remote_tracks = tracks.len().saturating_sub(local_track_count),
        total_tracks = tracks.len(),
        lookup_duration_ms = lookup_elapsed.as_millis() as u64,
        "Subtitle lookup completed"
    );
    Ok(Json(tracks))
}

async fn hunter_x_hunter_episode_title(
    http: &reqwest::Client,
    season: u16,
    episode: u16,
) -> Option<String> {
    let payload: Value = http
        .get("https://v3-cinemeta.strem.io/meta/series/tt2098220.json")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    payload
        .pointer("/meta/videos")?
        .as_array()?
        .iter()
        .find(|video| {
            video.get("season").and_then(Value::as_u64) == Some(season as u64)
                && video.get("number").and_then(Value::as_u64) == Some(episode as u64)
        })?
        .get("name")?
        .as_str()
        .map(str::to_owned)
}

async fn hunter_x_hunter_caption_matches_episode(
    http: &reqwest::Client,
    url: &str,
    expected_title: &str,
) -> Option<bool> {
    if !is_allowed_remote_subtitle_url(url) {
        return Some(false);
    }
    let source = http
        .get(url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    Some(hunter_x_hunter_title_matches_caption(
        &source,
        expected_title,
    ))
}

fn hunter_x_hunter_title_matches_caption(caption: &str, expected_title: &str) -> bool {
    let caption = caption.to_ascii_lowercase();
    let meaningful_words = expected_title
        .split(|character: char| !character.is_ascii_alphanumeric())
        .map(str::trim)
        .filter(|word| word.len() >= 4)
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    !meaningful_words.is_empty() && meaningful_words.iter().all(|word| caption.contains(word))
}

fn inferred_movie_title(parent: &Path) -> Option<(String, Option<String>)> {
    let folder = parent.file_name()?.to_str()?;
    let mut words = Vec::new();
    let mut year = None;
    let latest_plausible_year = current_year().saturating_add(1);
    for word in folder
        .split(|character: char| character.is_whitespace() || character == '.' || character == '_')
    {
        let clean = word.trim_matches(|character: char| !character.is_ascii_alphanumeric());
        if clean.len() == 4
            && let Ok(candidate_year) = clean.parse::<u16>()
            && (1900..=latest_plausible_year).contains(&candidate_year)
        {
            year = Some(clean.to_owned());
            break;
        }
        if matches!(
            clean.to_ascii_lowercase().as_str(),
            "1080p" | "720p" | "2160p" | "bluray" | "webdl" | "web-dl"
        ) {
            break;
        }
        if !clean.is_empty() {
            words.push(clean);
        }
    }
    (!words.is_empty()).then(|| (words.join(" "), year))
}

fn current_year() -> u16 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // A tropical year is accurate enough here because the result only bounds metadata matching.
    1970 + (elapsed.as_secs() / 31_556_952) as u16
}

async fn find_media_imdb_id(
    http: &reqwest::Client,
    title: &str,
    year: Option<&str>,
    media_type: &str,
) -> Option<String> {
    let endpoint = format!(
        "https://v3-cinemeta.strem.io/catalog/{media_type}/top/search={}.json",
        urlencoding::encode(title),
    );
    let payload: Value = http
        .get(endpoint)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let normalized = normalize_catalog_title(title);
    payload
        .get("metas")?
        .as_array()?
        .iter()
        .enumerate()
        .max_by_key(|(index, item)| {
            let name =
                normalize_catalog_title(item.get("name").and_then(Value::as_str).unwrap_or(""));
            let release = item
                .get("releaseInfo")
                .and_then(Value::as_str)
                .unwrap_or("");
            catalog_title_match_score(&normalized, &name, year, release) * 1000 - *index as i32
        })
        .and_then(|(_, item)| item.get("id"))
        .and_then(Value::as_str)
        .filter(|id| id.starts_with("tt"))
        .map(str::to_owned)
}

/// Catalog titles and release filenames use different punctuation conventions
/// (`Spider-Man: Across the Spider-Verse` versus
/// `Spider-Man.Across.The.Spider-Verse`). Compare their words, not their raw
/// punctuation, so an exact modern title is not outranked by an older prefix.
/// Release names spell out `&` (`Dungeons.and.Dragons`), so treat it as "and".
fn normalize_catalog_title(title: &str) -> String {
    title
        .replace('&', " and ")
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| word.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// A release year in a local filename is strong disambiguating evidence when
/// multiple catalogue entries have the same normalized title. Prefer the
/// matching remake and demote candidates that explicitly carry a different
/// year; keep catalogue ordering only when a candidate has no release year.
fn catalog_title_match_score(
    requested: &str,
    candidate: &str,
    requested_year: Option<&str>,
    candidate_release: &str,
) -> i32 {
    if requested.is_empty() || candidate.is_empty() {
        return 0;
    }
    let year_score = match requested_year {
        Some(year) if candidate_release.contains(year) => 40,
        Some(_) if !candidate_release.trim().is_empty() => -20,
        _ => 0,
    };
    if candidate == requested {
        100 + year_score
    } else if candidate.starts_with(&format!("{requested} "))
        || requested.starts_with(&format!("{candidate} "))
    {
        50 + year_score
    } else {
        0
    }
}

async fn search_wyzie_subtitles(
    http: &reqwest::Client,
    api_key: Option<&str>,
    imdb_id: &str,
    episode: Option<(u16, u16)>,
) -> Vec<SubtitleTrack> {
    let Some(api_key) = api_key else {
        tracing::debug!(%imdb_id, season = ?episode.map(|value| value.0), episode = ?episode.map(|value| value.1), "Wyzie caption search skipped: API key is not configured");
        return Vec::new();
    };
    let Ok(mut endpoint) = reqwest::Url::parse("https://sub.wyzie.io/search") else {
        return Vec::new();
    };
    {
        let mut query = endpoint.query_pairs_mut();
        query
            .append_pair("id", imdb_id)
            .append_pair("language", "en")
            .append_pair("format", "srt")
            // TVSubtitles is available on Wyzie's free tier. Keep this explicit
            // so TMS never depends on a paid source or account upgrade.
            .append_pair("source", "tvsubtitles")
            .append_pair("key", api_key);
        if let Some((season, episode)) = episode {
            query
                .append_pair("season", &season.to_string())
                .append_pair("episode", &episode.to_string());
        }
    }
    let response = match http.get(endpoint).send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, %imdb_id, "Wyzie subtitle search failed");
            return Vec::new();
        }
    };
    let response = match response.error_for_status() {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, %imdb_id, "Wyzie subtitle search was rejected");
            return Vec::new();
        }
    };
    let candidates = match response.json::<Vec<WyzieSubtitle>>().await {
        Ok(candidates) => candidates,
        Err(error) => {
            tracing::warn!(%error, %imdb_id, "Wyzie returned unreadable subtitle data");
            return Vec::new();
        }
    };
    candidates
        .into_iter()
        .filter(|candidate| candidate.language.eq_ignore_ascii_case("en"))
        .filter(|candidate| candidate.source.eq_ignore_ascii_case("tvsubtitles"))
        .filter(|candidate| is_allowed_remote_subtitle_url(&candidate.url))
        .take(3)
        .map(|candidate| SubtitleTrack {
            label: format!("English ({} via Wyzie)", candidate.source),
            language: "en".to_owned(),
            url: format!(
                "/api/remote-subtitle?url={}",
                urlencoding::encode(&candidate.url)
            ),
            mode: None,
            stream_index: None,
        })
        .collect()
}

async fn search_subdl_subtitles(
    http: &reqwest::Client,
    api_key: Option<&str>,
    imdb_id: &str,
    episode: Option<(u16, u16)>,
) -> Vec<SubtitleTrack> {
    let Some(api_key) = api_key else {
        tracing::debug!(%imdb_id, season = ?episode.map(|value| value.0), episode = ?episode.map(|value| value.1), "SubDL caption search skipped: API key is not configured");
        return Vec::new();
    };
    let Ok(mut endpoint) = reqwest::Url::parse("https://api.subdl.com/api/v1/subtitles") else {
        return Vec::new();
    };
    {
        let mut query = endpoint.query_pairs_mut();
        query
            .append_pair("api_key", api_key)
            .append_pair("imdb_id", imdb_id)
            .append_pair("type", if episode.is_some() { "tv" } else { "movie" })
            .append_pair("languages", "EN")
            .append_pair("unpack", "1")
            .append_pair("subs_per_page", "3");
        if let Some((season, episode)) = episode {
            query
                .append_pair("season_number", &season.to_string())
                .append_pair("episode_number", &episode.to_string());
        }
    }
    let response = match http.get(endpoint).send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, %imdb_id, "SubDL subtitle search failed");
            return Vec::new();
        }
    };
    let response = match response.error_for_status() {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, %imdb_id, "SubDL subtitle search was rejected");
            return Vec::new();
        }
    };
    let result = match response.json::<SubdlSearchResult>().await {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!(%error, %imdb_id, "SubDL returned unreadable subtitle data");
            return Vec::new();
        }
    };
    result
        .subtitles
        .into_iter()
        .flat_map(|subtitle| {
            subtitle
                .unpack_files
                .into_iter()
                .map(move |file| (subtitle.release_name.clone(), file))
        })
        .filter(|(_, file)| file.language.eq_ignore_ascii_case("EN"))
        .filter(|(_, file)| file.format.eq_ignore_ascii_case("srt"))
        .filter_map(|(release_name, file)| {
            let url = if file.url.starts_with("https://") {
                file.url
            } else {
                format!("https://dl.subdl.com/{}", file.url.trim_start_matches('/'))
            };
            is_allowed_remote_subtitle_url(&url).then_some((release_name, file.name, url))
        })
        .take(3)
        .map(|(release_name, name, url)| SubtitleTrack {
            label: format!(
                "English (SubDL: {})",
                if release_name.trim().is_empty() {
                    name
                } else {
                    release_name
                }
            ),
            language: "en".to_owned(),
            url: format!("/api/remote-subtitle?url={}", urlencoding::encode(&url)),
            mode: None,
            stream_index: None,
        })
        .collect()
}

async fn subtitle_file(
    State(state): State<AppState>,
    Query(query): Query<SubtitlePathQuery>,
) -> Result<Response, StatusCode> {
    let path = safe_library_path(&state.library_root, &query.path)?;
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("srt"))
    {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let source = tokio::fs::read_to_string(path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(subtitle_response(&source, "no-cache"))
}

async fn embedded_subtitle_file(
    State(state): State<AppState>,
    Query(query): Query<EmbeddedSubtitleQuery>,
) -> Result<Response, StatusCode> {
    let video = safe_library_path(&state.library_root, &query.video_path)?;
    if !video.is_file()
        || !embedded_subtitle_streams(&state, &video)
            .await
            .iter()
            .any(|stream| stream.index == query.stream_index)
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let output = hidden_async_command(&state.ffmpeg_path)
        .args(["-v", "error", "-i"])
        .arg(&video)
        .args(["-map", &format!("0:{}", query.stream_index), "-f", "webvtt", "pipe:1"])
        .output()
        .await
        .map_err(|error| {
            tracing::error!(%error, video_path = %query.video_path, stream_index = query.stream_index, "Could not extract embedded subtitles");
            StatusCode::SERVICE_UNAVAILABLE
        })?;
    if !output.status.success() {
        tracing::warn!(
            video_path = %query.video_path,
            stream_index = query.stream_index,
            status = ?output.status.code(),
            stderr = %String::from_utf8_lossy(&output.stderr),
            "Embedded subtitle extraction failed"
        );
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    let source = String::from_utf8(output.stdout).map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
    Ok(subtitle_response(&source, "public, max-age=86400"))
}

async fn remote_subtitle_file(
    State(state): State<AppState>,
    Query(query): Query<RemoteSubtitleQuery>,
) -> Result<Response, StatusCode> {
    if !is_allowed_remote_subtitle_url(&query.url) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let url = reqwest::Url::parse(&query.url).map_err(|_| StatusCode::BAD_REQUEST)?;
    let source = state
        .http
        .get(url)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .error_for_status()
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .text()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(subtitle_response(&source, "public, max-age=86400"))
}

fn is_allowed_remote_subtitle_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    url.scheme() == "https"
        && (host == "strem.io"
            || host.ends_with(".strem.io")
            || host == "sub.wyzie.io"
            || host == "dl.subdl.com")
}

fn subtitle_response(source: &str, cache_control: &'static str) -> Response {
    let normalized = source.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let converted = normalized
        .lines()
        .map(|line| {
            if line.contains(" --> ") {
                line.replace(',', ".")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let vtt = if converted.trim_start().starts_with("WEBVTT") {
        converted
    } else {
        format!("WEBVTT\n\n{converted}")
    };
    (
        [
            ("content-type", "text/vtt; charset=utf-8"),
            ("cache-control", cache_control),
        ],
        vtt,
    )
        .into_response()
}

fn safe_library_path(root: &Path, relative: &str) -> Result<PathBuf, StatusCode> {
    if relative.is_empty()
        || Path::new(relative).is_absolute()
        || relative.split(['/', '\\']).any(|part| part == "..")
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(root.join(relative.replace('/', "\\")))
}

async fn grid_thumb(
    State(state): State<AppState>,
    Query(query): Query<GridThumbQuery>,
) -> Result<Response, Response> {
    let started_at = Instant::now();
    let input = safe_library_path(&state.library_root, &query.path)
        .map_err(|_| StatusCode::NOT_FOUND.into_response())?;

    let fallback_redirect = || {
        Redirect::temporary(&format!(
            "/media/{}",
            query
                .path
                .split('/')
                .map(urlencoding::encode)
                .collect::<Vec<_>>()
                .join("/")
        ))
        .into_response()
    };

    if !input.is_file() {
        return Err(fallback_redirect());
    }
    let metadata = tokio::fs::metadata(&input)
        .await
        .map_err(|_| fallback_redirect())?;

    let key = grid_thumb_key(&query.path, &metadata);
    let thumb_path = state.grid_thumbs_dir.join(format!("{}.jpg", key));
    let cache_state = if thumb_path.is_file() {
        "disk-hit"
    } else {
        "generated"
    };

    if let Some(library) = query.path.split('/').next() {
        if is_library_path(library) {
            schedule_thumbnail_library(state.clone(), library.to_owned());
            schedule_browser_media_library(state.clone(), library.to_owned());
        }
    }

    if generate_grid_thumb_for_file(&state, &input).await {
        if let Ok(bytes) = tokio::fs::read(&thumb_path).await {
            tracing::info!(
                target: "tms_server::image",
                event = "grid_thumb",
                cache = cache_state,
                path = %truncate_log_value(&query.path, 1_000),
                bytes = bytes.len(),
                duration_ms = started_at.elapsed().as_millis() as u64,
                "Grid thumbnail served"
            );
            return Ok((
                [
                    ("content-type", "image/jpeg"),
                    ("cache-control", "public, max-age=31536000, immutable"),
                ],
                bytes,
            )
                .into_response());
        }
    }

    tracing::warn!(
        target: "tms_server::image",
        event = "grid_thumb",
        cache = "fallback",
        path = %truncate_log_value(&query.path, 1_000),
        duration_ms = started_at.elapsed().as_millis() as u64,
        "Grid thumbnail unavailable"
    );
    // A video cannot be decoded as an <img>. Redirecting this thumbnail miss
    // to the original MP4 makes the browser download media that is guaranteed
    // to fail image decoding, tying up its connection slots for seconds.
    // Images retain the source fallback; video cards use their normal preview
    // path until the background thumbnail cache has a frame.
    if is_video_file(&input) {
        Err(StatusCode::NOT_FOUND.into_response())
    } else {
        Err(fallback_redirect())
    }
}

// Trickplay frames are always generated ahead of viewing.  This endpoint only reads
// the already-created frame, so moving across the seek bar can never start FFmpeg.
async fn preview_frame(
    State(state): State<AppState>,
    Query(query): Query<PreviewFrameQuery>,
) -> Result<Response, StatusCode> {
    if !query.time.is_finite() || query.time < 0.0 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let input = safe_library_path(&state.library_root, &query.video_path)?;
    let Some(library_name) = query
        .video_path
        .split('/')
        .next()
        .filter(|name| is_library_path(name))
    else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let libraries = read_libraries(&state).await;
    if !libraries
        .get(library_name)
        .is_some_and(|library| library.trickplay_enabled)
        || !input.is_file()
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let metadata = tokio::fs::metadata(&input)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let key = trickplay_key(&query.video_path, &metadata);
    let frame_index = (query.time / TRICKPLAY_INTERVAL_SECONDS).round() as u64;
    let frame = if let Some(subtitle_stream) = query.subtitle_stream {
        let embedded = embedded_subtitle_streams(&state, &input).await;
        if !embedded
            .iter()
            .any(|track| track.index == subtitle_stream && track.burn_in)
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        let subtitle_dir = state
            .trickplay_dir
            .join(key)
            .join(format!("subtitle-{subtitle_stream}"));
        let frame = subtitle_dir.join(format!("{frame_index:08}.jpg"));
        if !frame.is_file() {
            tokio::fs::create_dir_all(&subtitle_dir)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let temporary = subtitle_dir.join(format!("{frame_index:08}.tmp.jpg"));
            let mut command = hidden_async_command(&state.ffmpeg_path);
            command
                .args([
                    "-y",
                    "-v",
                    "error",
                    "-ss",
                    &query.time.to_string(),
                    // Keep PGS and video timestamps aligned after an input seek.
                    // Without this, a seek-preview can show an empty/black frame.
                    "-copyts",
                    "-start_at_zero",
                    "-i",
                ])
                .arg(&input)
                .args([
                    "-filter_complex",
                    &format!(
                        "[0:v:0][0:{subtitle_stream}]overlay,scale=960:-2:force_original_aspect_ratio=decrease"
                    ),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "5",
                ])
                .arg(&temporary);
            let output = command
                .output()
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
            if !output.status.success() || !temporary.is_file() {
                let _ = tokio::fs::remove_file(&temporary).await;
                return Err(StatusCode::UNPROCESSABLE_ENTITY);
            }
            tokio::fs::rename(&temporary, &frame)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        frame
    } else {
        state
            .trickplay_dir
            .join(key)
            .join(format!("{frame_index:08}.jpg"))
    };
    let bytes = tokio::fs::read(frame)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((
        [
            ("content-type", "image/jpeg"),
            ("cache-control", "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}

const TRICKPLAY_INTERVAL_SECONDS: f64 = 10.0;
const TRICKPLAY_COMPLETE_MARKER: &str = ".complete";
// Timeline frames are 960px wide. Version their directory so earlier 480px
// previews remain on disk but are never selected for playback.
const TRICKPLAY_CACHE_VERSION: &str = "trickplay-v2-960";
// Small, independently decodable chunks let a fresh transcode begin in a few
// seconds. The playlist is served no-store and continues to grow while the
// player fills its normal forward buffer, rather than blocking startup on it.
const HLS_SEGMENT_SECONDS: u64 = 2;
const HLS_STARTUP_SEGMENTS: usize = 3;

fn file_modified_secs(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_secs())
}

fn media_cache_key(video_path: &str, metadata: &std::fs::Metadata) -> String {
    let modified = file_modified_secs(metadata);
    let mut hasher = Sha256::new();
    hasher.update(video_path.as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    format!("{:x}", hasher.finalize())
}

fn trickplay_key(video_path: &str, metadata: &std::fs::Metadata) -> String {
    format!(
        "{TRICKPLAY_CACHE_VERSION}-{}",
        media_cache_key(video_path, metadata)
    )
}

// Grid cards do not need the larger trickplay frames used by the watch page.
// Version this key so 480px cache files are never served after reducing the
// card-preview budget; the thumbnail worker refills the new cache lazily.
const GRID_THUMB_MAX_WIDTH: u32 = 140;
const GRID_THUMB_CACHE_VERSION: &str = "grid-v3-140";

fn grid_thumb_key(path: &str, metadata: &std::fs::Metadata) -> String {
    // API paths always use '/', while Path::strip_prefix yields '\\' on
    // Windows. Cache keys must be based on the logical library path or a
    // pre-generated thumbnail is saved under a different key than the one the
    // browser later asks for.
    let logical_path = path.replace('\\', "/");
    format!(
        "{GRID_THUMB_CACHE_VERSION}-{}",
        media_cache_key(&logical_path, metadata)
    )
}

const TRICKPLAY_IDLE_DELAY: Duration = Duration::from_secs(10 * 60);
const TRICKPLAY_PLAYBACK_GRACE: Duration = Duration::from_secs(45);

#[derive(Clone, Copy, PartialEq, Eq)]
enum TrickplayRun {
    Automatic,
    Manual,
}

fn schedule_library_preload(
    state: AppState,
    library: String,
    run: TrickplayRun,
    initiated_by: Option<String>,
) {
    schedule_trickplay_library(state.clone(), library.clone(), run, initiated_by);
    schedule_thumbnail_library(state, library);
}

fn schedule_trickplay_library(
    state: AppState,
    library: String,
    run: TrickplayRun,
    initiated_by: Option<String>,
) {
    tokio::spawn(async move {
        let started_at = unix_now();
        {
            let mut active = state.active_trickplay_libraries.lock().await;
            if active.contains_key(&library) {
                return;
            }
            active.insert(
                library.clone(),
                ActiveTrickplay {
                    started_at,
                    initiated_by: initiated_by.clone(),
                    ffmpeg_pid: None,
                    current_video: None,
                    current_output_dir: None,
                    current_video_started_at: None,
                    current_expected_frames: None,
                    completed_videos: 0,
                    total_videos: 0,
                    inventory_complete: false,
                    paused_until: None,
                    max_speed: false,
                    waits_for_idle: run == TrickplayRun::Automatic,
                },
            );
        }
        state
            .finished_trickplay_libraries
            .lock()
            .await
            .remove(&library);
        // Recognising finished previews must not wait for the idle window, or a
        // library that has nothing left to do would sit at 0% for as long as
        // somebody is using the computer.
        let (videos, mut completed_videos, total_videos) =
            trickplay_inventory(&state, &library).await;
        {
            let mut active = state.active_trickplay_libraries.lock().await;
            if let Some(trickplay) = active.get_mut(&library) {
                trickplay.total_videos = total_videos;
                trickplay.completed_videos = completed_videos;
                trickplay.inventory_complete = true;
            }
        }
        let mut generated_videos = 0;
        let mut failed_videos = 0;
        if videos.is_empty() {
            tracing::info!(library = %library, videos = total_videos, "Every timeline preview already exists; nothing to generate");
            finish_trickplay_run(
                &state,
                &library,
                FinishedTrickplay {
                    started_at,
                    initiated_by,
                    total_videos,
                    generated_videos,
                    failed_videos,
                },
            )
            .await;
            return;
        }
        if run == TrickplayRun::Automatic {
            tracing::info!(library = %library, pending = videos.len(), "Trickplay generation queued until the computer is idle");
        }
        // Only one FFmpeg trickplay job may run at a time. An automatic job
        // checks again after waiting in case the computer became busy in queue.
        let _run_lock = loop {
            if !trickplay_is_enabled(&state, &library).await {
                state
                    .active_trickplay_libraries
                    .lock()
                    .await
                    .remove(&library);
                return;
            }
            let max_speed = trickplay_max_speed(&state, &library).await;
            if run == TrickplayRun::Automatic && !max_speed {
                while !trickplay_max_speed(&state, &library).await
                    && !trickplay_idle_window(&state).await
                {
                    if !trickplay_is_enabled(&state, &library).await {
                        state
                            .active_trickplay_libraries
                            .lock()
                            .await
                            .remove(&library);
                        return;
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(60)) => {},
                        _ = state.trickplay_control_notify.notified() => {},
                    }
                }
            }
            let run_lock = state.trickplay_run_lock.lock().await;
            if run == TrickplayRun::Manual || max_speed || trickplay_idle_window(&state).await {
                break run_lock;
            }
            drop(run_lock);
        };
        tracing::info!(library = %library, videos = total_videos, pending = videos.len(), manual = run == TrickplayRun::Manual, "Starting resource-limited trickplay generation");
        let mut stopped_early = false;
        for video in videos {
            if !trickplay_is_enabled(&state, &library).await {
                tracing::info!(library = %library, "Stopped trickplay generation because previews were disabled");
                stopped_early = true;
                break;
            }
            if !wait_for_trickplay_resume(&state, &library).await {
                stopped_early = true;
                break;
            }
            match generate_trickplay_video(&state, &library, &video).await {
                TrickplayVideoResult::Generated => {
                    generated_videos += 1;
                    completed_videos += 1;
                }
                TrickplayVideoResult::AlreadyGenerated => completed_videos += 1,
                TrickplayVideoResult::Failed => failed_videos += 1,
            }
            let mut active = state.active_trickplay_libraries.lock().await;
            if let Some(trickplay) = active.get_mut(&library) {
                trickplay.completed_videos = completed_videos;
            }
        }
        tracing::info!(library = %library, videos = total_videos, generated = generated_videos, failed = failed_videos, stopped_early, "Finished background trickplay generation");
        if stopped_early {
            state
                .active_trickplay_libraries
                .lock()
                .await
                .remove(&library);
            return;
        }
        finish_trickplay_run(
            &state,
            &library,
            FinishedTrickplay {
                started_at,
                initiated_by,
                total_videos,
                generated_videos,
                failed_videos,
            },
        )
        .await;
    });
}

async fn finish_trickplay_run(state: &AppState, library: &str, finished: FinishedTrickplay) {
    state
        .finished_trickplay_libraries
        .lock()
        .await
        .insert(library.to_owned(), finished);
    state
        .active_trickplay_libraries
        .lock()
        .await
        .remove(library);
}

fn schedule_thumbnail_library(state: AppState, library: String) {
    if !is_library_path(&library) {
        return;
    }
    tokio::spawn(async move {
        let started_at = unix_now();
        {
            let mut active = state.active_thumbnail_libraries.lock().await;
            if active.contains_key(&library) {
                return;
            }
            active.insert(
                library.clone(),
                ActiveThumbnails {
                    started_at,
                    initiated_by: None,
                    current_file: None,
                    completed_files: 0,
                    total_files: 0,
                    inventory_complete: false,
                    paused_until: None,
                },
            );
        }
        state
            .finished_thumbnail_libraries
            .lock()
            .await
            .remove(&library);

        let (files, mut completed_files, total_files) = thumbnail_inventory(&state, &library).await;
        {
            let mut active = state.active_thumbnail_libraries.lock().await;
            if let Some(thumb) = active.get_mut(&library) {
                thumb.total_files = total_files;
                thumb.completed_files = completed_files;
                thumb.inventory_complete = true;
            }
        }
        let mut generated_files = 0;
        let mut failed_files = 0;
        if files.is_empty() {
            finish_thumbnail_run(
                &state,
                &library,
                FinishedThumbnails {
                    started_at,
                    initiated_by: None,
                    total_files,
                    generated_files,
                    failed_files,
                },
            )
            .await;
            return;
        }

        // Wait for idle to save resources
        loop {
            if trickplay_idle_window(&state).await {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(60)) => {},
                _ = state.thumbnail_control_notify.notified() => {},
            }
        }

        let _run_lock = state.thumbnail_run_lock.lock().await;
        for file in files {
            {
                let mut active = state.active_thumbnail_libraries.lock().await;
                if let Some(thumb) = active.get_mut(&library) {
                    thumb.current_file = file
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(ToOwned::to_owned);
                }
            }

            let success = generate_grid_thumb_for_file(&state, &file).await;
            if success {
                generated_files += 1;
                completed_files += 1;
            } else {
                failed_files += 1;
            }

            let mut active = state.active_thumbnail_libraries.lock().await;
            if let Some(thumb) = active.get_mut(&library) {
                thumb.completed_files = completed_files;
            }
        }

        finish_thumbnail_run(
            &state,
            &library,
            FinishedThumbnails {
                started_at,
                initiated_by: None,
                total_files,
                generated_files,
                failed_files,
            },
        )
        .await;
    });
}

async fn finish_thumbnail_run(state: &AppState, library: &str, finished: FinishedThumbnails) {
    state
        .finished_thumbnail_libraries
        .lock()
        .await
        .insert(library.to_owned(), finished);
    state
        .active_thumbnail_libraries
        .lock()
        .await
        .remove(library);
}

const BROWSER_MEDIA_PIPELINE_VERSION: &str = "v1-h264-copy-aac-stereo";
const BROWSER_MEDIA_COMPLETE_MARKER: &str = ".complete";

fn audio_codec_is_browser_compatible(codec: &str) -> bool {
    matches!(codec, "aac" | "mp3" | "opus" | "vorbis" | "flac")
}

fn video_codec_is_remux_safe(codec: &str) -> bool {
    matches!(codec, "h264")
}

fn browser_media_cache_key(video_path: &str, metadata: &std::fs::Metadata) -> String {
    let mut hasher = Sha256::new();
    hasher.update(BROWSER_MEDIA_PIPELINE_VERSION.as_bytes());
    hasher.update(video_path.as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(file_modified_secs(metadata).to_le_bytes());
    format!("{:x}", hasher.finalize())
}

fn browser_media_paths(browser_media_dir: &Path, key: &str) -> (PathBuf, PathBuf, PathBuf) {
    (
        browser_media_dir.join(format!("{key}.mp4")),
        browser_media_dir.join(format!("{key}.part")),
        browser_media_dir.join(format!("{key}{BROWSER_MEDIA_COMPLETE_MARKER}")),
    )
}

fn browser_media_is_complete(browser_media_dir: &Path, key: &str) -> bool {
    let (output, _, marker) = browser_media_paths(browser_media_dir, key);
    output.is_file() && marker.is_file()
}

fn probe_primary_stream_codecs(
    ffprobe_path: &Path,
    input: &Path,
) -> (Option<String>, Option<String>) {
    let probe = |stream: &str| -> Option<String> {
        let output = hidden_sync_command(ffprobe_path)
            .args([
                "-v",
                "error",
                "-select_streams",
                stream,
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(input)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let codec = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_ascii_lowercase();
        (!codec.is_empty()).then_some(codec)
    };
    (probe("v:0"), probe("a:0"))
}

fn file_needs_browser_media_remux(ffprobe_path: &Path, input: &Path) -> bool {
    let (video_codec, audio_codec) = probe_primary_stream_codecs(ffprobe_path, input);
    let Some(audio_codec) = audio_codec else {
        return false;
    };
    if audio_codec_is_browser_compatible(&audio_codec) {
        return false;
    }
    video_codec.is_some_and(|codec| video_codec_is_remux_safe(&codec))
}

fn is_browser_media_video_extension(extension: &str) -> bool {
    matches!(
        extension,
        "mp4"
            | "mkv"
            | "webm"
            | "mov"
            | "avi"
            | "m4v"
            | "mpeg"
            | "mpg"
            | "wmv"
            | "3gp"
            | "ts"
            | "m2ts"
    )
}

async fn browser_media_ready_url(
    state: &AppState,
    input: &Path,
    video_path: &str,
) -> Option<String> {
    let metadata = tokio::fs::metadata(input).await.ok()?;
    let key = browser_media_cache_key(video_path, &metadata);
    if browser_media_is_complete(&state.browser_media_dir, &key) {
        Some(format!("/browser-media/{key}.mp4"))
    } else {
        None
    }
}

fn schedule_browser_media_library(state: AppState, library: String) {
    if !is_library_path(&library) {
        return;
    }
    tokio::spawn(async move {
        let started_at = unix_now();
        {
            let mut active = state.active_browser_media_libraries.lock().await;
            if active.contains_key(&library) {
                return;
            }
            active.insert(
                library.clone(),
                ActiveBrowserMedia {
                    started_at,
                    initiated_by: None,
                    ffmpeg_pid: None,
                    current_file: None,
                    completed_files: 0,
                    total_files: 0,
                    inventory_complete: false,
                    paused_until: None,
                    max_speed: false,
                },
            );
        }
        state
            .finished_browser_media_libraries
            .lock()
            .await
            .remove(&library);

        let (files, mut completed_files, total_files) =
            browser_media_inventory(&state, &library).await;
        {
            let mut active = state.active_browser_media_libraries.lock().await;
            if let Some(browser_media) = active.get_mut(&library) {
                browser_media.total_files = total_files;
                browser_media.completed_files = completed_files;
                browser_media.inventory_complete = true;
            }
        }
        let mut generated_files = 0;
        let mut failed_files = 0;
        if files.is_empty() {
            finish_browser_media_run(
                &state,
                &library,
                FinishedBrowserMedia {
                    started_at,
                    initiated_by: None,
                    total_files,
                    generated_files,
                    failed_files,
                },
            )
            .await;
            return;
        }

        loop {
            if browser_media_max_speed(&state, &library).await
                || trickplay_idle_window(&state).await
            {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(60)) => {},
                _ = state.browser_media_control_notify.notified() => {},
            }
        }

        let _run_lock = state.thumbnail_run_lock.lock().await;
        for file in files {
            if !wait_for_browser_media_resume(&state, &library).await {
                state
                    .active_browser_media_libraries
                    .lock()
                    .await
                    .remove(&library);
                return;
            }
            {
                let mut active = state.active_browser_media_libraries.lock().await;
                if let Some(browser_media) = active.get_mut(&library) {
                    browser_media.current_file = file
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(ToOwned::to_owned);
                }
            }

            let success = generate_browser_media_file(&state, &library, &file).await;
            if success {
                generated_files += 1;
                completed_files += 1;
            } else {
                failed_files += 1;
            }

            let mut active = state.active_browser_media_libraries.lock().await;
            if let Some(browser_media) = active.get_mut(&library) {
                browser_media.completed_files = completed_files;
                browser_media.current_file = None;
            }
        }

        finish_browser_media_run(
            &state,
            &library,
            FinishedBrowserMedia {
                started_at,
                initiated_by: None,
                total_files,
                generated_files,
                failed_files,
            },
        )
        .await;
    });
}

async fn finish_browser_media_run(state: &AppState, library: &str, finished: FinishedBrowserMedia) {
    state
        .finished_browser_media_libraries
        .lock()
        .await
        .insert(library.to_owned(), finished);
    state
        .active_browser_media_libraries
        .lock()
        .await
        .remove(library);
}

async fn browser_media_inventory(state: &AppState, library: &str) -> (Vec<PathBuf>, usize, usize) {
    let root = state.library_root.join(library);
    let library_root = state.library_root.clone();
    let browser_media_dir = state.browser_media_dir.clone();
    let ffprobe_path = state.ffprobe_path.clone();
    tokio::task::spawn_blocking(move || {
        let files = walkdir::WalkDir::new(root)
            .follow_links(true)
            .into_iter()
            .filter_map(Result::ok)
            .map(|entry| entry.into_path())
            .filter(|path| path.is_file())
            .filter(|path| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .map(|value| is_browser_media_video_extension(&value.to_lowercase()))
                    .unwrap_or(false)
            })
            .filter(|path| file_needs_browser_media_remux(&ffprobe_path, path))
            .collect::<Vec<_>>();
        let total = files.len();
        let (complete, pending): (Vec<_>, Vec<_>) = files.into_iter().partition(|path| {
            let Ok(relative) = path.strip_prefix(&library_root) else {
                return false;
            };
            let Ok(metadata) = path.metadata() else {
                return false;
            };
            let key = browser_media_cache_key(&relative.to_string_lossy().replace('\\', "/"), &metadata);
            browser_media_is_complete(&browser_media_dir, &key)
        });
        (pending, complete.len(), total)
    })
    .await
    .unwrap_or_default()
}

async fn generate_browser_media_file(state: &AppState, library: &str, input: &Path) -> bool {
    if !state.ffmpeg_path.is_file() || !state.ffprobe_path.is_file() {
        return false;
    }
    let Ok(relative) = input.strip_prefix(&state.library_root) else {
        return false;
    };
    let video_path = relative.to_string_lossy().replace('\\', "/");
    let Ok(metadata) = tokio::fs::metadata(input).await else {
        return false;
    };
    if !file_needs_browser_media_remux(&state.ffprobe_path, input) {
        return true;
    }
    let key = browser_media_cache_key(&video_path, &metadata);
    if browser_media_is_complete(&state.browser_media_dir, &key) {
        return true;
    }
    let (output, partial, marker) = browser_media_paths(&state.browser_media_dir, &key);
    let _ = tokio::fs::create_dir_all(&state.browser_media_dir).await;
    let _ = tokio::fs::remove_file(&partial).await;
    let _ = tokio::fs::remove_file(&marker).await;
    let mut child = match hidden_async_command(&state.ffmpeg_path)
        .arg("-y")
        .arg("-i")
        .arg(input)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-b:a",
            "256k",
            "-movflags",
            "+faststart",
            // The atomic output ends in .part, so FFmpeg cannot infer MP4.
            "-f",
            "mp4",
        ])
        .arg(&partial)
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    {
        let mut active = state.active_browser_media_libraries.lock().await;
        if let Some(browser_media) = active.get_mut(library) {
            browser_media.ffmpeg_pid = child.id();
        }
    }
    let status = child.wait().await;
    {
        let mut active = state.active_browser_media_libraries.lock().await;
        if let Some(browser_media) = active.get_mut(library) {
            browser_media.ffmpeg_pid = None;
        }
    }
    let Ok(status) = status else {
        let _ = tokio::fs::remove_file(&partial).await;
        return false;
    };
    if !status.success() {
        let _ = tokio::fs::remove_file(&partial).await;
        tracing::warn!(video_path = %video_path, "Browser audio remux failed");
        return false;
    }
    if tokio::fs::rename(&partial, &output).await.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
        return false;
    }
    let _ = tokio::fs::write(&marker, b"ok").await;
    tracing::info!(video_path = %video_path, output = %output.display(), "Prepared browser-compatible audio remux");
    true
}

async fn remove_browser_media_for_trash_entry(state: &AppState, entry: &TrashEntry) {
    let original_path = entry.original_path.replace('\\', "/");
    let stored = state.trash_dir.join(&entry.stored_name);
    let Ok(metadata) = tokio::fs::metadata(&stored).await else {
        return;
    };
    let key = browser_media_cache_key(&original_path, &metadata);
    let (output, partial, marker) = browser_media_paths(&state.browser_media_dir, &key);
    let _ = tokio::fs::remove_file(output).await;
    let _ = tokio::fs::remove_file(partial).await;
    let _ = tokio::fs::remove_file(marker).await;
}

async fn thumbnail_inventory(state: &AppState, library: &str) -> (Vec<PathBuf>, usize, usize) {
    let root = state.library_root.join(library);
    let library_root = state.library_root.clone();
    let grid_thumbs_dir = state.grid_thumbs_dir.clone();
    tokio::task::spawn_blocking(move || {
        let files = walkdir::WalkDir::new(root)
            .follow_links(true)
            .into_iter()
            .filter_map(Result::ok)
            .map(|entry| entry.into_path())
            .filter(|path| path.is_file())
            .filter(|path| {
                let extension = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                matches!(
                    extension.as_str(),
                    "mp4"
                        | "mkv"
                        | "webm"
                        | "mov"
                        | "avi"
                        | "m4v"
                        | "mpeg"
                        | "mpg"
                        | "wmv"
                        | "3gp"
                        | "ts"
                        | "m2ts"
                        | "jpg"
                        | "jpeg"
                        | "png"
                        | "gif"
                        | "webp"
                        | "bmp"
                        | "tif"
                        | "tiff"
                        | "avif"
                        | "heic"
                        | "heif"
                )
            })
            .collect::<Vec<_>>();
        let total = files.len();
        let (complete, pending): (Vec<_>, Vec<_>) = files.into_iter().partition(|path| {
            let Ok(relative) = path.strip_prefix(&library_root) else {
                return false;
            };
            let Ok(metadata) = path.metadata() else {
                return false;
            };
            let key = grid_thumb_key(relative.to_str().unwrap_or(""), &metadata);
            grid_thumbs_dir.join(format!("{}.jpg", key)).is_file()
        });
        (pending, complete.len(), total)
    })
    .await
    .unwrap_or_default()
}

async fn generate_grid_thumb_for_file(state: &AppState, input: &Path) -> bool {
    let Ok(relative) = input.strip_prefix(&state.library_root) else {
        return false;
    };
    let Ok(metadata) = tokio::fs::metadata(input).await else {
        return false;
    };
    let relative_path = relative.to_str().unwrap_or("");
    let key = grid_thumb_key(relative_path, &metadata);
    let thumb_path = state.grid_thumbs_dir.join(format!("{}.jpg", key));

    if thumb_path.is_file() {
        return true;
    }
    let _ = tokio::fs::create_dir_all(&state.grid_thumbs_dir).await;

    let extension = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let is_video = matches!(
        extension.as_str(),
        "mp4"
            | "mkv"
            | "webm"
            | "mov"
            | "avi"
            | "m4v"
            | "mpeg"
            | "mpg"
            | "wmv"
            | "3gp"
            | "ts"
            | "m2ts"
    );

    if is_video {
        let trickplay_path = state
            .trickplay_dir
            .join(trickplay_key(relative_path, &metadata))
            .join("00000000.jpg");
        if trickplay_path.is_file() {
            let trickplay_path = trickplay_path.clone();
            let thumb_path = thumb_path.clone();
            return tokio::task::spawn_blocking(move || {
                let Ok(img) = image::open(&trickplay_path) else {
                    return false;
                };
                let resized = if img.width() > GRID_THUMB_MAX_WIDTH {
                    img.resize(
                        GRID_THUMB_MAX_WIDTH,
                        u32::MAX,
                        image::imageops::FilterType::Lanczos3,
                    )
                } else {
                    img
                };
                resized
                    .save_with_format(thumb_path, image::ImageFormat::Jpeg)
                    .is_ok()
            })
            .await
            .unwrap_or(false);
        }
        let scale_filter =
            format!("scale={GRID_THUMB_MAX_WIDTH}:-2:force_original_aspect_ratio=decrease");
        let output = hidden_async_command(&state.ffmpeg_path)
            .args(["-y", "-v", "error", "-i"])
            .arg(input)
            .args(["-vframes", "1", "-vf"])
            .arg(scale_filter)
            .args(["-q:v", "5"])
            .arg(&thumb_path)
            .output()
            .await;
        return output.is_ok() && thumb_path.is_file();
    } else {
        let input_clone = input.to_path_buf();
        let thumb_path_clone = thumb_path.clone();
        tokio::task::spawn_blocking(move || {
            if let Ok(img) = image::open(&input_clone) {
                let resized = if img.width() > GRID_THUMB_MAX_WIDTH {
                    img.resize(
                        GRID_THUMB_MAX_WIDTH,
                        u32::MAX,
                        image::imageops::FilterType::Lanczos3,
                    )
                } else {
                    img
                };
                let mut bytes = Vec::new();
                let mut cursor = std::io::Cursor::new(&mut bytes);
                if resized
                    .write_to(&mut cursor, image::ImageFormat::Jpeg)
                    .is_ok()
                {
                    let _ = std::fs::write(&thumb_path_clone, &bytes);
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false)
    }
}

/// Returns the videos still needing previews, how many are already generated,
/// and the library total. Cached durations answer completeness without probing,
/// which keeps a library of thousands of videos reporting its real percentage
/// within a moment of startup.
async fn trickplay_inventory(state: &AppState, library: &str) -> (Vec<PathBuf>, usize, usize) {
    let root = state.library_root.join(library);
    let library_root = state.library_root.clone();
    let trickplay_dir = state.trickplay_dir.clone();
    let durations = state.library_duration_cache.lock().await.clone();
    tokio::task::spawn_blocking(move || {
        let videos = WalkDir::new(root)
            .follow_links(true)
            .into_iter()
            .filter_map(Result::ok)
            .map(|entry| entry.into_path())
            .filter(|path| path.is_file() && is_video_file(path))
            .collect::<Vec<_>>();
        let total = videos.len();
        let (complete, pending): (Vec<_>, Vec<_>) = videos.into_iter().partition(|path| {
            let Ok(relative) = path.strip_prefix(&library_root) else {
                return false;
            };
            let Ok(metadata) = path.metadata() else {
                return false;
            };
            let video_path = relative.to_string_lossy().replace('\\', "/");
            let duration = durations
                .get(&video_path)
                .filter(|cached| {
                    cached.size == metadata.len()
                        && cached.modified_at == file_modified_secs(&metadata)
                })
                .and_then(|cached| cached.duration);
            trickplay_is_complete(
                &trickplay_dir.join(trickplay_key(&video_path, &metadata)),
                duration,
            )
        });
        (pending, complete.len(), total)
    })
    .await
    .unwrap_or_default()
}

fn trickplay_keys_under(root: &Path, logical_prefix: &str) -> Vec<String> {
    if root.is_file() {
        if !is_video_file(root) {
            return Vec::new();
        }
        return root
            .metadata()
            .ok()
            .map(|metadata| vec![trickplay_key(logical_prefix, &metadata)])
            .unwrap_or_default();
    }
    WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() || !is_video_file(path) {
                return None;
            }
            let relative = path.strip_prefix(root).ok()?;
            let metadata = path.metadata().ok()?;
            let video_path = format!(
                "{logical_prefix}/{}",
                relative.to_string_lossy().replace('\\', "/")
            );
            Some(trickplay_key(&video_path, &metadata))
        })
        .collect()
}

/// Trashed media keeps its previews so a restore stays instant; only permanent
/// deletion discards them.
async fn remove_trickplay_for_trash_entry(state: &AppState, entry: &TrashEntry) {
    let stored = trash_storage_path(state, entry);
    let trickplay_dir = state.trickplay_dir.clone();
    let original_path = entry.original_path.clone();
    let removed = tokio::task::spawn_blocking(move || {
        trickplay_keys_under(&stored, &original_path)
            .into_iter()
            .filter(|key| {
                let directory = trickplay_dir.join(key);
                directory.is_dir() && std::fs::remove_dir_all(&directory).is_ok()
            })
            .count()
    })
    .await
    .unwrap_or(0);
    if removed > 0 {
        tracing::info!(path = %entry.original_path, removed, "Discarded timeline previews for permanently deleted media");
    }
}

/// Previews for media that vanished without passing through Trash (an outside
/// deletion, a rename, or a move) would otherwise sit in the cache forever.
fn spawn_trickplay_cache_sweep(state: AppState) {
    tokio::spawn(async move {
        let entries = read_trash(&state).await;
        let trickplay_dir = state.trickplay_dir.clone();
        let library_root = state.library_root.clone();
        let trash_dir = state.trash_dir.clone();
        let trash_paths = entries
            .iter()
            .map(|entry| {
                (
                    trash_storage_path(&state, entry),
                    entry.original_path.clone(),
                )
            })
            .collect::<Vec<_>>();
        let removed = tokio::task::spawn_blocking(move || {
            // Losing the trash list would make every trashed item look gone, so
            // stop rather than discard previews a restore still needs.
            if trash_paths.is_empty()
                && WalkDir::new(&trash_dir)
                    .into_iter()
                    .filter_map(Result::ok)
                    .any(|entry| entry.path().is_file() && is_video_file(entry.path()))
            {
                tracing::warn!(
                    "Skipped the timeline-preview sweep because trashed media has no trash record"
                );
                return 0;
            }
            // Listing the cache before scanning media means a preview created
            // while the scan runs is never mistaken for an orphan.
            let cached = std::fs::read_dir(&trickplay_dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
                // Legacy unversioned 480px directories are intentionally
                // retained. They are no longer read now that the cache key has
                // a version prefix, but deleting them would defeat migration.
                .filter(|name| {
                    name.strip_prefix(&format!("{TRICKPLAY_CACHE_VERSION}-"))
                        .is_some_and(|key| {
                            key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())
                        })
                })
                .collect::<Vec<_>>();
            if cached.is_empty() {
                return 0;
            }
            let mut referenced = HashSet::new();
            // Mounted folders are junctions; missing the media behind one would
            // discard previews that are still in use.
            for entry in WalkDir::new(&library_root)
                .follow_links(true)
                .into_iter()
                .filter_entry(|entry| entry.file_name() != OsStr::new(".tms-data"))
                .filter_map(Result::ok)
            {
                let path = entry.path();
                if !path.is_file() || !is_video_file(path) {
                    continue;
                }
                let Ok(relative) = path.strip_prefix(&library_root) else {
                    continue;
                };
                let Ok(metadata) = path.metadata() else {
                    continue;
                };
                referenced.insert(trickplay_key(
                    &relative.to_string_lossy().replace('\\', "/"),
                    &metadata,
                ));
            }
            for (stored, original_path) in &trash_paths {
                referenced.extend(trickplay_keys_under(stored, original_path));
            }
            cached
                .into_iter()
                .filter(|key| !referenced.contains(key))
                .filter(|key| std::fs::remove_dir_all(trickplay_dir.join(key)).is_ok())
                .count()
        })
        .await
        .unwrap_or(0);
        if removed > 0 {
            tracing::info!(
                removed,
                "Removed timeline previews for media that no longer exists"
            );
        }
    });
}

async fn trickplay_is_enabled(state: &AppState, library: &str) -> bool {
    read_libraries(state)
        .await
        .get(library)
        .is_some_and(|config| config.trickplay_enabled)
}

async fn browser_media_max_speed(state: &AppState, library: &str) -> bool {
    state
        .active_browser_media_libraries
        .lock()
        .await
        .get(library)
        .is_some_and(|browser_media| browser_media.max_speed)
}

async fn wait_for_browser_media_resume(state: &AppState, library: &str) -> bool {
    loop {
        let paused_until = state
            .active_browser_media_libraries
            .lock()
            .await
            .get(library)
            .and_then(|browser_media| browser_media.paused_until);
        let Some(paused_until) = paused_until else {
            return true;
        };
        if paused_until <= unix_now() {
            let mut active = state.active_browser_media_libraries.lock().await;
            if let Some(browser_media) = active.get_mut(library) {
                browser_media.paused_until = None;
            }
            return true;
        }
        let remaining = paused_until.saturating_sub(unix_now());
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(remaining.min(60))) => {},
            _ = state.browser_media_control_notify.notified() => {},
        }
    }
}

async fn trickplay_max_speed(state: &AppState, library: &str) -> bool {
    state
        .active_trickplay_libraries
        .lock()
        .await
        .get(library)
        .is_some_and(|trickplay| trickplay.max_speed)
}

async fn wait_for_trickplay_resume(state: &AppState, library: &str) -> bool {
    loop {
        if !trickplay_is_enabled(state, library).await {
            return false;
        }
        let paused_until = state
            .active_trickplay_libraries
            .lock()
            .await
            .get(library)
            .and_then(|trickplay| trickplay.paused_until);
        let now = unix_now();
        let Some(until) = paused_until.filter(|until| *until > now) else {
            return true;
        };
        tokio::time::sleep(Duration::from_secs((until - now).min(60))).await;
    }
}

fn preview_completion(total: usize, failed: usize) -> f64 {
    if total == 0 { 1.0 } else { total.saturating_sub(failed) as f64 / total as f64 }
}

fn background_work_status(running: bool, paused: bool, inventoried: bool, idle: bool, max_speed: bool) -> &'static str {
    if paused { "paused" }
    else if running { "running" }
    else if !inventoried { "scanning library" }
    else if !idle && !max_speed { "waiting for computer idle" }
    else { "waiting for worker" }
}

// Completed HLS output remains available to viewers. Only the process registry
// is cleaned up; finished children must not keep the idle scheduler blocked.
async fn reap_finished_transcodes(state: &AppState) {
    prune_finished_transcodes(&mut *state.active_transcodes.lock().await);
}

fn prune_finished_transcodes(active: &mut BTreeMap<String, ActiveTranscode>) {
    active.retain(|key, transcode| {
        match transcode.child.try_wait() {
            Ok(Some(status)) => {
                tracing::info!(transcode_key = %key, success = status.success(), "Removed exited FFmpeg from active work");
                false
            }
            Ok(None) => true,
            Err(error) => {
                tracing::warn!(transcode_key = %key, %error, "Could not check FFmpeg process status");
                true
            }
        }
    });
}

async fn trickplay_idle_window(state: &AppState) -> bool {
    reap_finished_transcodes(state).await;
    if !state.active_transcodes.lock().await.is_empty()
        || !state.active_downloads.lock().await.is_empty()
    {
        return false;
    }
    let mut playback = state.active_playback.lock().await;
    playback.retain(|_, playback| playback.started_at.elapsed() < TRICKPLAY_PLAYBACK_GRACE);
    if !playback.is_empty() {
        return false;
    }
    user_idle_for(TRICKPLAY_IDLE_DELAY)
}

fn user_idle_for(minimum: Duration) -> bool {
    #[cfg(windows)]
    unsafe {
        let mut input = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut input) == 0 {
            return false;
        }
        return GetTickCount().wrapping_sub(input.dwTime) as u64 >= minimum.as_millis() as u64;
    }
    #[cfg(not(windows))]
    {
        let _ = minimum;
        true
    }
}

// FFmpeg's fps filter maps each source timestamp to the nearest output slot, so
// a ten-second interval yields round(duration / 10) thumbnails rather than one
// per started interval. Measured against the bundled FFmpeg build on both sides
// of several interval boundaries; guessing high here makes every affected video
// look unfinished and regenerate on every run.
fn trickplay_expected_frames(duration: f64) -> u64 {
    if !duration.is_finite() || duration <= 0.0 {
        return 1;
    }
    ((duration / TRICKPLAY_INTERVAL_SECONDS) + 0.5)
        .floor()
        .clamp(1.0, u32::MAX as f64) as u64
}

fn trickplay_frame_name(index: u64) -> String {
    format!("{index:08}.jpg")
}

fn trickplay_frames_on_disk(output_dir: &Path) -> (u64, Option<u64>) {
    let mut count = 0;
    let mut highest = None;
    for entry in std::fs::read_dir(output_dir)
        .into_iter()
        .flatten()
        .flatten()
    {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(index) = name
            .strip_suffix(".jpg")
            .filter(|index| index.len() == 8)
            .and_then(|index| index.parse::<u64>().ok())
        else {
            continue;
        };
        count += 1;
        if highest.is_none_or(|current| index > current) {
            highest = Some(index);
        }
    }
    (count, highest)
}

fn trickplay_eta_seconds(output_dir: &Path, started_at: u64, expected_frames: u64) -> Option<u64> {
    // Estimate this file's remaining encode time from frames written in the
    // current run; the library's cached-video percentage is not item progress.
    let now = unix_now();
    let elapsed = now.saturating_sub(started_at);
    if elapsed < 5 || expected_frames == 0 {
        return None;
    }
    let completed_frames = std::fs::read_dir(output_dir)
        .ok()?
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { return false };
            let is_frame = name
                .strip_suffix(".jpg")
                .is_some_and(|index| index.len() == 8 && index.bytes().all(|byte| byte.is_ascii_digit()));
            is_frame
                && entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                    .is_some_and(|modified| modified.as_secs() >= started_at)
        })
        .count() as u64;
    if completed_frames >= expected_frames {
        return Some(1);
    }
    if completed_frames == 0 {
        return None;
    }
    let remaining = expected_frames - completed_frames;
    Some(
        ((elapsed as f64 * remaining as f64 / completed_frames as f64).ceil() as u64)
            .clamp(1, 86_400),
    )
}

fn write_trickplay_marker(output_dir: &Path, last_frame: u64) {
    let _ = std::fs::write(
        output_dir.join(TRICKPLAY_COMPLETE_MARKER),
        trickplay_frame_name(last_frame),
    );
}

fn trickplay_marker_is_valid(output_dir: &Path) -> bool {
    std::fs::read_to_string(output_dir.join(TRICKPLAY_COMPLETE_MARKER))
        .ok()
        .map(|frame| frame.trim().to_owned())
        .filter(|frame| !frame.is_empty())
        .is_some_and(|frame| output_dir.join(frame).is_file())
}

/// Previews finished before markers existed are recognised by their frames, and
/// recording a marker keeps every later check down to two file lookups. One
/// missing tail frame still counts as finished so a video whose real frame count
/// differs from the estimate is never rebuilt forever.
fn trickplay_is_complete(output_dir: &Path, duration: Option<f64>) -> bool {
    if trickplay_marker_is_valid(output_dir) {
        return true;
    }
    let Some(duration) = duration.filter(|duration| duration.is_finite() && *duration > 0.0) else {
        return false;
    };
    let expected = trickplay_expected_frames(duration);
    let (present, highest) = trickplay_frames_on_disk(output_dir);
    let Some(highest) = highest.filter(|_| present >= expected.saturating_sub(1).max(1)) else {
        return false;
    };
    write_trickplay_marker(output_dir, highest);
    true
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TrickplayVideoResult {
    AlreadyGenerated,
    Generated,
    Failed,
}

async fn generate_trickplay_video(
    state: &AppState,
    library: &str,
    input: &Path,
) -> TrickplayVideoResult {
    if !state.ffmpeg_path.is_file() || !state.ffprobe_path.is_file() {
        return TrickplayVideoResult::Failed;
    }
    let Ok(relative) = input.strip_prefix(&state.library_root) else {
        return TrickplayVideoResult::Failed;
    };
    let video_path = relative.to_string_lossy().replace('\\', "/");
    if !video_path.starts_with(&format!("{library}/")) {
        return TrickplayVideoResult::Failed;
    }
    let Ok(metadata) = tokio::fs::metadata(input).await else {
        return TrickplayVideoResult::Failed;
    };
    let key = trickplay_key(&video_path, &metadata);
    let output_dir = state.trickplay_dir.join(key);
    if trickplay_marker_is_valid(&output_dir) {
        return TrickplayVideoResult::AlreadyGenerated;
    }
    let probe = hidden_async_command(&state.ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(input)
        .output()
        .await;
    let duration = probe
        .ok()
        .filter(|result| result.status.success())
        .and_then(|result| String::from_utf8(result.stdout).ok())
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0);
    let Some(duration) = duration else {
        return TrickplayVideoResult::Failed;
    };
    if trickplay_is_complete(&output_dir, Some(duration)) {
        return TrickplayVideoResult::AlreadyGenerated;
    }
    if tokio::fs::create_dir_all(&output_dir).await.is_err() {
        return TrickplayVideoResult::Failed;
    }
    let pattern = output_dir.join("%08d.jpg");
    let max_speed = trickplay_max_speed(state, library).await;
    let mut command = hidden_async_command(&state.ffmpeg_path);
    command
        .args([
            "-y",
            "-v",
            "error",
            "-threads",
            if max_speed { "0" } else { "1" },
            "-filter_threads",
            if max_speed { "0" } else { "1" },
            "-i",
        ])
        .arg(input)
        .args(["-vf", &format!("fps=1/{TRICKPLAY_INTERVAL_SECONDS},scale=960:-2:force_original_aspect_ratio=decrease"), "-q:v", "5", "-start_number", "0"])
        .arg(pattern);
    #[cfg(windows)]
    command.as_std_mut().creation_flags(
        0x0800_0000
            | if max_speed {
                HIGH_PRIORITY_CLASS
            } else {
                IDLE_PRIORITY_CLASS
            },
    );
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return TrickplayVideoResult::Failed,
    };
    let pid = child.id();
    tracing::info!(library = %library, video_path = %video_path, pid = ?pid, max_speed, "Launched FFmpeg timeline-preview generation");
    {
        let mut active = state.active_trickplay_libraries.lock().await;
        if let Some(trickplay) = active.get_mut(library) {
            trickplay.ffmpeg_pid = pid;
            trickplay.current_video = Some(video_path.clone());
            trickplay.current_output_dir = Some(output_dir.clone());
            trickplay.current_video_started_at = Some(unix_now());
            trickplay.current_expected_frames = Some(trickplay_expected_frames(duration));
        }
    }
    let status = child.wait().await;
    {
        let mut active = state.active_trickplay_libraries.lock().await;
        if let Some(trickplay) = active.get_mut(library) {
            trickplay.ffmpeg_pid = None;
            trickplay.current_output_dir = None;
            trickplay.current_video_started_at = None;
            trickplay.current_expected_frames = None;
        }
    }
    let succeeded = status.as_ref().is_ok_and(|value| value.success());
    let frames = trickplay_frames_on_disk(&output_dir);
    tracing::info!(library = %library, video_path = %video_path, pid = ?pid, success = succeeded, frames = frames.0, expected_frames = trickplay_expected_frames(duration), "Finished FFmpeg timeline-preview generation");
    // The marker records the frame FFmpeg actually wrote last, so a rerun never
    // depends on predicting that count a second time.
    match frames.1.filter(|_| succeeded) {
        Some(last_frame) => {
            write_trickplay_marker(&output_dir, last_frame);
            TrickplayVideoResult::Generated
        }
        None => {
            tracing::debug!(video_path = %video_path, "Could not generate trickplay frames");
            TrickplayVideoResult::Failed
        }
    }
}

async fn qualities(
    State(state): State<AppState>,
    Query(query): Query<VideoPathQuery>,
) -> Result<Json<QualityResponse>, StatusCode> {
    let input = safe_library_path(&state.library_root, &query.video_path)?;
    let modified = tokio::fs::metadata(&input)
        .await
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    if modified > 0 {
        let cache = state.quality_cache.lock().await;
        if let Some((cached_modified, resp)) = cache.get(&query.video_path) {
            if *cached_modified == modified {
                let mut response = resp.clone();
                drop(cache);
                // A background remux can finish after the first quality probe.
                // Do not keep returning its old missing URL until server restart.
                if !response.audio_compatible {
                    response.browser_media_url =
                        browser_media_ready_url(&state, &input, &query.video_path).await;
                }
                return Ok(Json(response));
            }
        }
    }

    // Read video, audio languages and duration in one file probe.
    let output = hidden_async_command(&state.ffprobe_path)
        .args(["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,height:stream_tags=language,title:stream_disposition=default:format=duration", "-of", "json"])
        .arg(&input).output().await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    if !output.status.success() { return Err(StatusCode::UNPROCESSABLE_ENTITY); }
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
    let streams = probe.get("streams").and_then(serde_json::Value::as_array).ok_or(StatusCode::UNPROCESSABLE_ENTITY)?;
    let source_height = streams.iter().find(|stream| stream["codec_type"] == "video")
        .and_then(|stream| stream["height"].as_u64()).and_then(|height| u32::try_from(height).ok()).ok_or(StatusCode::UNPROCESSABLE_ENTITY)?;
    let audio_tracks = streams.iter().filter(|stream| stream["codec_type"] == "audio").filter_map(|stream| {
        let stream_index = u32::try_from(stream["index"].as_u64()?).ok()?;
        let language = stream["tags"]["language"].as_str().unwrap_or("und").to_owned();
        let language_label = match language.trim().to_ascii_lowercase().as_str() {
            "en" | "eng" | "english" => "English", "ja" | "jpn" | "japanese" => "Japanese", "und" => "Unknown", _ => &language,
        };
        let label = stream["tags"]["title"].as_str().filter(|title| !title.trim().is_empty())
            .map(|title| format!("{language_label} — {title}")).unwrap_or_else(|| language_label.to_owned());
        Some(AudioTrack { stream_index, label, language, is_default: stream["disposition"]["default"].as_i64() == Some(1) })
    }).collect::<Vec<_>>();
    let preferred_audio = default_audio_stream(&audio_tracks);
    let audio_codec = streams.iter().find(|stream| stream["index"].as_u64() == preferred_audio.map(u64::from))
        .and_then(|stream| stream["codec_name"].as_str()).map(str::to_ascii_lowercase);
    let duration = probe["format"]["duration"].as_str().and_then(|value| value.parse::<f64>().ok()).filter(|value| value.is_finite() && *value > 0.0);
    let audio_compatible = audio_codec
        .as_deref()
        .is_none_or(|codec| matches!(codec, "aac" | "mp3" | "opus" | "vorbis" | "flac"));
    if !audio_compatible {
        tracing::info!(audio_codec = ?audio_codec, video_path = %query.video_path, "Original media needs AAC transcoding for browser audio");
        if browser_media_ready_url(&state, &input, &query.video_path)
            .await
            .is_none()
        {
            if let Some(library) = query.video_path.split('/').next() {
                if is_library_path(library) {
                    schedule_browser_media_library(state.clone(), library.to_owned());
                }
            }
        }
    }
    let mut levels = [1080, 720, 480, 360]
        .into_iter()
        .filter(|height| *height <= source_height)
        .collect::<Vec<_>>();
    // A source can have a non-standard display height (for example, 1036p
    // Blu-ray video). Original + AAC still needs an HLS transcode when its
    // audio is unsupported by browsers, so its exact height must be valid.
    if !levels.contains(&source_height) {
        levels.insert(0, source_height);
    }
    let response = QualityResponse {
        source_height,
        levels,
        audio_codec: audio_codec.clone(),
        audio_compatible,
        audio_tracks,
        duration,
        browser_media_url: if audio_compatible {
            None
        } else {
            browser_media_ready_url(&state, &input, &query.video_path).await
        },
    };
    if modified > 0 {
        let mut cache = state.quality_cache.lock().await;
        cache.insert(query.video_path, (modified, response.clone()));
    }
    Ok(Json(response))
}

fn default_audio_stream(tracks: &[AudioTrack]) -> Option<u32> {
    tracks.iter().find(|track| matches!(track.language.trim().to_ascii_lowercase().as_str(), "en" | "eng" | "english"))
        .or_else(|| tracks.iter().find(|track| track.is_default)).or_else(|| tracks.first()).map(|track| track.stream_index)
}

async fn transcode(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TranscodeQuery>,
) -> Result<Json<TranscodeResponse>, StatusCode> {
    let input = safe_library_path(&state.library_root, &query.video_path)?;
    let start = query.start.unwrap_or(0.0).max(0.0).floor() as u64;
    let buffer_size_mb = query.buffer_size_mb.unwrap_or(500);
    if !matches!(buffer_size_mb, 100 | 250 | 500) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let session = query
        .session
        .filter(|value| !value.trim().is_empty() && value.len() <= 128)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let initiated_by = authenticated_user(&state, &headers)
        .await
        .map(|user| user.name);
    tracing::info!(
        reason = "playback_hls_request",
        video_path = %query.video_path,
        quality = %query.quality,
        start_seconds = start,
        buffer_size_mb,
        preload = query.preload,
        audio_stream = ?query.audio_stream,
        session = %session,
        attempt_id = ?query.attempt_id,
        "Received request that may launch FFmpeg"
    );
    if !state.ffmpeg_path.is_file() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let source = qualities(
        State(state.clone()),
        Query(VideoPathQuery {
            video_path: query.video_path.clone(),
        }),
    )
    .await?
    .0;
    let audio_stream = query.audio_stream.or_else(|| default_audio_stream(&source.audio_tracks));
    if let Some(stream) = audio_stream {
        if !source
            .audio_tracks
            .iter()
            .any(|track| track.stream_index == stream)
        {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    let subtitle_stream = if let Some(stream) = query.subtitle_stream {
        let embedded = embedded_subtitle_streams(&state, &input).await;
        if !embedded.iter().any(|track| track.index == stream && track.burn_in) {
            return Err(StatusCode::BAD_REQUEST);
        }
        Some(stream)
    } else {
        None
    };
    if query.preload && query.quality == "auto" { return Err(StatusCode::BAD_REQUEST); }
    if query.quality == "auto" {
        if source.levels.is_empty() {
            return Err(StatusCode::UNPROCESSABLE_ENTITY);
        }
        let mut master = "#EXTM3U\n#EXT-X-VERSION:3\n".to_owned();
        let encoded_video_path = urlencoding::encode(&query.video_path);
        let encoded_session = urlencoding::encode(&session);
        let encoded_attempt = query
            .attempt_id
            .as_deref()
            .map(|id| format!("&attempt_id={}", urlencoding::encode(id)))
            .unwrap_or_default();
        let audio_param = audio_stream.map(|stream| format!("&audio_stream={stream}")).unwrap_or_default();
        let subtitle_param = subtitle_stream.map(|stream| format!("&subtitle_stream={stream}")).unwrap_or_default();
        for height in &source.levels {
            let bandwidth = bitrate_for_height(*height) * 1000;
            master.push_str(&format!(
                "#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},RESOLUTION={}x{height}\n/api/transcode/variant?video_path={encoded_video_path}&height={height}&start={start}&session={encoded_session}{encoded_attempt}{audio_param}{subtitle_param}\n",
                height * 16 / 9,
            ));
        }
        let mut hasher = DefaultHasher::new();
        query.video_path.hash(&mut hasher);
        "auto".hash(&mut hasher);
        start.hash(&mut hasher);
        session.hash(&mut hasher);
        audio_stream.hash(&mut hasher);
        subtitle_stream.hash(&mut hasher);
        let key = format!("{:016x}", hasher.finish());
        let _guard = state.transcode_start_lock.lock().await;
        if !input.is_file() { return Err(StatusCode::NOT_FOUND); }
        let directory = state.transcodes_dir.join(&key);
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        tokio::fs::write(directory.join("source-path.txt"), &query.video_path)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        tokio::fs::write(directory.join("master.m3u8"), master)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return Ok(Json(TranscodeResponse {
            url: format!("/transcodes/{key}/master.m3u8"),
            offset: start as f64,
            session,
        }));
    }
    let height = query
        .quality
        .parse::<u32>()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if !source.levels.contains(&height) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let (key, url) = transcode_key_and_url(&query.video_path, height, start, audio_stream, subtitle_stream);
    ensure_transcode(
        &state,
        &input,
        height,
        source.source_height,
        start,
        &key,
        &session,
        initiated_by,
        query.attempt_id.as_deref(),
        audio_stream,
        subtitle_stream,
        query.preload,
    )
    .await?;
    Ok(Json(TranscodeResponse {
        url,
        offset: start as f64,
        session,
    }))
}

async fn auto_transcode_variant(
    State(state): State<AppState>,
    Query(query): Query<AutoTranscodeVariantQuery>,
) -> Result<Redirect, StatusCode> {
    if query.session.trim().is_empty() || query.session.len() > 128 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let input = safe_library_path(&state.library_root, &query.video_path)?;
    let source = qualities(
        State(state.clone()),
        Query(VideoPathQuery {
            video_path: query.video_path.clone(),
        }),
    )
    .await?
    .0;
    if !source.levels.contains(&query.height) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let audio_stream = query.audio_stream.or_else(|| default_audio_stream(&source.audio_tracks));
    if let Some(stream) = audio_stream {
        if !source
            .audio_tracks
            .iter()
            .any(|track| track.stream_index == stream)
        {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    let subtitle_stream = if let Some(stream) = query.subtitle_stream {
        let embedded = embedded_subtitle_streams(&state, &input).await;
        if !embedded.iter().any(|track| track.index == stream && track.burn_in) {
            return Err(StatusCode::BAD_REQUEST);
        }
        Some(stream)
    } else {
        None
    };
    let (key, url) =
        transcode_key_and_url(&query.video_path, query.height, query.start, audio_stream, subtitle_stream);
    ensure_transcode(
        &state,
        &input,
        query.height,
        source.source_height,
        query.start,
        &key,
        &query.session,
        None,
        query.attempt_id.as_deref(),
        audio_stream,
        subtitle_stream,
        false,
    )
    .await?;
    Ok(Redirect::temporary(&url))
}

async fn cancel_transcode(
    State(state): State<AppState>,
    Query(query): Query<CancelTranscodeQuery>,
) -> StatusCode {
    // Serialize cancellation with startup directory ownership. A following
    // session can then join the same child instead of observing a transient
    // marker with no registered process.
    let _start_guard = state.transcode_start_lock.lock().await;
    let mut stopped = Vec::new();
    {
        let mut active = state.active_transcodes.lock().await;
        let keys = active
            .iter_mut()
            .filter_map(|(key, transcode)| {
                transcode.sessions.remove(&query.session);
                transcode.sessions.is_empty().then(|| key.clone())
            })
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(transcode) = active.remove(&key) {
                stopped.push((key, transcode));
            }
        }
    }

    for (key, mut transcode) in stopped {
        let still_running = transcode.child.try_wait().ok().flatten().is_none();
        if still_running {
            let _ = transcode.child.start_kill();
            let _ = transcode.child.wait().await;
            let mut removed = false;
            for attempt in 0..5 {
                match tokio::fs::remove_dir_all(&transcode.directory).await {
                    Ok(()) => {
                        removed = true;
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        removed = true;
                        break;
                    }
                    Err(_) if attempt < 4 => {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    Err(error) => {
                        tracing::warn!(
                            transcode_key = %key,
                            directory = %transcode.directory.display(),
                            error = %error,
                            "Could not remove cancelled partial HLS cache"
                        );
                    }
                }
            }
            if !removed {
                let _ = tokio::fs::remove_file(transcode.directory.join("started")).await;
            }
            tracing::info!(transcode_key = %key, session = %query.session, pid = ?transcode.child.id(), video_path = %transcode.video_path, initiated_by = ?transcode.initiated_by, reason = "last_viewer_left", "Stopped unused FFmpeg transcode");
        }
    }
    StatusCode::NO_CONTENT
}

async fn stop_transcodes_for_path(state: &AppState, path: &str) {
    let path = path.trim_end_matches('/');
    let prefix = format!("{path}/");
    let mut stopped = Vec::new();
    {
        let mut active = state.active_transcodes.lock().await;
        let keys = active
            .iter()
            .filter_map(|(key, transcode)| {
                (transcode.video_path == path || transcode.video_path.starts_with(&prefix))
                    .then(|| key.clone())
            })
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(transcode) = active.remove(&key) {
                stopped.push((key, transcode));
            }
        }
    }
    for (key, mut transcode) in stopped {
        if transcode.child.try_wait().ok().flatten().is_none() {
            let _ = transcode.child.start_kill();
            let _ = transcode.child.wait().await;
        }
        if let Err(error) = tokio::fs::remove_dir_all(&transcode.directory).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    transcode_key = %key,
                    directory = %transcode.directory.display(),
                    %error,
                    "Could not remove transcode cache before trashing media"
                );
            }
        }
        tracing::info!(transcode_key = %key, path, pid = ?transcode.child.id(), initiated_by = ?transcode.initiated_by, reason = "media_trashed", "Stopped active FFmpeg transcode before trashing media");
    }
}

// Legacy logs can refer to the previous location of the media root.
fn logical_transcode_source(source: &str, library_root: &Path) -> Option<String> {
    let source = source.replace('\\', "/");
    let root = library_root.to_string_lossy().replace('\\', "/");
    let relative = if let Some(relative) = source.strip_prefix(&format!("{root}/")) {
        relative
    } else if let Some((_, relative)) = source.split_once("/TariqsMediaServer/") {
        relative
    } else if let Some((_, relative)) = source.split_once("/TariqsMeidaServer/") {
        relative
    } else if !Path::new(&source).is_absolute() && !source.contains(':') {
        source.as_str()
    } else {
        return None;
    };
    if !safe_relative_path(relative) { return None; }
    Some(relative.to_owned())
}

fn transcode_cache_source(directory: &Path, library_root: &Path) -> Option<String> {
    if let Ok(source) = std::fs::read_to_string(directory.join("source-path.txt")) {
        return logical_transcode_source(source.trim(), library_root);
    }
    // Old automatic-quality master playlists include the source in each URL.
    if let Ok(master) = std::fs::read_to_string(directory.join("master.m3u8")) {
        for line in master.lines() {
            if let Some((_, query)) = line.split_once('?') {
                for parameter in query.split('&') {
                    if let Some(encoded) = parameter.strip_prefix("video_path=") {
                        let source = urlencoding::decode(encoded).ok()?;
                        return logical_transcode_source(&source, library_root);
                    }
                }
            }
        }
    }
    // Read only through the input header, even for large FFmpeg logs.
    use std::io::BufRead;
    let log = std::fs::File::open(directory.join("ffmpeg.log")).ok()?;
    for line in std::io::BufReader::new(log).lines().take(256) {
        let line = line.ok()?;
        if line.starts_with("Input #0,") {
            let (_, source) = line.split_once(", from '")?;
            return logical_transcode_source(source.strip_suffix("':")?, library_root);
        }
    }
    None
}

async fn write_transcode_source(state: &AppState, input: &Path, directory: &Path) -> Result<(), StatusCode> {
    let source = input.strip_prefix(&state.library_root)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .to_string_lossy().replace('\\', "/");
    tokio::fs::write(directory.join("source-path.txt"), source).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn remove_transcode_caches(root: &Path, library_root: &Path, original_path: &str) -> std::io::Result<usize> {
    let directories = match std::fs::read_dir(&root) {
        Ok(directories) => directories,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut removed = 0;
    for directory in directories {
        let directory = directory?;
        // Never follow a cache-directory symlink outside this cache root.
        if !directory.file_type()?.is_dir() { continue; }
        if transcode_cache_source(&directory.path(), &library_root)
            .is_some_and(|source| path_is_within(&source, &original_path)) {
            match std::fs::remove_dir_all(directory.path()) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(error),
            }
        }
    }
    Ok(removed)
}

async fn remove_transcodes_for_trash_entry(state: &AppState, entry: &TrashEntry) -> std::io::Result<()> {
    // Serialize cache creation and removal; stop any remaining child first.
    let _guard = state.transcode_start_lock.lock().await;
    stop_transcodes_for_path(state, &entry.original_path).await;
    let root = state.transcodes_dir.clone();
    let library_root = state.library_root.clone();
    let original_path = entry.original_path.replace('\\', "/");
    let removed = tokio::task::spawn_blocking(move || -> std::io::Result<usize> {
        remove_transcode_caches(&root, &library_root, &original_path)
    }).await.map_err(std::io::Error::other)?;
    let removed = removed.map_err(|error| {
        tracing::error!(path = %entry.original_path, %error, "Could not discard HLS transcodes for permanently deleted media");
        error
    })?;
    tracing::info!(path = %entry.original_path, removed, "Discarded HLS transcodes for permanently deleted media");
    Ok(())
}

fn transcode_key_and_url(
    video_path: &str,
    height: u32,
    start: u64,
    audio_stream: Option<u32>,
    subtitle_stream: Option<u32>,
) -> (String, String) {
    let mut hasher = DefaultHasher::new();
    // Keep this version in the cache key so streams produced with an older,
    // browser-incompatible pixel format are never reused.
    "v16-accurate-seek-av-timing"
        .hash(&mut hasher);
    video_path.hash(&mut hasher);
    height.hash(&mut hasher);
    start.hash(&mut hasher);
    audio_stream.hash(&mut hasher);
    subtitle_stream.hash(&mut hasher);
    let key = format!("{:016x}", hasher.finish());
    let url = format!("/transcodes/{key}/stream.m3u8");
    (key, url)
}

fn bitrate_for_height(height: u32) -> u32 {
    match height {
        721.. => 6000,
        720 => 3500,
        480 => 1800,
        _ => 900,
    }
}

async fn ensure_transcode(
    state: &AppState,
    input: &Path,
    height: u32,
    source_height: u32,
    start: u64,
    key: &str,
    session: &str,
    initiated_by: Option<String>,
    attempt_id: Option<&str>,
    audio_stream: Option<u32>,
    subtitle_stream: Option<u32>,
    preload: bool,
) -> Result<(), StatusCode> {
    // This lock only protects inspecting/replacing the shared HLS directory
    // and registering the child. Do not hold it while waiting for FFmpeg's
    // first segment: a replacement player session must be able to join the
    // active transcode (or cancel it) immediately.
    // A bounded preload must finish before appending the continuous stream.
    // Release the start lock between checks so other viewers can start/cancel.
    let waiting = Instant::now();
    let start_guard = loop {
        let guard = state.transcode_start_lock.lock().await;
        let mut active = state.active_transcodes.lock().await;
        let wait = active.get_mut(key).is_some_and(|job| job.preload && job.child.try_wait().ok().flatten().is_none());
        if !wait { break guard; }
        drop(active); drop(guard);
        if waiting.elapsed() > Duration::from_secs(60) { return Err(StatusCode::SERVICE_UNAVAILABLE); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    if !input.is_file() { return Err(StatusCode::NOT_FOUND); }
    let directory = state.transcodes_dir.join(key);
    let playlist = directory.join("stream.m3u8");
    // Backfill ownership when reusing caches created before source tracking.
    if directory.is_dir() {
        write_transcode_source(state, input, &directory).await?;
    }
    let preloaded_marker = directory.join("preloaded");
    let is_preloaded = preloaded_marker.is_file();
    if playlist_is_complete(&playlist).await && (!is_preloaded || preload) {
        tracing::info!(
            reason = "playback_hls_cache_reuse",
            transcode_key = %key,
            session = %session,
            attempt_id = ?attempt_id,
            input = %input.display(),
            height,
            start_seconds = start,
            "Reused completed HLS cache without launching FFmpeg"
        );
        return Ok(());
    }
    let mut prefix_seconds = 0.0;
    if is_preloaded && !preload && playlist_is_complete(&playlist).await {
        let contents = tokio::fs::read_to_string(&playlist).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        prefix_seconds = playlist_segments_with_durations(&contents).iter().map(|(_, duration)| duration).sum();
        // Remove ENDLIST before the player attaches; hls.js must keep polling.
        tokio::fs::write(&playlist, contents.replace("#EXT-X-ENDLIST", "")).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        state.active_transcodes.lock().await.remove(key);
        let _ = tokio::fs::remove_file(&preloaded_marker).await;
    }
    tokio::fs::create_dir_all(&directory).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let marker = directory.join("started");
    if prefix_seconds == 0.0 && directory.is_dir() && playlist.is_file() && !marker.is_file() {
        tokio::fs::remove_dir_all(&directory)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    if prefix_seconds == 0.0 && marker.is_file() {
        let joined_active = {
            let mut active = state.active_transcodes.lock().await;
            if let Some(transcode) = active.get_mut(key) {
                transcode.sessions.insert(session.to_owned());
                true
            } else {
                false
            }
        };
        if joined_active {
            tracing::info!(
                reason = "playback_hls_active_transcode_join",
                transcode_key = %key,
                session = %session,
                attempt_id = ?attempt_id,
                input = %input.display(),
                height,
                start_seconds = start,
                "Joined active FFmpeg transcode without launching another process"
            );
            drop(start_guard);
            return wait_for_playlist(state, key, &playlist, attempt_id).await;
        }
        // A marker without an active child cannot ever produce a playlist.
        // This commonly follows a rapid player-session replacement; waiting
        // for the marker's 30-second expiry made the next episode appear to
        // hang before it could start its own transcode.
        tracing::warn!(
            reason = "orphaned_transcode_start_marker",
            transcode_key = %key,
            input = %input.display(),
            "Discarding HLS startup marker with no active FFmpeg child"
        );
        tokio::fs::remove_dir_all(&directory)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    write_transcode_source(state, input, &directory).await?;
    tokio::fs::write(&marker, b"")
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let segment_pattern = directory.join("segment_%05d.ts");
    let hls_segment_seconds = HLS_SEGMENT_SECONDS.to_string();
    let force_key_frames_expr = format!("expr:gte(t,n_forced*{hls_segment_seconds})");
    let log = std::fs::File::create(directory.join("ffmpeg.log"))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let log_err = log
        .try_clone()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Accurate input seeks discard audio preroll, but video stream-copy keeps
    // the earlier keyframe. That creates an audio gap at the start of resumed
    // HLS streams. Encode both timelines accurately, using CPU H.264 here to
    // avoid the D3D/OpenCL initialization hang on original-resolution playback.
    let software_video = if height == source_height && subtitle_stream.is_none() {
        hidden_async_command(&state.ffprobe_path)
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1"])
            .arg(input)
            .output().await.ok()
            .filter(|output| output.status.success())
            .is_some_and(|output| video_codec_is_remux_safe(String::from_utf8_lossy(&output.stdout).trim()))
    } else { false };
    let mut command = hidden_async_command(&state.ffmpeg_path);
    command.arg("-y");
    // Bitmap PGS captions cannot be delivered as browser WebVTT. When the
    // user selects one, decode and overlay it in FFmpeg instead. This is a
    // separate CPU path because the subtitle decoder produces software frames.
    if subtitle_stream.is_none() && !software_video {
        command.args([
            "-init_hw_device",
            "d3d11va=d3d",
            "-init_hw_device",
            "opencl=ocl@d3d",
            "-filter_hw_device",
            "ocl",
            "-hwaccel",
            "d3d11va",
            "-hwaccel_device",
            "d3d",
            "-hwaccel_output_format",
            "d3d11",
            "-extra_hw_frames",
            "64",
        ]);
    }
    command.args(["-readrate", "16"]);
    let input_start = start as f64 + prefix_seconds;
    if input_start > 0.0 {
        command.args(["-ss", &input_start.to_string()]);
        if subtitle_stream.is_some() {
            // Input seeking normally resets PGS timestamps while the subtitle
            // decoder keeps their original timing. Preserve and rebase both
            // streams so a resumed local-caption playback is never black.
            command.args(["-copyts", "-start_at_zero"]);
        }
    }
    command.arg("-i").arg(input);
    if preload {
        // Cache about ten seconds, then exit. Never encode an unseen episode.
        command.args(["-t", "12"]);
        tokio::fs::write(&preloaded_marker, b"").await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    if let Some(subtitle_stream) = subtitle_stream {
        command.args([
            "-filter_complex",
            &format!("[0:v:0][0:{subtitle_stream}]overlay,scale=-2:{height},format=yuv420p[video]"),
            "-map",
            "[video]",
        ]);
    } else {
        command.args(["-map", "0:v:0"]);
    }
    if let Some(audio_stream) = audio_stream {
        command.args(["-map", &format!("0:{audio_stream}")]);
    } else {
        command.args(["-map", "0:a:0?"]);
    }
    if subtitle_stream.is_none() && !software_video {
        // AMF H.264 accepts 8-bit NV12 only. Keep this conversion even when
        // source height matches: Main 10 sources otherwise reach AMF as P010.
        command.args([
            "-vf",
            &format!(
                "hwmap=derive_device=opencl,scale_opencl=w=-2:h={height}:format=nv12,hwdownload,format=nv12"
            ),
        ]);
        command.args([
            "-c:v",
            "h264_amf",
            "-usage",
            "transcoding",
            "-quality",
            "balanced",
            "-rc",
            "cbr",
            "-profile:v",
            "high",
            "-b:v",
            &format!("{}k", bitrate_for_height(height)),
            "-maxrate",
            &format!("{}k", bitrate_for_height(height)),
            "-bufsize",
            &format!("{}k", bitrate_for_height(height) * 2),
        ]);
    } else {
        command.args([
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "high",
            "-threads",
            "4",
        ]);
    }
    command.args(["-force_key_frames", &force_key_frames_expr]);
    command
        .args([
            "-g",
            "48",
            "-keyint_min",
            "48",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-b:a",
            "256k",
            "-f",
            "hls",
            "-hls_time",
            &hls_segment_seconds,
            "-hls_list_size",
            "0",
            "-hls_playlist_type",
            "event",
            "-hls_flags",
            "independent_segments+append_list",
            "-hls_segment_filename",
        ])
        .arg(segment_pattern)
        .arg(&playlist)
        .stdout(log)
        .stderr(log_err)
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tracing::info!(
        reason = "playback_hls_new_transcode",
        software_video,
        preload,
        prefix_seconds,
        audio_stream = ?audio_stream,
        subtitle_stream = ?subtitle_stream,
        transcode_key = %key,
        session = %session,
        attempt_id = ?attempt_id,
        input = %input.display(),
        output = %playlist.display(),
        ffmpeg = %state.ffmpeg_path.display(),
        pid = ?child.id(),
        height,
        source_height,
        start_seconds = start,
        "Launched continuous FFmpeg HLS transcode"
    );
    state.active_transcodes.lock().await.insert(
        key.to_owned(),
        ActiveTranscode {
            preload,
            child,
            directory: directory.clone(),
            sessions: BTreeSet::from([session.to_owned()]),
            video_path: input
                .strip_prefix(&state.library_root)
                .unwrap_or(input)
                .to_string_lossy()
                .replace('\\', "/"),
            quality: format!("{height}p"),
            started_at: unix_now(),
            initiated_by,
        },
    );
    drop(start_guard);
    if preload {
        for _ in 0..600 {
            if playlist_is_complete(&playlist).await {
                tracing::info!(reason = "playback_next_preloaded", transcode_key = %key, "Next episode prefix ready");
                return Ok(());
            }
            if state.active_transcodes.lock().await.get_mut(key).is_none_or(|job| job.child.try_wait().ok().flatten().is_some()) {
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    wait_for_playlist(state, key, &playlist, attempt_id).await
}

async fn wait_for_playlist(
    state: &AppState,
    key: &str,
    playlist: &Path,
    attempt_id: Option<&str>,
) -> Result<(), StatusCode> {
    let started = std::time::Instant::now();
    for _ in 0..600 {
        if let Some(segment_count) =
            playlist_playable_segment_count(playlist, HLS_STARTUP_SEGMENTS).await
        {
            tracing::info!(
                target: "tms_server::playback",
                reason = "playback_hls_ready",
                transcode_key = %key,
                attempt_id = ?attempt_id,
                segment_count,
                minimum_segments = HLS_STARTUP_SEGMENTS,
                wait_ms = started.elapsed().as_millis() as u64,
                "HLS transcode playlist ready for playback"
            );
            return Ok(());
        }
        let exited = {
            let mut active = state.active_transcodes.lock().await;
            if !active.contains_key(key) { return Err(StatusCode::SERVICE_UNAVAILABLE); }
            active
                .get_mut(key)
                .and_then(|transcode| transcode.child.try_wait().ok().flatten())
                .is_some()
        };
        if exited {
            if let Some(transcode) = state.active_transcodes.lock().await.remove(key) {
                tracing::warn!(
                    transcode_key = %key,
                    pid = ?transcode.child.id(),
                    video_path = %transcode.video_path,
                    initiated_by = ?transcode.initiated_by,
                    attempt_id = ?attempt_id,
                    reason = "ffmpeg_exited_before_playlist",
                    "FFmpeg transcode ended before playback became ready"
                );
            }
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tracing::warn!(
        target: "tms_server::playback",
        reason = "playback_hls_ready_timeout",
        transcode_key = %key,
        attempt_id = ?attempt_id,
        minimum_segments = HLS_STARTUP_SEGMENTS,
        wait_ms = started.elapsed().as_millis() as u64,
        "Timed out waiting for the first HLS segment"
    );
    Err(StatusCode::SERVICE_UNAVAILABLE)
}

fn playlist_segment_names(contents: &str) -> Vec<&str> {
    contents
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

#[allow(dead_code)]
fn playlist_segments_with_durations(contents: &str) -> Vec<(&str, f64)> {
    let mut pending_duration = None;
    let mut segments = Vec::new();
    for line in contents.lines() {
        if let Some(duration) = line.strip_prefix("#EXTINF:") {
            pending_duration = duration
                .split(',')
                .next()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value > 0.0);
        } else if !line.is_empty() && !line.starts_with('#') {
            if let Some(duration) = pending_duration.take() {
                segments.push((line, duration));
            }
        }
    }
    segments
}

#[allow(dead_code)]
async fn playlist_playable_buffer(playlist: &Path, minimum_seconds: f64) -> Option<(usize, f64)> {
    let Ok(contents) = tokio::fs::read_to_string(playlist).await else {
        return None;
    };
    let segments = playlist_segments_with_durations(&contents);
    let Some(directory) = playlist.parent() else {
        return None;
    };
    let mut buffered_seconds = 0.0;
    for (segment, duration) in &segments {
        if !directory.join(segment).is_file() {
            return None;
        }
        buffered_seconds += duration;
    }
    let complete = contents.contains("#EXT-X-ENDLIST");
    if buffered_seconds < minimum_seconds && !(complete && !segments.is_empty()) {
        return None;
    }
    if complete
        || tokio::fs::metadata(playlist)
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age < Duration::from_secs(20))
    {
        Some((segments.len(), buffered_seconds))
    } else {
        None
    }
}

async fn playlist_playable_segment_count(playlist: &Path, min_segments: usize) -> Option<usize> {
    let Ok(contents) = tokio::fs::read_to_string(playlist).await else {
        return None;
    };
    let segments = playlist_segment_names(&contents);
    if segments.is_empty() || (segments.len() < min_segments && !contents.contains("#EXT-X-ENDLIST")) {
        return None;
    }
    let Some(directory) = playlist.parent() else {
        return None;
    };
    for segment in segments.iter().take(min_segments) {
        if !directory.join(segment).is_file() {
            return None;
        }
    }
    if contents.contains("#EXT-X-ENDLIST") {
        return Some(segments.len());
    }
    tokio::fs::metadata(playlist)
        .await
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < Duration::from_secs(20))
        .then_some(segments.len())
}

async fn playlist_is_playable(playlist: &Path) -> bool {
    playlist_playable_segment_count(playlist, 1).await.is_some()
}

async fn playlist_is_complete(playlist: &Path) -> bool {
    tokio::fs::read_to_string(playlist)
        .await
        .is_ok_and(|contents| contents.contains("#EXT-X-ENDLIST"))
        && playlist_is_playable(playlist).await
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        library_root: state.library_root.display().to_string(),
        library_available: state.library_root.is_dir(),
    })
}

async fn cached_library_scan(
    state: &AppState,
    key: Option<String>,
    libraries: BTreeMap<String, LibraryConfig>,
) -> Result<Vec<LibraryEntry>, StatusCode> {
    if let Some(entries) = state.library_cache.read().await.get(&key).cloned() {
        return Ok(entries);
    }
    let scan_lock = {
        let mut locks = state.library_scan_locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(std::sync::Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(tokio::sync::Mutex::new(()));
            locks.insert(key.clone(), Arc::downgrade(&lock));
            lock
        }
    };
    let _scan = scan_lock.lock().await;
    if let Some(entries) = state.library_cache.read().await.get(&key).cloned() {
        return Ok(entries);
    }
    let generation = state
        .library_cache_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    let root = state.library_root.clone();
    let folder = key.clone();
    let entries = tokio::task::spawn_blocking(move || {
        if let Some(folder) = folder {
            let path = safe_library_path(&root, &folder)?;
            if !path.is_dir() {
                return Err(StatusCode::NOT_FOUND);
            }
            Ok(scan_folder(&root, &path, &libraries))
        } else {
            Ok(scan_library(&root, &libraries))
        }
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;
    let mut cache = state.library_cache.write().await;
    if generation
        == state
            .library_cache_generation
            .load(std::sync::atomic::Ordering::SeqCst)
    {
        cache.insert(key, entries.clone());
    }
    Ok(entries)
}

async fn library(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<LibraryQuery>,
) -> Response {
    if !state.library_root.is_dir() {
        tracing::error!(library_root = %state.library_root.display(), "Library scan failed: library root is unavailable");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Vec::<LibraryEntry>::new()),
        )
            .into_response();
    }

    let scan_started_at = Instant::now();
    let requested_folder = query
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let libraries = read_libraries(&state).await;
    let mut entries = match cached_library_scan(
        &state,
        requested_folder.map(str::to_owned),
        libraries.clone(),
    )
    .await
    {
        Ok(entries) => entries,
        Err(status) => return (status, Json(Vec::<LibraryEntry>::new())).into_response(),
    };
    annotate_catalog_entries(&mut entries, &libraries);
    let sort = query.sort.as_deref().unwrap_or("opened");
    apply_cached_library_durations(&state, &mut entries).await;
    if sort == "length" {
        populate_library_durations(&state, &mut entries).await;
    }
    let user_state = if let Some(user) = authenticated_user(&state, &headers).await {
        read_user_states(&state.user_state_path)
            .await
            .users
            .get(&user.id)
            .cloned()
    } else {
        None
    };
    sort_library_entries(
        &mut entries,
        sort,
        query.direction.as_deref().unwrap_or("desc"),
        user_state.as_ref(),
    );
    let scan_elapsed = scan_started_at.elapsed();
    if scan_elapsed >= Duration::from_millis(250) {
        tracing::info!(
            library_root = %state.library_root.display(),
            entries = entries.len(),
            scan_duration_ms = scan_elapsed.as_millis() as u64,
            "Library scan completed"
        );
    } else {
        tracing::debug!(
            entries = entries.len(),
            scan_duration_ms = scan_elapsed.as_millis() as u64,
            "Library scan completed"
        );
    }
    if requested_folder.is_some() {
        let total = entries.len();
        let offset = query.offset.unwrap_or(0).min(total);
        let load_all = user_state
            .as_ref()
            .is_some_and(|u| u.playback_preferences.load_all_items)
            || query.limit.is_some_and(|limit| limit >= 100_000);
        let (mut page, consumed, has_more) =
            paginate_library_folder_page(&entries, offset, load_all);
        // Disk-cached thumbnails are ready to read immediately, so include
        // their true ratios without ever making a library request wait for
        // FFmpeg to generate a cache miss.
        if query.metadata != Some(false) {
            populate_library_thumbnail_metadata(&state, &mut page).await;
        }
        // Audio cards should arrive with their length already known. Doing the
        // bounded, cache-backed work here avoids hundreds of browser metadata
        // requests gradually filling the list from top to bottom.
        if sort != "length" && query.metadata != Some(false) {
            populate_library_durations(&state, &mut page).await;
        }
        return (
            StatusCode::OK,
            [
                ("x-tms-total", total.to_string()),
                ("x-tms-has-more", has_more.to_string()),
                ("x-tms-consumed", consumed.to_string()),
            ],
            Json(page),
        )
            .into_response();
    }
    (StatusCode::OK, Json(entries)).into_response()
}

fn is_managed_folder_mount(relative: &Path, libraries: &BTreeMap<String, LibraryConfig>) -> bool {
    let relative = relative.to_string_lossy().replace('\\', "/");
    let Some((library, folder)) = relative.split_once('/') else {
        return false;
    };
    libraries.get(library).is_some_and(|config| {
        config
            .folder_mounts
            .iter()
            .any(|mount| mount.path.eq_ignore_ascii_case(folder))
    })
}

fn scan_folder(
    root: &Path,
    folder: &Path,
    libraries: &BTreeMap<String, LibraryConfig>,
) -> Vec<LibraryEntry> {
    std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            let relative = path.strip_prefix(root).ok()?;
            let is_managed_mount = is_managed_folder_mount(relative, libraries) && path.is_dir();
            let is_directory = metadata.is_dir() || is_managed_mount;
            let preview = is_directory.then(|| folder_preview_info(root, &path));
            Some(LibraryEntry {
                path: relative.to_string_lossy().replace('\\', "/"),
                device_path: Some(path.to_string_lossy().into_owned()),
                name: entry.file_name().to_string_lossy().into_owned(),
                kind: if is_directory { "folder" } else { "file" },
                preview_path: preview.as_ref().and_then(|info| info.path.clone()),
                preview_kind: preview.as_ref().and_then(|info| info.kind),
                // A folder can contain only documents or other generic files.
                // Its count must not depend on there being a visual preview.
                item_count: preview.map(|info| info.item_count),
                catalog_kind: None,
                catalog_title_path: None,
                size: if metadata.is_file() && !is_managed_mount {
                    metadata.len()
                } else {
                    0
                },
                created_at: metadata
                    .created()
                    .or_else(|_| metadata.modified())
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
                    .unwrap_or(0),
                duration: None,
                thumbnail_aspect_ratio: None,
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
                    .unwrap_or(0),
            })
        })
        .collect()
}

fn scan_library(root: &Path, libraries: &BTreeMap<String, LibraryConfig>) -> Vec<LibraryEntry> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.path() != root)
        .filter(|entry| {
            entry
                .path()
                .strip_prefix(root)
                .ok()
                .and_then(|path| path.components().next())
                .is_none_or(|component| component.as_os_str() != ".tms-data")
        })
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let relative = entry.path().strip_prefix(root).ok()?;
            // `WalkDir` deliberately does not follow links. That protects a
            // user-created link from exposing a different part of the disk,
            // but a configured external library is a TMS-owned Windows
            // junction. Its entry metadata describes the junction itself as
            // a file even though opening it is a normal directory operation.
            // Present that one managed root exactly like every other library.
            let is_external_library_root = relative.components().count() == 1
                && relative
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(|name| libraries.get(name))
                    .is_some_and(|library| library.source_path.is_some())
                && entry.path().is_dir();
            let is_managed_mount =
                is_managed_folder_mount(relative, libraries) && entry.path().is_dir();
            let is_directory = metadata.is_dir() || is_external_library_root || is_managed_mount;
            // The root scan normally skips folder previews for speed. An
            // external library's junction cannot be walked from that root,
            // though, so supply its real folder data here instead of leaving
            // the card looking empty.
            let preview = (is_external_library_root || is_managed_mount)
                .then(|| folder_preview_info(root, entry.path()));
            Some(LibraryEntry {
                path: relative.to_string_lossy().replace('\\', "/"),
                device_path: Some(entry.path().to_string_lossy().into_owned()),
                name: entry.file_name().to_string_lossy().into_owned(),
                kind: if is_directory { "folder" } else { "file" },
                preview_path: preview.as_ref().and_then(|info| info.path.clone()),
                preview_kind: preview.as_ref().and_then(|info| info.kind),
                item_count: preview.map(|info| info.item_count),
                catalog_kind: None,
                catalog_title_path: None,
                size: if metadata.is_file() && !is_external_library_root && !is_managed_mount {
                    metadata.len()
                } else {
                    0
                },
                created_at: metadata
                    .created()
                    .or_else(|_| metadata.modified())
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
                    .unwrap_or(0),
                duration: None,
                thumbnail_aspect_ratio: None,
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
                    .unwrap_or(0),
            })
        })
        .collect()
}

/// Make Movies & TV identity part of the library contract.  The web used to
/// derive this after every response; doing it here gives Android and web the
/// same fast answer and keeps pagination clients from needing descendants.
fn annotate_catalog_entries(
    entries: &mut [LibraryEntry],
    libraries: &BTreeMap<String, LibraryConfig>,
) {
    let title_folders = entries
        .iter()
        .filter(|entry| entry.kind == "folder")
        .filter_map(|entry| {
            let mut parts = entry.path.split('/');
            let library_name = parts.next()?;
            let relative = parts.collect::<Vec<_>>().join("/");
            let config = libraries.get(library_name)?;
            (config.content_type == "movies_tv"
                && !relative.is_empty()
                && (relative.split('/').count() == 1 || config.title_folders.contains(&relative)))
            .then(|| entry.path.clone())
        })
        .collect::<Vec<_>>();

    let mut series_titles = BTreeSet::new();
    for title_path in &title_folders {
        let is_series = entries.iter().any(|entry| {
            // A paged Movies & TV root only contains the title folder. Its own
            // preview still points at an episode and must count as series
            // evidence, just like previews on descendant season folders.
            (entry.path == title_path.as_str()
                && entry.kind == "folder"
                && entry.preview_kind == Some("video")
                && entry.preview_path.as_deref().is_some_and(is_episode_path))
                || (entry.path.starts_with(&format!("{title_path}/"))
                    && ((entry.kind == "file" && is_episode_path(&entry.path))
                        || (entry.kind == "folder"
                            && entry.preview_kind == Some("video")
                            && entry.preview_path.as_deref().is_some_and(is_episode_path))))
        });
        if is_series {
            series_titles.insert(title_path.clone());
        }
    }

    for entry in entries {
        if title_folders.iter().any(|path| path == &entry.path) {
            entry.catalog_title_path = Some(entry.path.clone());
            entry.catalog_kind = Some(if series_titles.contains(&entry.path) {
                "series"
            } else {
                "movie"
            });
            continue;
        }
        let title_path = title_folders
            .iter()
            .filter(|title| entry.path.starts_with(&format!("{title}/")))
            .max_by_key(|title| title.len());
        if let Some(title_path) = title_path {
            entry.catalog_title_path = Some(title_path.clone());
            entry.catalog_kind = Some(if series_titles.contains(title_path) {
                "episode"
            } else {
                "movie"
            });
            continue;
        }
        let parts = entry.path.split('/').collect::<Vec<_>>();
        if entry.kind == "file"
            && parts.len() == 2
            && libraries
                .get(parts[0])
                .is_some_and(|config| config.content_type == "movies_tv")
            && !is_episode_path(&entry.path)
        {
            entry.catalog_title_path = Some(entry.path.clone());
            entry.catalog_kind = Some("movie");
        }
    }
}

fn is_episode_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for index in 0..bytes.len() {
        let marker = bytes[index];
        if marker != b's' && !bytes[index].is_ascii_digit() {
            continue;
        }
        let (season_start, mut cursor) = if marker == b's' {
            (index + 1, index + 1)
        } else {
            (index, index)
        };
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor == season_start || cursor - season_start > 3 {
            continue;
        }
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'.' | b'_' | b'-') {
            cursor += 1;
        }
        if cursor >= bytes.len() || (bytes[cursor] != b'e' && bytes[cursor] != b'x') {
            continue;
        }
        cursor += 1;
        let episode_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor > episode_start && cursor - episode_start <= 4 {
            if marker != b's' {
                if let Ok(episode_str) = std::str::from_utf8(&bytes[episode_start..cursor]) {
                    if let Ok(episode_num) = episode_str.parse::<u32>() {
                        if matches!(episode_num, 264 | 265 | 266 | 267) {
                            continue;
                        }
                    }
                }
            }
            return true;
        }
    }
    anime_episode_from_release(value).is_some()
}

fn library_media_type(entry: &LibraryEntry) -> &'static str {
    if entry.kind == "folder" {
        return "folder";
    }
    let extension = Path::new(&entry.name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "mpeg" | "mpg" | "wmv" | "3gp" | "ts"
        | "m2ts" => "video",
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "oga" | "opus" | "wma" | "aiff"
        | "alac" => "audio",
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "avif" | "heic"
        | "heif" => "image",
        _ => "file",
    }
}

fn sort_library_entries(
    entries: &mut [LibraryEntry],
    sort: &str,
    direction: &str,
    user_state: Option<&UserState>,
) {
    let ascending = direction.eq_ignore_ascii_case("asc");
    entries.sort_by(|left, right| {
        let folder_order = (right.kind == "folder").cmp(&(left.kind == "folder"));
        if !folder_order.is_eq() {
            return folder_order;
        }
        let order = match sort {
            "name" => explorer_name_cmp(&left.name, &right.name),
            "size" => left.size.cmp(&right.size),
            "length" => left
                .duration
                .unwrap_or(0.0)
                .total_cmp(&right.duration.unwrap_or(0.0)),
            "type" => library_media_type(left)
                .cmp(library_media_type(right))
                .then_with(|| explorer_name_cmp(&left.name, &right.name)),
            "opened" => user_state
                .map(|state| {
                    opened_timestamp_for_library_entry(state, left)
                        .max(left.created_at)
                        .cmp(&opened_timestamp_for_library_entry(state, right).max(right.created_at))
                })
                .unwrap_or_else(|| left.created_at.cmp(&right.created_at)),
            _ => left.created_at.cmp(&right.created_at),
        };
        let directed = if ascending { order } else { order.reverse() };
        directed.then_with(|| left.path.cmp(&right.path))
    });
}

struct FolderPreviewInfo {
    path: Option<String>,
    kind: Option<&'static str>,
    item_count: u64,
}

/// Pick one stable pseudo-random image or video from a folder's descendants.
/// The server supplies this with the folder card, so paged folder views do not
/// need to load every descendant solely to find a cover. The item count is
/// returned separately because document-only folders have no visual preview.
fn folder_preview_info(root: &Path, folder: &Path) -> FolderPreviewInfo {
    let mut chosen: Option<(u64, String, &'static str)> = None;
    let mut item_count = 0_u64;
    // Begin with the folder's direct children. This enters a managed Windows
    // junction once, while `WalkDir` still refuses to follow any links below
    // it (or below a normal library folder).
    let Ok(children) = std::fs::read_dir(folder) else {
        return FolderPreviewInfo {
            path: None,
            kind: None,
            item_count,
        };
    };
    for child in children.filter_map(Result::ok) {
        for entry in WalkDir::new(child.path())
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            item_count = item_count.saturating_add(1);
            let name = entry.file_name().to_string_lossy();
            let extension = Path::new(name.as_ref())
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let kind = match extension.as_str() {
                "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "mpeg" | "mpg" | "wmv" | "3gp"
                | "ts" | "m2ts" => "video",
                "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "avif"
                | "heic" | "heif" => "image",
                _ => continue,
            };
            let Ok(relative) = entry.path().strip_prefix(root) else {
                continue;
            };
            let path = relative.to_string_lossy().replace('\\', "/");
            let mut hasher = DefaultHasher::new();
            folder.hash(&mut hasher);
            path.hash(&mut hasher);
            let score = hasher.finish();
            if chosen
                .as_ref()
                .is_none_or(|(current, _, _)| score < *current)
            {
                chosen = Some((score, path, kind));
            }
        }
    }
    let (path, kind) = chosen
        .map(|(_, path, kind)| (Some(path), Some(kind)))
        .unwrap_or((None, None));
    FolderPreviewInfo {
        path,
        kind,
        item_count,
    }
}

/// Windows File Explorer uses StrCmpLogicalW for name sorting. Keeping that
/// comparison on the server makes page boundaries stable for natural names
/// such as `clip-2` and `clip-10` in either direction.
#[cfg(windows)]
fn explorer_name_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    let left_wide = OsStr::new(left)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let right_wide = OsStr::new(right)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe { StrCmpLogicalW(left_wide.as_ptr(), right_wide.as_ptr()) }.cmp(&0)
}

#[cfg(not(windows))]
fn explorer_name_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase().cmp(&right.to_lowercase())
}

async fn apply_cached_library_durations(state: &AppState, entries: &mut [LibraryEntry]) {
    let cache = state.library_duration_cache.lock().await;
    for entry in entries.iter_mut() {
        if !matches!(library_media_type(entry), "video" | "audio") {
            continue;
        }
        if let Some(cached) = cache
            .get(&entry.path)
            .filter(|cached| cached.size == entry.size && cached.modified_at == entry.modified_at)
        {
            entry.duration = cached.duration;
        }
    }
}

async fn populate_library_durations(state: &AppState, entries: &mut [LibraryEntry]) {
    let mut pending = Vec::new();
    {
        let cache = state.library_duration_cache.lock().await;
        for (index, entry) in entries.iter_mut().enumerate() {
            if !matches!(library_media_type(entry), "video" | "audio") {
                continue;
            }
            if let Some(cached) = cache.get(&entry.path).filter(|cached| {
                cached.size == entry.size && cached.modified_at == entry.modified_at
            }) {
                entry.duration = cached.duration;
            } else {
                pending.push((
                    index,
                    entry.path.clone(),
                    entry.size,
                    entry.modified_at,
                    state.library_root.join(&entry.path),
                ));
            }
        }
    }
    if pending.is_empty() {
        return;
    }

    static DURATION_PROBES: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let semaphore = DURATION_PROBES.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2))).clone();
    let mut probes = tokio::task::JoinSet::new();
    for (index, path, size, modified_at, device_path) in pending {
        let ffprobe_path = state.ffprobe_path.clone();
        let semaphore = semaphore.clone();
        probes.spawn(async move {
            let Ok(_permit) = semaphore.acquire_owned().await else {
                return (index, path, size, modified_at, None);
            };
            let extension = device_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let duration = if matches!(extension.as_str(), "mp4" | "mov" | "m4a" | "m4v") {
                tokio::task::spawn_blocking(move || mp4_duration(&device_path))
                    .await
                    .ok()
                    .flatten()
            } else if extension == "opus" {
                tokio::task::spawn_blocking(move || opus_duration(&device_path))
                    .await
                    .ok()
                    .flatten()
            } else {
                hidden_async_command(ffprobe_path)
                    .kill_on_drop(true)
                    .args([
                        "-v",
                        "error",
                        "-show_entries",
                        "format=duration",
                        "-of",
                        "default=noprint_wrappers=1:nokey=1",
                    ])
                    .arg(device_path)
                    .creation_flags_windows_hidden()
                    .output()
                    .await
                    .ok()
                    .filter(|output| output.status.success())
                    .and_then(|output| String::from_utf8(output.stdout).ok())
                    .and_then(|value| value.trim().parse::<f64>().ok())
                    .filter(|duration| duration.is_finite() && *duration > 0.0)
            };
            (index, path, size, modified_at, duration)
        });
    }

    let mut cache = state.library_duration_cache.lock().await;
    while let Some(result) = probes.join_next().await {
        let Ok((index, path, size, modified_at, duration)) = result else {
            continue;
        };
        if let Some(entry) = entries.get_mut(index) {
            entry.duration = duration;
        }
        cache.insert(
            path,
            CachedLibraryDuration {
                size,
                modified_at,
                duration,
            },
        );
    }
    let serialized = serde_json::to_vec(&*cache).ok();
    drop(cache);
    if let Some(serialized) = serialized {
        if let Err(error) = tokio::fs::write(&state.library_duration_cache_path, serialized).await {
            tracing::warn!(%error, "Could not persist the library duration cache");
        }
    }
}

fn read_mp4_u32(file: &mut std::fs::File) -> Option<u32> {
    let mut bytes = [0; 4];
    file.read_exact(&mut bytes).ok()?;
    Some(u32::from_be_bytes(bytes))
}

fn read_mp4_u64(file: &mut std::fs::File) -> Option<u64> {
    let mut bytes = [0; 8];
    file.read_exact(&mut bytes).ok()?;
    Some(u64::from_be_bytes(bytes))
}

fn find_mp4_mvhd(file: &mut std::fs::File, start: u64, end: u64) -> Option<f64> {
    file.seek(SeekFrom::Start(start)).ok()?;
    while file.stream_position().ok()?.saturating_add(8) <= end {
        let box_start = file.stream_position().ok()?;
        let size32 = read_mp4_u32(file)? as u64;
        let mut kind = [0; 4];
        file.read_exact(&mut kind).ok()?;
        let header_size = if size32 == 1 { 16 } else { 8 };
        let box_size = if size32 == 1 {
            read_mp4_u64(file)?
        } else if size32 == 0 {
            end.saturating_sub(box_start)
        } else {
            size32
        };
        let content_start = box_start.saturating_add(header_size);
        let box_end = box_start.saturating_add(box_size).min(end);
        if box_size < header_size || content_start > box_end {
            return None;
        }
        if &kind == b"mvhd" {
            file.seek(SeekFrom::Start(content_start)).ok()?;
            let mut version = [0; 1];
            file.read_exact(&mut version).ok()?;
            file.seek(SeekFrom::Current(3)).ok()?;
            let (timescale, duration) = if version[0] == 1 {
                file.seek(SeekFrom::Current(16)).ok()?;
                (read_mp4_u32(file)? as u64, read_mp4_u64(file)?)
            } else {
                file.seek(SeekFrom::Current(8)).ok()?;
                (read_mp4_u32(file)? as u64, read_mp4_u32(file)? as u64)
            };
            return (timescale > 0)
                .then_some(duration as f64 / timescale as f64)
                .filter(|duration| duration.is_finite() && *duration > 0.0);
        }
        if &kind == b"moov" {
            if let Some(duration) = find_mp4_mvhd(file, content_start, box_end) {
                return Some(duration);
            }
        }
        file.seek(SeekFrom::Start(box_end)).ok()?;
    }
    None
}

// Opus is stored in an Ogg container. Its final page records the cumulative
// sample count at a fixed 48 kHz, so duration can be read from the tail of the
// file without spawning ffprobe for every song.
fn opus_duration(path: &Path) -> Option<f64> {
    const TAIL_BYTES: u64 = 128 * 1024;
    const OPUS_SAMPLE_RATE: f64 = 48_000.0;
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut tail).ok()?;
    let page_offset = tail.windows(4).rposition(|window| window == b"OggS")?;
    let granule_end = page_offset.checked_add(14)?;
    let granule_position =
        u64::from_le_bytes(tail.get(page_offset + 6..granule_end)?.try_into().ok()?);
    let duration = granule_position as f64 / OPUS_SAMPLE_RATE;
    (duration.is_finite() && duration > 0.0).then_some(duration)
}

fn mp4_duration(path: &Path) -> Option<f64> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    find_mp4_mvhd(&mut file, 0, length)
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::warn!(%error, "Ctrl-C handler unavailable; keeping TMS running");
        std::future::pending::<()>().await;
    }
}

fn spawn_ytdlp_tool_updater(state: AppState) {
    supervise("ytdlp-tool-updater", move || {
        let state = state.clone();
        async move {
            let _ = refresh_ytdlp_tool(&state).await;
        }
    });
}

async fn refresh_ytdlp_tool(state: &AppState) -> Result<YtDlpToolStatus, String> {
    {
        let mut status = state.ytdlp_tool.lock().await;
        if status.checking {
            return Ok(status.clone());
        }
        status.checking = true;
        status.error = None;
    }
    // The `checking` flag blocks every later refresh, so the inner check runs on
    // its own task. A panic there then clears the flag instead of wedging yt-dlp
    // in a permanent "checking" state that no download could ever escape.
    let checker_state = state.clone();
    let result =
        match tokio::spawn(async move { refresh_ytdlp_tool_inner(&checker_state).await }).await {
            Ok(result) => result,
            Err(error) if error.is_panic() => Err(format!(
                "The yt-dlp check stopped unexpectedly: {}",
                panic_summary(error.into_panic().as_ref())
            )),
            Err(_) => Err("The yt-dlp check was cancelled.".to_owned()),
        };
    let mut status = state.ytdlp_tool.lock().await;
    status.checking = false;
    status.updated_at = Some(unix_now());
    match result {
        Ok(version) => {
            status.ready = true;
            status.version = Some(version);
            status.error = None;
        }
        Err(error) => {
            let fallback = ytdlp_version(&state.ytdlp_path).await.ok();
            status.ready = fallback.is_some();
            status.version = fallback;
            status.error = Some(error.clone());
        }
    }
    state.ytdlp_notify.notify_waiters();
    if status.ready {
        Ok(status.clone())
    } else {
        Err(status
            .error
            .clone()
            .unwrap_or_else(|| "yt-dlp is unavailable.".to_owned()))
    }
}

async fn refresh_ytdlp_tool_inner(state: &AppState) -> Result<String, String> {
    tokio::fs::create_dir_all(&state.ytdlp_dir)
        .await
        .map_err(|error| format!("Could not create the yt-dlp data directory: {error}"))?;
    let release = state
        .http
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .header(reqwest::header::USER_AGENT, "TMS/0.1 yt-dlp updater")
        .send()
        .await
        .map_err(|error| format!("Could not check the latest yt-dlp release: {error}"))?;
    if !release.status().is_success() {
        return Err(format!(
            "GitHub returned {} while checking yt-dlp.",
            release.status()
        ));
    }
    let release: Value = release
        .json()
        .await
        .map_err(|_| "GitHub returned invalid yt-dlp release metadata.".to_owned())?;
    let version = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    if ytdlp_version(&state.ytdlp_path)
        .await
        .is_ok_and(|current| current == version)
    {
        return Ok(version);
    }
    let asset = release
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets
                .iter()
                .find(|asset| asset.get("name").and_then(Value::as_str) == Some("yt-dlp.exe"))
        })
        .ok_or_else(|| "The latest yt-dlp release has no Windows executable.".to_owned())?;
    let url = asset
        .get("browser_download_url")
        .and_then(Value::as_str)
        .ok_or_else(|| "The yt-dlp release download URL is missing.".to_owned())?;
    let expected_digest = asset
        .get("digest")
        .and_then(Value::as_str)
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "The yt-dlp release has no SHA-256 digest.".to_owned())?;
    let bytes = state
        .http
        .get(url)
        .header(reqwest::header::USER_AGENT, "TMS/0.1 yt-dlp updater")
        .send()
        .await
        .map_err(|error| format!("Could not download yt-dlp: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Could not download yt-dlp: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Could not read the yt-dlp download: {error}"))?;
    let actual_digest = format!("{:x}", Sha256::digest(&bytes));
    if actual_digest != expected_digest {
        return Err("The yt-dlp SHA-256 digest did not match GitHub.".to_owned());
    }
    let temporary = state.ytdlp_dir.join("yt-dlp-download.exe");
    tokio::fs::write(&temporary, &bytes)
        .await
        .map_err(|error| format!("Could not stage yt-dlp: {error}"))?;
    let staged_version = ytdlp_version(&temporary)
        .await
        .map_err(|error| format!("The downloaded yt-dlp executable did not run: {error}"))?;
    replace_private_file(&temporary, &state.ytdlp_path)
        .map_err(|error| format!("Could not publish yt-dlp: {error}"))?;
    Ok(staged_version)
}

async fn ytdlp_version(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err("yt-dlp is not installed.".to_owned());
    }
    let output = hidden_async_command(path)
        .arg("--version")
        .creation_flags_windows_hidden()
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("yt-dlp did not start successfully.".to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

// Every server-launched tool must remain invisible in interactive Windows sessions.
fn hidden_async_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command.creation_flags_windows_hidden();
    command
}

fn hidden_sync_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command.creation_flags_windows_hidden();
    command
}
trait WindowsHiddenCommand {
    fn creation_flags_windows_hidden(&mut self) -> &mut Self;
}

impl WindowsHiddenCommand for tokio::process::Command {
    fn creation_flags_windows_hidden(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(0x08000000);
        self
    }
}

impl WindowsHiddenCommand for std::process::Command {
    fn creation_flags_windows_hidden(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(0x08000000);
        self
    }
}

async fn admin_download_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminDownloadStatus>, StatusCode> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_downloads))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(Json(build_admin_download_status(&state).await))
}

fn append_ytdlp_throttle_args(
    command: &mut tokio::process::Command,
    settings: &YtDlpThrottleSettings,
) {
    if settings.sleep_interval_seconds > 0 {
        command
            .arg("--sleep-interval")
            .arg(settings.sleep_interval_seconds.to_string());
        if settings.max_sleep_interval_seconds > settings.sleep_interval_seconds {
            command
                .arg("--max-sleep-interval")
                .arg(settings.max_sleep_interval_seconds.to_string());
        }
    }
    let rate = settings.limit_rate.trim();
    if !rate.is_empty() {
        command.arg("--limit-rate").arg(rate);
    }
}

fn append_ytdlp_runtime_args(command: &mut tokio::process::Command) {
    command.args(["--js-runtimes", "node"]);
}

fn append_ytdlp_youtube_args(command: &mut tokio::process::Command, url: &str) {
    let lower = url.to_ascii_lowercase();
    if lower.contains("youtube.com") || lower.contains("youtu.be") {
        command
            .arg("--extractor-args")
            .arg("youtube:player_client=ios,android,web");
    }
}

fn is_youtube_playlist_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("youtube.com") && lower.contains("list=")
}

fn ytdlp_inspect_error_message(detail: &str, url: &str, user_is_admin: bool) -> String {
    let lower = detail.to_ascii_lowercase();
    if is_youtube_playlist_url(url) && lower.contains("403") {
        if user_is_admin {
            return format!(
                "{detail} This playlist may be private. Try making it unlisted or public, then inspect again."
            );
        }
        return format!(
            "{detail} This playlist may be private. Try making it unlisted or public, or download it locally and upload the files."
        );
    }
    if user_is_admin {
        detail.to_owned()
    } else {
        format!("{detail} If this site requires login, download it locally and upload the file.")
    }
}

async fn run_ytdlp_inspect(
    state: &AppState,
    url: &str,
    throttle: &YtDlpThrottleSettings,
    use_cookies: bool,
) -> Result<std::process::Output, String> {
    let mut command = hidden_async_command(&state.ytdlp_path);
    command.args([
        "--dump-single-json",
        "--flat-playlist",
        "--no-warnings",
        "--ignore-errors",
    ]);
    if use_cookies {
        let cookies_txt = state.ytdlp_path.parent().unwrap().join("cookies.txt");
        if cookies_txt.is_file() {
            command.arg("--cookies").arg(cookies_txt);
        }
    }
    append_ytdlp_runtime_args(&mut command);
    append_ytdlp_youtube_args(&mut command, url);
    append_ytdlp_throttle_args(&mut command, throttle);
    command
        .arg("--")
        .arg(url)
        .creation_flags_windows_hidden()
        .kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| "URL inspection timed out.".to_owned())?
        .map_err(|error| format!("Could not start yt-dlp: {error}"))
}

fn parse_ytdlp_inspect_metadata(
    output: &std::process::Output,
) -> Result<Value, (StatusCode, String)> {
    let metadata = serde_json::from_slice::<Value>(&output.stdout).map_err(|_| {
        if output.status.success() {
            (
                StatusCode::BAD_GATEWAY,
                "yt-dlp returned invalid metadata for this URL.".to_owned(),
            )
        } else {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                sanitize_ytdlp_error(&String::from_utf8_lossy(&output.stderr)),
            )
        }
    })?;
    if !output.status.success()
        && metadata.get("id").is_none()
        && metadata
            .get("title")
            .and_then(Value::as_str)
            .is_none_or(|title| title.trim().is_empty())
    {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            sanitize_ytdlp_error(&String::from_utf8_lossy(&output.stderr)),
        ));
    }
    Ok(metadata)
}

fn normalize_ytdlp_throttle_settings(
    settings: YtDlpThrottleSettings,
) -> Result<YtDlpThrottleSettings, String> {
    if settings.sleep_interval_seconds > 3600 || settings.max_sleep_interval_seconds > 3600 {
        return Err("Sleep intervals cannot exceed 3600 seconds.".to_owned());
    }
    if settings.max_sleep_interval_seconds > 0
        && settings.sleep_interval_seconds > 0
        && settings.max_sleep_interval_seconds < settings.sleep_interval_seconds
    {
        return Err("Max sleep must be greater than or equal to sleep interval.".to_owned());
    }
    let rate = settings.limit_rate.trim().to_owned();
    if !rate.is_empty()
        && !rate.chars().all(|character| {
            character.is_ascii_digit()
                || character == '.'
                || character == 'K'
                || character == 'M'
                || character == 'G'
                || character == 'k'
                || character == 'm'
                || character == 'g'
        })
    {
        return Err("Rate limit must look like 500K, 2M, or 1500000.".to_owned());
    }
    Ok(YtDlpThrottleSettings {
        sleep_interval_seconds: settings.sleep_interval_seconds,
        max_sleep_interval_seconds: settings.max_sleep_interval_seconds,
        limit_rate: rate,
    })
}

async fn read_ytdlp_settings(path: &Path) -> YtDlpThrottleSettings {
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

async fn write_ytdlp_settings(
    path: &Path,
    settings: &YtDlpThrottleSettings,
) -> Result<(), StatusCode> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    let bytes =
        serde_json::to_vec_pretty(settings).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    replace_private_file(&temporary, path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn read_ytdlp_cookies_status(state: &AppState) -> YtDlpCookiesStatus {
    let cookies_txt = state.ytdlp_path.parent().unwrap().join("cookies.txt");
    let Ok(metadata) = tokio::fs::metadata(&cookies_txt).await else {
        return YtDlpCookiesStatus {
            exists: false,
            size_bytes: 0,
            updated_at: None,
            line_count: 0,
            sample_domains: Vec::new(),
            has_youtube_auth: false,
        };
    };
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|dur| dur.as_secs());
    let size_bytes = metadata.len();
    let Ok(bytes) = tokio::fs::read(&cookies_txt).await else {
        return YtDlpCookiesStatus {
            exists: true,
            size_bytes,
            updated_at,
            line_count: 0,
            sample_domains: Vec::new(),
            has_youtube_auth: false,
        };
    };
    let content = String::from_utf8_lossy(&bytes);
    let mut domains = std::collections::BTreeSet::new();
    let mut has_youtube_auth = false;
    let mut line_count = 0;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        line_count += 1;
        let parts: Vec<&str> = trimmed.split('\t').collect();
        if parts.len() >= 7 {
            let domain = parts[0].trim_start_matches('.');
            if !domain.is_empty() {
                domains.insert(domain.to_ascii_lowercase());
            }
            let name = parts[5];
            if matches!(
                name,
                "SID" | "HSID" | "SSID" | "LOGIN_INFO" | "__Secure-3PSID" | "SAPISID" | "APISID"
            ) {
                has_youtube_auth = true;
            }
        }
    }

    YtDlpCookiesStatus {
        exists: true,
        size_bytes,
        updated_at,
        line_count,
        sample_domains: domains.into_iter().take(10).collect(),
        has_youtube_auth,
    }
}

async fn build_admin_download_status(state: &AppState) -> AdminDownloadStatus {
    let throttle = read_ytdlp_settings(&state.ytdlp_settings_path).await;
    let cookies = read_ytdlp_cookies_status(state).await;
    AdminDownloadStatus {
        tool: state.ytdlp_tool.lock().await.clone(),
        throttle,
        cookies,
    }
}

#[derive(Deserialize)]
struct YtDlpCookiesUpdateRequest {
    content: String,
}

#[derive(Deserialize)]
struct YtDlpCookiesExtractRequest {
    browser: String,
}

#[derive(Serialize)]
struct YtDlpCookiesExtractResponse {
    success: bool,
    message: String,
    status: YtDlpCookiesStatus,
}

#[derive(Serialize)]
struct YtDlpCookiesTestResponse {
    valid: bool,
    message: String,
}

async fn admin_get_ytdlp_cookies(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<YtDlpCookiesStatus>, (StatusCode, Json<Value>)> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_downloads))
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "Administrator access is required." })),
        ));
    }
    Ok(Json(read_ytdlp_cookies_status(&state).await))
}

async fn admin_update_ytdlp_cookies(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<YtDlpCookiesUpdateRequest>,
) -> Result<Json<YtDlpCookiesStatus>, (StatusCode, Json<Value>)> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_downloads))
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "Administrator access is required." })),
        ));
    }
    let content = request.content.trim();
    if content.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "message": "Cookie content cannot be empty." })),
        ));
    }
    let cookies_txt = state.ytdlp_path.parent().unwrap().join("cookies.txt");
    if let Some(parent) = cookies_txt.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::write(&cookies_txt, content.as_bytes())
        .await
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "message": "Failed to save cookies.txt" })),
            )
        })?;
    Ok(Json(read_ytdlp_cookies_status(&state).await))
}

async fn admin_delete_ytdlp_cookies(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<YtDlpCookiesStatus>, (StatusCode, Json<Value>)> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_downloads))
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "Administrator access is required." })),
        ));
    }
    let cookies_txt = state.ytdlp_path.parent().unwrap().join("cookies.txt");
    let _ = tokio::fs::remove_file(&cookies_txt).await;
    Ok(Json(read_ytdlp_cookies_status(&state).await))
}

async fn perform_ytdlp_cookie_extraction(
    state: &AppState,
    browser: Option<&str>,
) -> Result<(String, YtDlpCookiesStatus), String> {
    let candidate_browsers: Vec<String> = match browser {
        Some(b) if !b.trim().is_empty() && !b.trim().eq_ignore_ascii_case("auto") => {
            vec![b.trim().to_ascii_lowercase()]
        }
        _ => vec![
            "edge".to_owned(),
            "chrome".to_owned(),
            "firefox".to_owned(),
            "brave".to_owned(),
            "opera".to_owned(),
            "vivaldi".to_owned(),
            "chromium".to_owned(),
        ],
    };

    let cookies_txt = state.ytdlp_path.parent().unwrap().join("cookies.txt");
    if let Some(parent) = cookies_txt.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let mut last_error = String::new();
    let mut last_used_browser = String::new();

    for b in candidate_browsers {
        let mut command = hidden_async_command(&state.ytdlp_path);
        command
            .arg("--cookies-from-browser")
            .arg(&b)
            .arg("--cookies")
            .arg(&cookies_txt)
            .args(["--skip-download", "https://www.youtube.com"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags_windows_hidden()
            .kill_on_drop(true);

        if let Ok(Ok(output)) =
            tokio::time::timeout(Duration::from_secs(30), command.output()).await
        {
            let status = read_ytdlp_cookies_status(state).await;
            if output.status.success() && status.exists && status.size_bytes > 0 {
                tracing::info!(browser = %b, "Successfully extracted cookies from browser");
                return Ok((b, status));
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let clean = sanitize_ytdlp_error(&stderr);
                if !clean.is_empty() {
                    last_error = format!("{b}: {clean}");
                }
                last_used_browser = b;
            }
        }
    }

    let status = read_ytdlp_cookies_status(state).await;
    if status.exists && status.size_bytes > 0 && status.has_youtube_auth {
        return Ok((last_used_browser, status));
    }

    if last_error.is_empty() {
        Err("Could not extract cookies from any detected browser. Please export cookies manually in Admin settings.".to_owned())
    } else {
        Err(last_error)
    }
}

async fn admin_extract_ytdlp_cookies(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<YtDlpCookiesExtractRequest>,
) -> Result<Json<YtDlpCookiesExtractResponse>, (StatusCode, Json<Value>)> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_downloads))
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "Administrator access is required." })),
        ));
    }
    let browser = request.browser.trim();
    let browser_arg = if browser.is_empty() || browser.eq_ignore_ascii_case("auto") {
        None
    } else {
        Some(browser)
    };
    match perform_ytdlp_cookie_extraction(&state, browser_arg).await {
        Ok((extracted_from, status)) => Ok(Json(YtDlpCookiesExtractResponse {
            success: true,
            message: format!("Successfully extracted and saved cookies from {extracted_from}."),
            status,
        })),
        Err(err) => {
            let status = read_ytdlp_cookies_status(&state).await;
            let msg = if err.contains("DPAPI")
                || err.contains("decrypt")
                || err.contains("database is locked")
                || err.contains("Could not copy Chrome cookie database")
            {
                format!(
                    "Vivaldi is currently running and locking its cookies file. Please completely CLOSE Vivaldi, wait a few seconds, and click Extract again. (If it still fails, modern Chromium browsers block automated extraction entirely, so you must use the browser extension)."
                )
            } else {
                err
            };
            Ok(Json(YtDlpCookiesExtractResponse {
                success: false,
                message: msg,
                status,
            }))
        }
    }
}

async fn refresh_ytdlp_cookies(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<YtDlpCookiesExtractRequest>,
) -> Result<Json<YtDlpCookiesExtractResponse>, (StatusCode, Json<Value>)> {
    if authenticated_user(&state, &headers).await.is_none() {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "message": "Sign in to refresh cookies." })),
        ));
    }
    let browser = request.browser.trim();
    let browser_arg = if browser.is_empty() || browser.eq_ignore_ascii_case("auto") {
        None
    } else {
        Some(browser)
    };
    match perform_ytdlp_cookie_extraction(&state, browser_arg).await {
        Ok((extracted_from, status)) => Ok(Json(YtDlpCookiesExtractResponse {
            success: true,
            message: format!("Successfully refreshed cookies from {extracted_from}."),
            status,
        })),
        Err(err) => {
            let status = read_ytdlp_cookies_status(&state).await;
            Ok(Json(YtDlpCookiesExtractResponse {
                success: false,
                message: err,
                status,
            }))
        }
    }
}

async fn admin_test_ytdlp_cookies(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<YtDlpCookiesTestResponse>, (StatusCode, Json<Value>)> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_downloads))
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "Administrator access is required." })),
        ));
    }
    let cookies_txt = state.ytdlp_path.parent().unwrap().join("cookies.txt");
    if !cookies_txt.is_file() {
        return Ok(Json(YtDlpCookiesTestResponse {
            valid: false,
            message: "No cookies.txt file is currently installed on the server.".to_owned(),
        }));
    }
    let mut command = hidden_async_command(&state.ytdlp_path);
    command.arg("--cookies").arg(&cookies_txt).args([
        "--skip-download",
        "--dump-single-json",
        "--no-warnings",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
    append_ytdlp_runtime_args(&mut command);
    append_ytdlp_youtube_args(&mut command, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags_windows_hidden()
        .kill_on_drop(true);

    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({ "message": "Cookie test timed out." })),
            )
        })?
        .map_err(|err| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "message": format!("Could not launch yt-dlp: {err}") })),
            )
        })?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("The provided YouTube account cookies are no longer valid")
        || stderr.contains("rotated in the browser")
        || stderr.contains("403")
    {
        Ok(Json(YtDlpCookiesTestResponse {
            valid: false,
            message: "YouTube reported that your cookies are expired or no longer valid. Please export fresh cookies and paste them here.".to_owned(),
        }))
    } else if output.status.success() {
        Ok(Json(YtDlpCookiesTestResponse {
            valid: true,
            message: "Cookies are valid and active! YouTube authenticated successfully.".to_owned(),
        }))
    } else {
        let err = sanitize_ytdlp_error(&stderr);
        Ok(Json(YtDlpCookiesTestResponse {
            valid: false,
            message: if err.is_empty() {
                "Test failed to verify cookies.".to_owned()
            } else {
                err
            },
        }))
    }
}

async fn update_ytdlp_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<YtDlpThrottleSettings>,
) -> Result<Json<AdminDownloadStatus>, (StatusCode, Json<Value>)> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_downloads))
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "Administrator access is required." })),
        ));
    }
    let settings = normalize_ytdlp_throttle_settings(request).map_err(|message| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "message": message })),
        )
    })?;
    write_ytdlp_settings(&state.ytdlp_settings_path, &settings)
        .await
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "message": "Could not save yt-dlp settings." })),
            )
        })?;
    Ok(Json(build_admin_download_status(&state).await))
}

async fn update_ytdlp_tool(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminDownloadStatus>, (StatusCode, Json<Value>)> {
    if !authenticated_user(&state, &headers)
        .await
        .is_some_and(|user| has_admin_capability(&user, |permissions| permissions.manage_downloads))
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "Administrator access is required." })),
        ));
    }
    refresh_ytdlp_tool(&state).await.map_err(|message| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "message": message })),
        )
    })?;
    Ok(Json(build_admin_download_status(&state).await))
}

async fn read_ytdlp_jobs(path: &Path) -> YtDlpJobs {
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

async fn write_ytdlp_jobs(path: &Path, jobs: &YtDlpJobs) -> Result<(), StatusCode> {
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

fn address_is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.octets()[0] == 0
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || (address.segments()[0] & 0xfe00) == 0xfc00
                || (address.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

async fn validate_public_download_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 8192 || value.starts_with('-') {
        return Err("Enter a valid public HTTP or HTTPS URL.".to_owned());
    }
    let url = reqwest::Url::parse(value)
        .map_err(|_| "Enter a valid public HTTP or HTTPS URL.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only public HTTP and HTTPS URLs are allowed.".to_owned());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "The URL must include a public hostname.".to_owned())?
        .to_owned();
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".local") {
        return Err("Local and private-network URLs are not allowed.".to_owned());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::task::spawn_blocking(move || {
        (host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>())
    })
    .await
    .map_err(|_| "Could not verify the URL hostname.".to_owned())?
    .map_err(|_| "The URL hostname could not be resolved.".to_owned())?;
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| address_is_private(address.ip()))
    {
        return Err("Local and private-network URLs are not allowed.".to_owned());
    }
    Ok(url.to_string())
}

async fn validate_ytdlp_destination(
    state: &AppState,
    user: &StoredUser,
    raw_path: &str,
    mode: &str,
) -> Result<(String, LibraryConfig), (StatusCode, String)> {
    if !matches!(mode, "video" | "audio") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose video or audio-only.".to_owned(),
        ));
    }
    let path = raw_path.trim().replace('\\', "/");
    if !safe_relative_path(&path) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose a valid library destination.".to_owned(),
        ));
    }
    let library_name = path
        .split('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "Choose a valid library destination.".to_owned(),
            )
        })?;
    let libraries = read_libraries(state).await;
    let library = libraries.get(library_name).cloned().ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "The selected library no longer exists.".to_owned(),
        )
    })?;
    if library.content_type == "movies_tv" {
        return Err((
            StatusCode::BAD_REQUEST,
            "yt-dlp downloads are not available inside Movies & TV libraries.".to_owned(),
        ));
    }
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
    if !state.library_root.join(&path).is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            "The selected destination folder no longer exists.".to_owned(),
        ));
    }
    Ok((path, library))
}

fn json_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_f64().map(|value| value as u64))
    })
}

fn ytdlp_bytes_per_second(mode: &str) -> u64 {
    if mode == "audio" { 16_000 } else { 350_000 }
}

fn clean_ytdlp_download_stem(stem: &str) -> String {
    let mut cleaned = stem.trim().to_owned();
    if let Some(dash_pos) = cleaned.find(" - ") {
        let prefix = &cleaned[..dash_pos];
        if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()) {
            cleaned = cleaned[dash_pos + 3..].to_owned();
        }
    }
    while cleaned.ends_with(" []") {
        cleaned = cleaned[..cleaned.len() - 3].trim_end().to_owned();
    }
    if let Some(bracket_start) = cleaned.rfind(" [") {
        if cleaned.ends_with(']') {
            let inner = &cleaned[bracket_start + 2..cleaned.len() - 1];
            if inner.is_empty()
                || (inner.len() == 11
                    && inner
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            {
                cleaned = cleaned[..bracket_start].trim_end().to_owned();
            }
        }
    }
    cleaned
}

fn cleaned_ytdlp_file_name(file_name: &str) -> Option<String> {
    let path = Path::new(file_name);
    let stem = path.file_stem()?.to_str()?;
    let cleaned_stem = clean_ytdlp_download_stem(stem);
    if cleaned_stem == stem || cleaned_stem.is_empty() {
        return None;
    }
    let extension = path.extension().and_then(|value| value.to_str());
    Some(match extension {
        Some(extension) => format!("{cleaned_stem}.{extension}"),
        None => cleaned_stem,
    })
}

fn clean_ytdlp_relative_path(relative: PathBuf) -> PathBuf {
    let file_name = match relative.file_name().and_then(|name| name.to_str()) {
        Some(name) => name,
        None => return relative,
    };
    let Some(cleaned_name) = cleaned_ytdlp_file_name(file_name) else {
        return relative;
    };
    match relative.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(cleaned_name),
        _ => PathBuf::from(cleaned_name),
    }
}

fn ytdlp_entry_duration_seconds(entry: &Value) -> Option<u64> {
    json_u64(entry, "duration")
}

fn ytdlp_entry_title(entry: &Value) -> String {
    if let Some(title) = entry
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        return title.chars().take(240).collect();
    }
    let id = entry.get("id").and_then(Value::as_str);
    if ytdlp_entry_duration_seconds(entry).is_none() {
        return "Private or unavailable".to_owned();
    }
    id.unwrap_or("Untitled").chars().take(240).collect()
}

fn parse_ytdlp_preview_line(line: &str) -> Option<YtDlpPreviewItem> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.splitn(3, '|');
    let title_raw = parts.next()?.trim();
    let id = parts.next().unwrap_or("").trim();
    let duration_raw = parts.next().unwrap_or("").trim();
    let title = if title_raw.is_empty() || title_raw.eq_ignore_ascii_case("na") {
        if duration_raw.is_empty() || duration_raw.eq_ignore_ascii_case("na") {
            "Private or unavailable".to_owned()
        } else if id.is_empty() || id.eq_ignore_ascii_case("na") {
            "Untitled".to_owned()
        } else {
            id.chars().take(240).collect()
        }
    } else {
        title_raw.chars().take(240).collect()
    };
    let duration_seconds = if duration_raw.is_empty() || duration_raw.eq_ignore_ascii_case("na") {
        None
    } else {
        duration_raw.parse().ok()
    };
    Some(YtDlpPreviewItem {
        title,
        duration_seconds,
    })
}

fn ytdlp_preview_items(metadata: &Value) -> Vec<YtDlpPreviewItem> {
    metadata
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| !entry.is_null())
                .map(|entry| YtDlpPreviewItem {
                    title: ytdlp_entry_title(entry),
                    duration_seconds: ytdlp_entry_duration_seconds(entry),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn preview_item_from_json(value: &Value) -> YtDlpPreviewItem {
    YtDlpPreviewItem {
        title: ytdlp_entry_title(value),
        duration_seconds: ytdlp_entry_duration_seconds(value),
    }
}

fn parse_ytdlp_preview_output(stdout: &str, json_lines: bool) -> Vec<YtDlpPreviewItem> {
    if json_lines {
        stdout
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() || !line.starts_with('{') {
                    return None;
                }
                serde_json::from_str::<Value>(line)
                    .ok()
                    .map(|value| preview_item_from_json(&value))
            })
            .collect()
    } else {
        stdout
            .lines()
            .filter_map(parse_ytdlp_preview_line)
            .collect()
    }
}

async fn run_ytdlp_preview_command(
    state: &AppState,
    url: &str,
    throttle: &YtDlpThrottleSettings,
    args: &[&str],
    json_lines: bool,
) -> Result<Vec<YtDlpPreviewItem>, String> {
    let mut command = hidden_async_command(&state.ytdlp_path);
    command.args(args);
    let cookies_txt = state.ytdlp_path.parent().unwrap().join("cookies.txt");
    if cookies_txt.is_file() {
        command.arg("--cookies").arg(cookies_txt);
    }
    append_ytdlp_runtime_args(&mut command);
    append_ytdlp_youtube_args(&mut command, url);
    append_ytdlp_throttle_args(&mut command, throttle);
    command
        .arg("--")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags_windows_hidden()
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| "URL inspection timed out.".to_owned())?
        .map_err(|error| format!("Could not start yt-dlp: {error}"))?;
    let items = parse_ytdlp_preview_output(&String::from_utf8_lossy(&output.stdout), json_lines);
    if items.is_empty() {
        if !output.status.success() {
            return Err(sanitize_ytdlp_error(&String::from_utf8_lossy(
                &output.stderr,
            )));
        }
        return Ok(Vec::new());
    }
    Ok(items)
}

async fn fetch_ytdlp_preview_items(
    state: &AppState,
    url: &str,
    throttle: &YtDlpThrottleSettings,
) -> Vec<YtDlpPreviewItem> {
    if let Ok(items) = run_ytdlp_preview_command(
        state,
        url,
        throttle,
        &[
            "--flat-playlist",
            "--dump-json",
            "--no-warnings",
            "--ignore-errors",
        ],
        true,
    )
    .await
    {
        if !items.is_empty() {
            return items;
        }
    }
    if let Ok(items) = run_ytdlp_preview_command(
        state,
        url,
        throttle,
        &[
            "--flat-playlist",
            "--no-warnings",
            "--ignore-errors",
            "--print",
            "%(title)s|%(id)s|%(duration)s",
        ],
        false,
    )
    .await
    {
        if !items.is_empty() {
            return items;
        }
    }
    if let Ok(items) = run_ytdlp_preview_full_metadata(state, url, throttle).await {
        if !items.is_empty() {
            return items;
        }
    }
    Vec::new()
}

fn merge_ytdlp_preview_items(
    primary: Vec<YtDlpPreviewItem>,
    fallback: Vec<YtDlpPreviewItem>,
) -> Vec<YtDlpPreviewItem> {
    if primary.is_empty() {
        return fallback;
    }
    if fallback.is_empty() {
        return primary;
    }
    let count = primary.len().max(fallback.len());
    (0..count)
        .map(|index| {
            let left = primary.get(index);
            let right = fallback.get(index);
            match (left, right) {
                (Some(left), Some(right)) => {
                    let prefer_right_title = left.title == "Private or unavailable"
                        || left.title == "Untitled"
                        || (left.duration_seconds.is_none() && right.duration_seconds.is_some());
                    YtDlpPreviewItem {
                        title: if prefer_right_title && right.title != "Private or unavailable" {
                            right.title.clone()
                        } else {
                            left.title.clone()
                        },
                        duration_seconds: left.duration_seconds.or(right.duration_seconds),
                    }
                }
                (Some(left), None) => left.clone(),
                (None, Some(right)) => right.clone(),
                (None, None) => YtDlpPreviewItem {
                    title: "Untitled".to_owned(),
                    duration_seconds: None,
                },
            }
        })
        .collect()
}

async fn run_ytdlp_preview_full_metadata(
    state: &AppState,
    url: &str,
    throttle: &YtDlpThrottleSettings,
) -> Result<Vec<YtDlpPreviewItem>, String> {
    let mut command = hidden_async_command(&state.ytdlp_path);
    command.args([
        "--dump-single-json",
        "--no-warnings",
        "--ignore-errors",
        "--playlist-end",
        "200",
    ]);
    let cookies_txt = state.ytdlp_path.parent().unwrap().join("cookies.txt");
    if cookies_txt.is_file() {
        command.arg("--cookies").arg(cookies_txt);
    }
    append_ytdlp_runtime_args(&mut command);
    append_ytdlp_youtube_args(&mut command, url);
    append_ytdlp_throttle_args(&mut command, throttle);
    command
        .arg("--")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags_windows_hidden()
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| "URL inspection timed out.".to_owned())?
        .map_err(|error| format!("Could not start yt-dlp: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let metadata: Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        if output.status.success() {
            "yt-dlp returned invalid metadata for this URL.".to_owned()
        } else {
            sanitize_ytdlp_error(&String::from_utf8_lossy(&output.stderr))
        }
    })?;
    let items = ytdlp_preview_items(&metadata);
    if items.is_empty() && !output.status.success() {
        return Err(sanitize_ytdlp_error(&String::from_utf8_lossy(
            &output.stderr,
        )));
    }
    Ok(items)
}

fn ytdlp_default_duration_seconds(mode: &str) -> u64 {
    if mode == "audio" { 240 } else { 600 }
}

fn ytdlp_estimated_bytes(metadata: &Value, mode: &str) -> (Option<u64>, bool) {
    if let Some(size) =
        json_u64(metadata, "filesize").or_else(|| json_u64(metadata, "filesize_approx"))
    {
        if size > 0 {
            return (Some(size), false);
        }
    }
    if let Some(entries) = metadata.get("entries").and_then(Value::as_array) {
        if !entries.is_empty() {
            let item_count = json_u64(metadata, "playlist_count")
                .unwrap_or(entries.len() as u64)
                .max(1);
            let mut total = 0_u64;
            let mut measured = 0_u64;
            let mut duration_sum = 0_u64;
            let mut approx = false;
            for entry in entries {
                if let Some(size) =
                    json_u64(entry, "filesize").or_else(|| json_u64(entry, "filesize_approx"))
                {
                    if size > 0 {
                        total = total.saturating_add(size);
                        measured += 1;
                        continue;
                    }
                }
                if let Some(duration) = ytdlp_entry_duration_seconds(entry) {
                    total =
                        total.saturating_add(duration.saturating_mul(ytdlp_bytes_per_second(mode)));
                    duration_sum = duration_sum.saturating_add(duration);
                    measured += 1;
                    approx = true;
                }
            }
            if measured > 0 {
                if measured < entries.len() as u64 {
                    let average_duration = duration_sum / measured.max(1);
                    let missing = entries.len() as u64 - measured;
                    total = total.saturating_add(
                        missing
                            .saturating_mul(
                                average_duration.max(ytdlp_default_duration_seconds(mode)),
                            )
                            .saturating_mul(ytdlp_bytes_per_second(mode)),
                    );
                    approx = true;
                }
                if item_count > entries.len() as u64 {
                    let average_item = total / entries.len().max(1) as u64;
                    total = average_item.saturating_mul(item_count);
                    approx = true;
                }
                return (Some(total), approx);
            }
            let default_duration = ytdlp_default_duration_seconds(mode);
            return (
                Some(
                    item_count
                        .saturating_mul(default_duration)
                        .saturating_mul(ytdlp_bytes_per_second(mode)),
                ),
                true,
            );
        }
    }
    if let Some(count) = json_u64(metadata, "playlist_count") {
        if count > 0 {
            let default_duration = ytdlp_default_duration_seconds(mode);
            return (
                Some(
                    count
                        .saturating_mul(default_duration)
                        .saturating_mul(ytdlp_bytes_per_second(mode)),
                ),
                true,
            );
        }
    }
    if let Some(duration) = json_u64(metadata, "duration") {
        return (
            Some(duration.saturating_mul(ytdlp_bytes_per_second(mode))),
            true,
        );
    }
    (None, false)
}

fn extract_ytdlp_youtube_ids(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for line in text.lines() {
        let Some(start) = line.find("[youtube] ") else {
            continue;
        };
        let rest = &line[start + "[youtube] ".len()..];
        let id = rest
            .split(|c: char| c == ':' || c.is_whitespace())
            .next()
            .unwrap_or("")
            .trim();
        if id.len() < 6
            || id.len() > 20
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            continue;
        }
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_owned());
        }
    }
    ids
}

fn ytdlp_line_is_noise(line: &str) -> bool {
    let lower = line.trim().to_ascii_lowercase();
    lower.is_empty()
        || lower.starts_with("warning:")
        || lower.starts_with("info:")
        || lower.contains("po token")
        || lower.contains("may yield http error 403")
}

fn sanitize_ytdlp_error(value: &str) -> String {
    let line = value
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !ytdlp_line_is_noise(line))
        .or_else(|| {
            value
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| !line.is_empty())
        })
        .unwrap_or("yt-dlp could not process this URL.");
    let mut cleaned = line.replace(['\r', '\n'], " ");
    if cleaned.len() > 500 {
        cleaned.truncate(500);
    }
    cleaned
}

fn is_ytdlp_auth_or_cookie_error(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("po token") || lower.contains("may yield http error 403") {
        return false;
    }
    lower.contains("private video")
        || lower.contains("sign in if you've been granted access")
        || lower.contains("cookies-from-browser")
        || lower.contains("cookies for the auth")
        || lower.contains("cookies are no longer valid")
        || lower.contains("rotated in the browser")
        || lower.contains("sign in to confirm")
        || lower.contains("bot verification")
        || lower.contains("members-only")
        || lower.contains("join this channel")
        || lower.contains("login required")
        || lower.contains("requires authentication")
        || lower.contains("rate-limited by youtube")
        || lower.contains("rate limit")
        || lower.contains("this content isn't available, try again later")
        || lower.contains("http error 403")
        || lower.contains("403: forbidden")
        || lower.contains("403 forbidden")
}

fn ytdlp_failure_message(detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    let video_hint = extract_ytdlp_youtube_ids(detail)
        .into_iter()
        .next()
        .map(|id| format!(" [video {id}]"))
        .unwrap_or_default();
    if lower.contains("po token") || lower.contains("may yield http error 403") {
        format!(
            "Download failed:{video_hint} {detail} YouTube skipped some formats that need a PO token; this is usually not a cookies problem. Retry the download, or update yt-dlp if it keeps failing."
        )
    } else if is_ytdlp_auth_or_cookie_error(detail) {
        format!(
            "Download failed:{video_hint} {detail} YouTube requires account authentication. Please refresh or update YouTube cookies in Admin settings."
        )
    } else {
        let likely_rate_limit = lower.contains("rate limit")
            || lower.contains("too many requests")
            || lower.contains("http error 429")
            || lower.contains("http error 403")
            || lower.contains("unable to download");
        if likely_rate_limit {
            format!(
                "Download failed:{video_hint} {detail} Stop retrying for now and wait at least an hour before trying again — immediate retries often trigger stronger site limits."
            )
        } else {
            format!(
                "Download failed:{video_hint} {detail} Wait a while before retrying this download."
            )
        }
    }
}

fn is_ytdlp_403_or_forbidden(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        if ytdlp_line_is_noise(line) {
            return false;
        }
        let lower = line.trim().to_ascii_lowercase();
        lower.contains("http error 403")
            || lower.contains("403: forbidden")
            || lower.contains("403 forbidden")
    })
}

async fn inspect_ytdlp_metadata(
    state: &AppState,
    user: &StoredUser,
    url: &str,
    destination_path: &str,
    mode: &str,
) -> Result<YtDlpInspection, (StatusCode, String)> {
    let url = validate_public_download_url(url)
        .await
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    let (destination_path, _) =
        validate_ytdlp_destination(state, user, destination_path, mode).await?;
    let status = state.ytdlp_tool.lock().await.clone();
    if !status.ready || !state.ytdlp_path.is_file() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            status.error.unwrap_or_else(|| {
                "yt-dlp is still being installed. Try again shortly.".to_owned()
            }),
        ));
    }
    let throttle = read_ytdlp_settings(&state.ytdlp_settings_path).await;
    let initial_output = run_ytdlp_inspect(&state, &url, &throttle, true)
        .await
        .map_err(|message| {
            if message.contains("timed out") {
                (StatusCode::GATEWAY_TIMEOUT, message)
            } else {
                (StatusCode::BAD_GATEWAY, message)
            }
        })?;

    let inspected = match parse_ytdlp_inspect_metadata(&initial_output) {
        Ok(meta) => Ok(meta),
        Err((status, message)) => {
            let stderr_str = String::from_utf8_lossy(&initial_output.stderr).to_string();
            let mut resolved = None;
            // Fallback 1: Try without cookies (in case current cookies are rate-limited or expired for public videos)
            if let Ok(no_cookie_output) = run_ytdlp_inspect(&state, &url, &throttle, false).await {
                if let Ok(no_cookie_meta) = parse_ytdlp_inspect_metadata(&no_cookie_output) {
                    resolved = Some(Ok(no_cookie_meta));
                }
            }
            // Fallback 2: If still failing and it's an auth/cookie issue, auto-refresh cookies and retry
            if resolved.is_none()
                && (is_ytdlp_auth_or_cookie_error(&message)
                    || is_ytdlp_auth_or_cookie_error(&stderr_str))
            {
                tracing::info!(url = %url, "yt-dlp inspection failed with auth/cookie error; attempting automatic cookie refresh from browser");
                if let Ok((browser, _)) = perform_ytdlp_cookie_extraction(state, None).await {
                    tracing::info!(browser = %browser, "Auto-refreshed cookies from browser; retrying URL inspection");
                    if let Ok(retry_output) = run_ytdlp_inspect(&state, &url, &throttle, true).await
                    {
                        resolved = Some(parse_ytdlp_inspect_metadata(&retry_output));
                    }
                }
            }
            resolved.unwrap_or(Err((status, message)))
        }
    };

    let metadata = inspected.map_err(|(status, message)| {
        if status == StatusCode::UNPROCESSABLE_ENTITY {
            (
                status,
                ytdlp_inspect_error_message(&message, &url, user.is_admin),
            )
        } else {
            (status, message)
        }
    })?;
    let title = metadata
        .get("title")
        .or_else(|| metadata.get("playlist_title"))
        .and_then(Value::as_str)
        .unwrap_or("Server download")
        .chars()
        .take(240)
        .collect();
    let extractor = metadata
        .get("extractor_key")
        .or_else(|| metadata.get("extractor"))
        .and_then(Value::as_str)
        .unwrap_or("Generic")
        .chars()
        .take(80)
        .collect();
    let item_count = json_u64(&metadata, "playlist_count")
        .or_else(|| {
            metadata
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| entries.len() as u64)
        })
        .or(Some(1));
    let (estimated_bytes, estimated_bytes_is_approx) = ytdlp_estimated_bytes(&metadata, mode);
    let mut preview_items = ytdlp_preview_items(&metadata);
    if item_count.unwrap_or(0) > 1 {
        let fetched = fetch_ytdlp_preview_items(state, &url, &throttle).await;
        preview_items = merge_ytdlp_preview_items(preview_items, fetched);
    }
    let _guard = state.persistence_lock.lock().await;
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    reconcile_storage_ledger(state, &mut ledger).await;
    let quota = storage_quota_response(user, &ledger);
    Ok(YtDlpInspection {
        title,
        extractor,
        item_count,
        estimated_bytes,
        estimated_bytes_is_approx,
        preview_items,
        mode: mode.to_owned(),
        destination_path,
        quota,
    })
}

async fn inspect_ytdlp_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<YtDlpInspectRequest>,
) -> Result<Json<YtDlpInspection>, (StatusCode, Json<Value>)> {
    let user = authenticated_user(&state, &headers).await.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "message": "Sign in to inspect a URL." })),
        )
    })?;
    inspect_ytdlp_metadata(
        &state,
        &user,
        &request.url,
        &request.destination_path,
        &request.mode,
    )
    .await
    .map(Json)
    .map_err(|(status, message)| (status, Json(serde_json::json!({ "message": message }))))
}

async fn queue_ytdlp_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<YtDlpQueueRequest>,
) -> Result<(StatusCode, Json<YtDlpJob>), (StatusCode, Json<Value>)> {
    let user = authenticated_user(&state, &headers).await.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "message": "Sign in to queue a download." })),
        )
    })?;
    let url = validate_public_download_url(&request.url)
        .await
        .map_err(|message| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "message": message })),
            )
        })?;
    let inspection = inspect_ytdlp_metadata(
        &state,
        &user,
        &url,
        &request.destination_path,
        &request.mode,
    )
    .await
    .map_err(|(status, message)| (status, Json(serde_json::json!({ "message": message }))))?;
    if request.playlist_id.is_some() && request.new_playlist_name.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::json!({ "message": "Choose either an existing playlist or a new playlist name, not both." }),
            ),
        ));
    }
    if request.folder_path.is_some() && request.new_folder_name.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::json!({ "message": "Choose either an existing folder or a new folder name, not both." }),
            ),
        ));
    }
    let tags = if request.tags.is_empty() {
        Vec::new()
    } else {
        normalize_tags(request.tags.clone())
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "message": "One or more tags are invalid." })),
                )
            })?
            .into_iter()
            .collect()
    };
    let playlist_id = request
        .playlist_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let new_playlist_name = request
        .new_playlist_name
        .as_ref()
        .and_then(|value| clean_playlist_name(value));
    let folder_path = request
        .folder_path
        .as_ref()
        .map(|value| value.trim().replace('\\', "/"))
        .filter(|value| !value.is_empty());
    let new_folder_name = request
        .new_folder_name
        .as_ref()
        .and_then(|value| clean_folder_name(value));
    if request.playlist_id.is_some() && playlist_id.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "message": "Choose a playlist to add downloads to." })),
        ));
    }
    if request.new_playlist_name.is_some() && new_playlist_name.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "message": "Enter a valid playlist name." })),
        ));
    }
    if request.folder_path.is_some() && folder_path.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "message": "Choose a folder to download into." })),
        ));
    }
    if request.new_folder_name.is_some() && new_folder_name.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "message": "Enter a valid folder name." })),
        ));
    }
    if let Some(path) = folder_path.as_ref() {
        if !safe_relative_path(path) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "message": "The selected folder path is invalid." })),
            ));
        }
        let destination = inspection.destination_path.trim().replace('\\', "/");
        if path.as_str() != destination && !path.starts_with(&format!("{destination}/")) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(
                    serde_json::json!({ "message": "The selected folder must be inside the destination library." }),
                ),
            ));
        }
        let folder = state.library_root.join(path);
        if !folder.is_dir() {
            return Err((
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "message": "The selected folder no longer exists." })),
            ));
        }
    }
    if playlist_id.is_some() || new_playlist_name.is_some() {
        let _guard = state.persistence_lock.lock().await;
        let states = read_user_states(&state.user_state_path).await;
        let user_state = states.users.get(&user.id);
        if let Some(id) = playlist_id.as_ref() {
            let exists = user_state.is_some_and(|state| state.playlists.contains_key(id));
            drop(_guard);
            if !exists {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(
                        serde_json::json!({ "message": "The selected playlist no longer exists." }),
                    ),
                ));
            }
        } else {
            drop(_guard);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = unix_now();
    let mut job = YtDlpJob {
        id: id.clone(),
        user_id: user.id,
        user_name: user.name.clone(),
        url,
        destination_path: inspection.destination_path,
        mode: inspection.mode,
        title: inspection.title,
        extractor: inspection.extractor,
        item_count: inspection.item_count,
        estimated_bytes: inspection.estimated_bytes,
        reserved_bytes: 0,
        downloaded_bytes: 0,
        progress: 0.0,
        speed: None,
        eta: None,
        current_item: None,
        status: "queued".to_owned(),
        error: None,
        created_at: now,
        updated_at: now,
        process_pid: None,
        cancel_requested: false,
        tags,
        playlist_id,
        new_playlist_name,
        folder_path,
        new_folder_name,
        cookie_refresh_attempted: false,
    };
    {
        let _guard = state.persistence_lock.lock().await;
        let mut ledger = read_storage_ledger(&state.storage_path).await;
        reconcile_storage_ledger(&state, &mut ledger).await;
        let quota = storage_quota_response(&user, &ledger);
        let reserve = inspection
            .estimated_bytes
            .unwrap_or_else(|| quota.available_bytes.unwrap_or(0));
        if user.storage_quota_bytes.is_some() && reserve == 0 {
            return Err((
                StatusCode::INSUFFICIENT_STORAGE,
                Json(serde_json::json!({ "message": "Your server storage quota is full." })),
            ));
        }
        if !reserve_storage(&mut ledger, &user, &id, "yt-dlp", reserve) {
            return Err((
                StatusCode::INSUFFICIENT_STORAGE,
                Json(
                    serde_json::json!({ "message": "This download would exceed your server storage quota." }),
                ),
            ));
        }
        job.reserved_bytes = reserve;
        write_storage_ledger(&state.storage_path, &ledger)
            .await
            .map_err(|status| {
                (
                    status,
                    Json(serde_json::json!({ "message": "Could not reserve server storage." })),
                )
            })?;
        let mut jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
        jobs.jobs.push(job.clone());
        write_ytdlp_jobs(&state.download_jobs_path, &jobs)
            .await
            .map_err(|status| {
                (
                    status,
                    Json(serde_json::json!({ "message": "Could not save the download job." })),
                )
            })?;
    }
    state.ytdlp_notify.notify_one();
    tracing::info!(event = "ytdlp_download_queued", user = %user.name, job_id = %job.id, title = %job.title, destination = %job.destination_path, mode = %job.mode, extractor = %job.extractor, "yt-dlp job queued");
    Ok((StatusCode::ACCEPTED, Json(job)))
}

async fn clean_orphaned_ytdlp_staging(state: &AppState, active_job_ids: &[String]) {
    if let Ok(mut entries) = tokio::fs::read_dir(&state.ytdlp_staging_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if !active_job_ids.iter().any(|id| id == &*name) {
                let path = entry.path();
                if let Ok(file_type) = entry.file_type().await {
                    if file_type.is_dir() {
                        let _ = tokio::fs::remove_dir_all(&path).await;
                    } else {
                        let _ = tokio::fs::remove_file(&path).await;
                    }
                }
            }
        }
    }
}

async fn reconcile_ytdlp_jobs(state: &AppState) -> YtDlpJobs {
    let mut jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
    let original_count = jobs.jobs.len();
    jobs.jobs
        .retain(|job| job.status != "complete" && job.status != "completed");
    if jobs.jobs.len() != original_count {
        let _ = write_ytdlp_jobs(&state.download_jobs_path, &jobs).await;
    }
    let mut dead_jobs = Vec::new();
    let mut modified = false;

    for job in &mut jobs.jobs {
        if job.status == "running" {
            let is_alive = job.process_pid.is_some_and(is_pid_alive);
            if !is_alive {
                dead_jobs.push((job.id.clone(), job.process_pid));
            } else {
                let staging = state.ytdlp_staging_dir.join(&job.id);
                if read_ytdlp_log_progress(&staging, job).await {
                    modified = true;
                }
                if let Some(eta) = estimate_playlist_eta(&staging, job) {
                    if job.eta.as_ref() != Some(&eta) {
                        job.eta = Some(eta);
                        modified = true;
                    }
                }
            }
        }
    }

    if modified {
        let _ = write_ytdlp_jobs(&state.download_jobs_path, &jobs).await;
    }

    for (job_id, pid) in dead_jobs {
        finalize_ytdlp_job(state, &job_id, pid).await;
    }

    let current_jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
    let active_ids: Vec<String> = current_jobs.jobs.iter().map(|j| j.id.clone()).collect();
    clean_orphaned_ytdlp_staging(state, &active_ids).await;

    current_jobs
}

async fn ytdlp_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<YtDlpJob>>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let mut jobs = read_ytdlp_jobs(&state.download_jobs_path).await.jobs;
    jobs.retain(|job| job.status != "complete" && job.status != "completed");
    if !user.is_admin {
        jobs.retain(|job| job.user_id == user.id);
    }
    jobs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(Json(jobs))
}

async fn refresh_ytdlp_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<YtDlpJob>>, StatusCode> {
    let user = authenticated_user(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let mut jobs = reconcile_ytdlp_jobs(&state).await.jobs;
    jobs.retain(|job| job.status != "complete" && job.status != "completed");
    if !user.is_admin {
        jobs.retain(|job| job.user_id == user.id);
    }
    jobs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(Json(jobs))
}

async fn control_ytdlp_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<YtDlpControlRequest>,
) -> Result<Json<YtDlpJob>, (StatusCode, Json<Value>)> {
    let user = authenticated_user(&state, &headers).await.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "message": "Sign in to control downloads." })),
        )
    })?;
    let _guard = state.persistence_lock.lock().await;
    let mut jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
    let job = jobs
        .jobs
        .iter_mut()
        .find(|job| job.id == id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "message": "Download job not found." })),
            )
        })?;
    if !user.is_admin && job.user_id != user.id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "You cannot control this download." })),
        ));
    }
    match request.action.as_str() {
        "cancel" => {
            job.cancel_requested = true;
            if let Some(pid) = job.process_pid {
                kill_pid_tree(pid).await;
            }
            let mut ledger = read_storage_ledger(&state.storage_path).await;
            release_storage_reservation(&mut ledger, &job.id);
            let _ = write_storage_ledger(&state.storage_path, &ledger).await;
            let _ = tokio::fs::remove_dir_all(state.ytdlp_staging_dir.join(&job.id)).await;
            if job.status != "running" {
                let response = job.clone();
                jobs.jobs.retain(|j| j.id != id);
                write_ytdlp_jobs(&state.download_jobs_path, &jobs)
                    .await
                    .map_err(|status| {
                        (
                            status,
                            Json(serde_json::json!({ "message": "Could not update the job." })),
                        )
                    })?;
                state.ytdlp_notify.notify_one();
                return Ok(Json(response));
            }
        }
        "interrupt"
            if !matches!(
                job.status.as_str(),
                "complete" | "cancelled" | "interrupted"
            ) =>
        {
            job.status = "interrupted".to_owned();
            job.cancel_requested = false;
            if job.error.is_none() {
                job.error = Some("Download was interrupted.".to_owned());
            }
            if let Some(pid) = job.process_pid {
                kill_pid_tree(pid).await;
            }
            if job.process_pid.is_none() {
                let mut ledger = read_storage_ledger(&state.storage_path).await;
                release_storage_reservation(&mut ledger, &job.id);
                let _ = write_storage_ledger(&state.storage_path, &ledger).await;
                job.reserved_bytes = 0;
            }
        }
        "refresh_cookies_and_retry" | "retry"
            if matches!(job.status.as_str(), "failed" | "interrupted" | "complete") =>
        {
            if request.action == "refresh_cookies_and_retry"
                || is_ytdlp_auth_or_cookie_error(job.error.as_deref().unwrap_or(""))
            {
                let state_clone = state.clone();
                tokio::spawn(async move {
                    let _ = perform_ytdlp_cookie_extraction(&state_clone, None).await;
                });
            }
            let mut ledger = read_storage_ledger(&state.storage_path).await;
            if !ledger
                .reservations
                .iter()
                .any(|reservation| reservation.id == job.id)
            {
                let owner = read_users(&state.users_path)
                    .await
                    .into_iter()
                    .find(|owner| owner.id == job.user_id)
                    .ok_or_else(|| {
                        (
                            StatusCode::CONFLICT,
                            Json(
                                serde_json::json!({ "message": "The job owner no longer exists." }),
                            ),
                        )
                    })?;
                reconcile_storage_ledger(&state, &mut ledger).await;
                let quota = storage_quota_response(&owner, &ledger);
                let bytes = job
                    .estimated_bytes
                    .unwrap_or_else(|| quota.available_bytes.unwrap_or(0));
                if owner.storage_quota_bytes.is_some() && bytes == 0
                    || !reserve_storage(&mut ledger, &owner, &job.id, "yt-dlp", bytes)
                {
                    return Err((
                        StatusCode::INSUFFICIENT_STORAGE,
                        Json(
                            serde_json::json!({ "message": "There is not enough quota to retry this download." }),
                        ),
                    ));
                }
                write_storage_ledger(&state.storage_path, &ledger)
                    .await
                    .map_err(|status| (status, Json(serde_json::json!({ "message": "Could not reserve storage for the retry." }))))?;
                job.reserved_bytes = bytes;
            }
            job.status = "queued".to_owned();
            job.cancel_requested = false;
            job.error = None;
            job.cookie_refresh_attempted = false;
        }
        "refresh" => {
            if job.status == "running" {
                let is_alive = job.process_pid.is_some_and(is_pid_alive);
                if !is_alive {
                    let pid = job.process_pid;
                    let job_id = job.id.clone();
                    drop(_guard);
                    finalize_ytdlp_job(&state, &job_id, pid).await;
                    let refreshed_jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
                    if let Some(refreshed) = refreshed_jobs.jobs.into_iter().find(|j| j.id == id) {
                        return Ok(Json(refreshed));
                    }
                    return Err((
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({ "message": "Job not found after refresh." })),
                    ));
                } else {
                    let staging = state.ytdlp_staging_dir.join(&id);
                    read_ytdlp_log_progress(&staging, job).await;
                    if let Some(eta) = estimate_playlist_eta(&staging, job) {
                        job.eta = Some(eta);
                    }
                }
            }
        }
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "message": "This action is not available for the job." })),
            ));
        }
    }
    job.updated_at = unix_now();
    let response = job.clone();
    write_ytdlp_jobs(&state.download_jobs_path, &jobs)
        .await
        .map_err(|status| {
            (
                status,
                Json(serde_json::json!({ "message": "Could not update the job." })),
            )
        })?;
    state.ytdlp_notify.notify_one();
    tracing::info!(event = "ytdlp_download_control", user = %user.name, job_id = %response.id, action = %request.action, status = %response.status, "yt-dlp download controlled");
    Ok(Json(response))
}

async fn update_ytdlp_job(
    state: &AppState,
    id: &str,
    update: impl FnOnce(&mut YtDlpJob),
) -> Result<YtDlpJob, StatusCode> {
    let _guard = state.persistence_lock.lock().await;
    let mut jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
    let job = jobs
        .jobs
        .iter_mut()
        .find(|job| job.id == id)
        .ok_or(StatusCode::NOT_FOUND)?;
    update(job);
    job.updated_at = unix_now();
    let response = job.clone();
    write_ytdlp_jobs(&state.download_jobs_path, &jobs).await?;
    Ok(response)
}

async fn remove_ytdlp_job(state: &AppState, id: &str) -> Result<(), StatusCode> {
    let _guard = state.persistence_lock.lock().await;
    let mut jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
    jobs.jobs.retain(|job| job.id != id);
    write_ytdlp_jobs(&state.download_jobs_path, &jobs).await
}

fn staging_directory_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok())
        .fold(0_u64, |total, metadata| {
            total.saturating_add(metadata.len())
        })
}

async fn ensure_ytdlp_reservation(
    state: &AppState,
    job: &YtDlpJob,
    bytes: u64,
) -> Result<(), String> {
    if bytes <= job.reserved_bytes {
        return Ok(());
    }
    let _guard = state.persistence_lock.lock().await;
    let users = read_users(&state.users_path).await;
    let user = users
        .iter()
        .find(|user| user.id == job.user_id)
        .ok_or_else(|| "The job owner no longer exists.".to_owned())?;
    if job.reserved_bytes == 0 && user.storage_quota_bytes.is_none() {
        return Ok(());
    }
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    let Some(reservation) = ledger
        .reservations
        .iter_mut()
        .find(|reservation| reservation.id == job.id)
    else {
        return Err("The job storage reservation is missing.".to_owned());
    };
    let previous = reservation.bytes;
    reservation.bytes = bytes;
    let (used, reserved) = storage_usage(&ledger, user.id);
    if user
        .storage_quota_bytes
        .is_some_and(|limit| used.saturating_add(reserved) > limit)
    {
        if let Some(reservation) = ledger
            .reservations
            .iter_mut()
            .find(|reservation| reservation.id == job.id)
        {
            reservation.bytes = previous;
        }
        return Err("This download reached your server storage quota.".to_owned());
    }
    write_storage_ledger(&state.storage_path, &ledger)
        .await
        .map_err(|_| "Could not expand the storage reservation.".to_owned())
}

async fn read_ytdlp_log_progress(staging: &Path, job: &mut YtDlpJob) -> bool {
    let stdout_path = staging.join("stdout.log");
    let Ok(bytes) = tokio::fs::read(&stdout_path).await else {
        return false;
    };
    let content = String::from_utf8_lossy(&bytes);
    for line in content.lines().rev() {
        let line = line.trim();
        if let Some(progress) = line.strip_prefix("TMS_PROGRESS|") {
            let fields = progress.splitn(6, '|').collect::<Vec<_>>();
            let downloaded = fields
                .first()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(job.downloaded_bytes);
            let total = fields.get(1).and_then(|value| value.parse::<u64>().ok());
            let speed = fields
                .get(2)
                .filter(|value| **value != "NA")
                .map(|value| (*value).to_owned());
            let eta = fields
                .get(3)
                .filter(|value| **value != "NA")
                .map(|value| (*value).to_owned());
            let playlist_index = fields.get(4).and_then(|value| value.parse::<u32>().ok());
            let title = fields
                .get(5)
                .filter(|value| **value != "NA")
                .map(|value| (*value).chars().take(240).collect::<String>());
            let file_progress = total
                .filter(|total| *total > 0)
                .map(|total| downloaded as f64 / total as f64)
                .unwrap_or(0.0)
                .clamp(0.0, 1.0);
            if let (Some(index), Some(item_count)) = (playlist_index, job.item_count) {
                if item_count > 0 {
                    job.progress = ((index.saturating_sub(1) as f64 + file_progress)
                        / item_count as f64)
                        .clamp(0.0, 0.999);
                } else {
                    job.progress = file_progress.clamp(0.0, 0.999);
                }
            } else {
                job.progress = file_progress.clamp(0.0, 0.999);
            }
            job.downloaded_bytes = downloaded;
            job.speed = speed;
            job.eta = eta;
            job.current_item = title;
            return true;
        }

        // Fallback for playlist scanning when items are skipped via download archive
        if let Some(archive_match) = line.strip_prefix("[download] ") {
            if let Some((_, title_and_suffix)) = archive_match.split_once(": ") {
                if let Some(title) =
                    title_and_suffix.strip_suffix(" has already been recorded in the archive")
                {
                    job.current_item = Some(title.chars().take(240).collect());
                    return true;
                }
            } else if let Some(item_info) = archive_match.strip_prefix("Downloading item ") {
                if let Some((current_str, total_str)) = item_info.split_once(" of ") {
                    if let (Ok(cur), Ok(tot)) = (
                        current_str.trim().parse::<u64>(),
                        total_str.trim().parse::<u64>(),
                    ) {
                        if tot > 0 {
                            job.progress =
                                (cur.saturating_sub(1) as f64 / tot as f64).clamp(0.0, 0.999);
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

#[derive(Clone, Debug)]
struct PlaylistStats {
    eta: String,
    eta_seconds: u64,
    avg_item_seconds: u64,
}

fn estimate_playlist_stats(staging: &Path, job: &YtDlpJob) -> Option<PlaylistStats> {
    let item_count = job.item_count?;
    if item_count <= 1 {
        return None;
    }
    let mut files = Vec::new();
    for entry in WalkDir::new(staging)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if entry.file_type().is_file() {
            let name = entry.file_name().to_string_lossy();
            if name == "stdout.log"
                || name == "stderr.log"
                || name == ".archive.txt"
                || name.ends_with(".part")
                || name.ends_with(".ytdl")
            {
                continue;
            }
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    files.push(modified);
                }
            }
        }
    }
    if files.len() < 2 {
        return None;
    }
    files.sort();
    let first = *files.first()?;
    let last = *files.last()?;
    let duration = last.duration_since(first).ok()?;
    let count = files.len() as f64;
    let avg_seconds = duration.as_secs_f64() / (count - 1.0);
    if avg_seconds <= 0.0 {
        return None;
    }
    let completed_items = count;
    let remaining_items = (item_count as f64 - completed_items).max(0.0);
    let remaining_seconds = (remaining_items * avg_seconds) as u64;

    let days = remaining_seconds / 86400;
    let hours = (remaining_seconds % 86400) / 3600;
    let minutes = (remaining_seconds % 3600) / 60;
    let seconds = remaining_seconds % 60;

    let mut formatted = String::new();
    if days > 0 {
        formatted.push_str(&format!("{days}d "));
    }
    if hours > 0 {
        formatted.push_str(&format!("{hours}h "));
    }
    if minutes > 0 || hours > 0 {
        formatted.push_str(&format!("{minutes}m "));
    }
    formatted.push_str(&format!("{seconds}s"));
    Some(PlaylistStats {
        eta: formatted,
        eta_seconds: remaining_seconds,
        avg_item_seconds: avg_seconds.round() as u64,
    })
}

fn estimate_playlist_eta(staging: &Path, job: &YtDlpJob) -> Option<String> {
    estimate_playlist_stats(staging, job).map(|stats| stats.eta)
}

async fn read_ytdlp_recent_stderr(staging: &Path) -> String {
    let stderr_path = staging.join("stderr.log");
    if let Ok(bytes) = tokio::fs::read(&stderr_path).await {
        let content = String::from_utf8_lossy(&bytes);
        let lines = content
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>();
        let start = lines.len().saturating_sub(20);
        lines[start..].join("\n")
    } else {
        String::new()
    }
}

async fn spawn_detached_ytdlp_process(
    state: &AppState,
    job: &YtDlpJob,
    staging: &Path,
) -> Result<u32, String> {
    tokio::fs::create_dir_all(staging)
        .await
        .map_err(|e| format!("Could not create download staging directory: {e}"))?;

    let stdout_path = staging.join("stdout.log");
    let stderr_path = staging.join("stderr.log");

    let stdout_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_path)
        .map_err(|e| format!("Could not open stdout log: {e}"))?;
    let stderr_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .map_err(|e| format!("Could not open stderr log: {e}"))?;

    let throttle = read_ytdlp_settings(&state.ytdlp_settings_path).await;
    let output_template = "%(playlist_title|Single downloads).100B/%(title).160B.%(ext)s";
    let progress_template = "download:TMS_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|%(info.title)s";

    let mut command = hidden_async_command(&state.ytdlp_path);
    command
        .arg("--paths")
        .arg(staging)
        .arg("--output")
        .arg(output_template)
        .arg("--download-archive")
        .arg(state.ytdlp_dir.join("archive.txt"))
        .args([
            "--continue",
            "--no-overwrites",
            "--windows-filenames",
            "--trim-filenames",
            "180",
            "--newline",
            "--progress-template",
            progress_template,
            "--embed-metadata",
            "--retries",
            "3",
            "--fragment-retries",
            "3",
            "--extractor-retries",
            "2",
        ]);
    if job.item_count.unwrap_or(1) > 1 {
        command.arg("--no-abort-on-error");
    } else {
        command.arg("--abort-on-error");
    }
    if state.ffmpeg_path.is_file() {
        command.arg("--ffmpeg-location").arg(&state.ffmpeg_path);
    }
    let cookies_txt = state.ytdlp_path.parent().unwrap().join("cookies.txt");
    if cookies_txt.is_file() {
        command.arg("--cookies").arg(cookies_txt);
    }
    if job.mode == "audio" {
        command.args(["--extract-audio", "--format", "bestaudio/best"]);
    }
    append_ytdlp_runtime_args(&mut command);
    append_ytdlp_youtube_args(&mut command, &job.url);
    append_ytdlp_throttle_args(&mut command, &throttle);
    command
        .arg("--")
        .arg(&job.url)
        .stdin(std::process::Stdio::null())
        .stdout(stdout_file)
        .stderr(stderr_file);

    #[cfg(windows)]
    {
        command.creation_flags(0x08000000 | 0x00000200);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("Could not start yt-dlp: {e}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "Could not obtain process ID for yt-dlp".to_owned())?;
    Ok(pid)
}

async fn finalize_ytdlp_job(state: &AppState, job_id: &str, pid: Option<u32>) {
    let staging = state.ytdlp_staging_dir.join(job_id);
    let job_opt = {
        let jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
        jobs.jobs.into_iter().find(|j| j.id == job_id)
    };
    let Some(job) = job_opt else {
        return;
    };

    let stderr = read_ytdlp_recent_stderr(&staging).await;
    let sanitized_err = sanitize_ytdlp_error(&stderr);
    let run_error =
        if !sanitized_err.is_empty() && sanitized_err != "yt-dlp could not process this URL." {
            Some(ytdlp_failure_message(&sanitized_err))
        } else {
            None
        };

    match publish_ytdlp_job(state, &job, &staging).await {
        Ok(files) => {
            let _guard = state.persistence_lock.lock().await;
            let mut ledger = read_storage_ledger(&state.storage_path).await;
            finalize_storage_reservation(
                &mut ledger,
                &job.id,
                job.user_id,
                "yt-dlp",
                Some(&job.id),
                &files,
            );
            if write_storage_ledger(&state.storage_path, &ledger)
                .await
                .is_err()
            {
                drop(_guard);
                for (path, _) in &files {
                    let _ = tokio::fs::remove_file(state.library_root.join(path)).await;
                }
                release_persisted_reservation(state, &job.id).await;
                let _ = update_ytdlp_job(state, &job.id, |saved| {
                    saved.status = "failed".to_owned();
                    saved.error = Some(
                        "Media downloaded, but storage accounting could not be saved.".to_owned(),
                    );
                    saved.reserved_bytes = 0;
                    saved.process_pid = None;
                })
                .await;
                tracing::error!(
                    job_id = %job.id,
                    user = %job.user_name,
                    pid = ?pid,
                    reason = "storage_accounting",
                    "yt-dlp download failed after media was retrieved"
                );
                return;
            }
            drop(_guard);
            let _ = tokio::fs::remove_dir_all(&staging).await;
            let total = files
                .iter()
                .fold(0_u64, |sum, (_, bytes)| sum.saturating_add(*bytes));
            let published_paths = files
                .iter()
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>();
            if let Err(message) = apply_ytdlp_organization(
                state,
                job.user_id,
                &published_paths,
                job.tags.clone(),
                job.playlist_id.clone(),
                job.new_playlist_name.clone(),
            )
            .await
            {
                for path in &published_paths {
                    let _ = tokio::fs::remove_file(state.library_root.join(path)).await;
                }
                release_persisted_reservation(state, &job.id).await;
                let _ = update_ytdlp_job(state, &job.id, |saved| {
                    saved.status = "failed".to_owned();
                    saved.error = Some(message);
                    saved.reserved_bytes = 0;
                    saved.process_pid = None;
                })
                .await;
                tracing::error!(
                    job_id = %job.id,
                    user = %job.user_name,
                    pid = ?pid,
                    reason = "post_download_organization",
                    "yt-dlp download failed while organizing output"
                );
                return;
            }
            let was_interrupted = job.status == "interrupted";
            let is_incomplete = job
                .item_count
                .is_some_and(|count| count > 1 && (files.len() as u64) < count);
            let partial_notice = if (was_interrupted || is_incomplete) && run_error.is_none() {
                if let Some(count) = job.item_count {
                    Some(format!(
                        "Saved {} of {} item(s). Download interrupted.",
                        files.len(),
                        count
                    ))
                } else {
                    Some(format!(
                        "Saved {} item(s). Download interrupted.",
                        files.len()
                    ))
                }
            } else {
                run_error.as_ref().map(|error| {
                    format!(
                        "Saved {} item(s). Some items were skipped: {error}",
                        files.len()
                    )
                })
            };
            if let Some(notice) = partial_notice.as_ref() {
                tracing::warn!(
                    job_id = %job.id,
                    files = files.len(),
                    detail = %notice,
                    "yt-dlp job completed with skipped items"
                );
            }
            let is_partial = partial_notice.is_some();
            if is_partial || was_interrupted || is_incomplete {
                let _ = update_ytdlp_job(state, &job.id, |saved| {
                    saved.status = "interrupted".to_owned();
                    saved.progress = (files.len() as f64
                        / job.item_count.unwrap_or(files.len() as u64) as f64)
                        .clamp(0.0, 0.999);
                    saved.downloaded_bytes = total;
                    saved.reserved_bytes = 0;
                    saved.speed = None;
                    saved.eta = None;
                    saved.error = partial_notice.clone().or_else(|| saved.error.clone());
                    saved.process_pid = None;
                })
                .await;
            } else {
                let _ = remove_ytdlp_job(state, &job.id).await;
            }
            let _ = tokio::fs::remove_dir_all(&staging).await;
            tracing::info!(
                event = "ytdlp_download_completed",
                user = %job.user_name,
                job_id = %job.id,
                pid = ?pid,
                files = files.len(),
                bytes = total,
                "Independent yt-dlp job completed"
            );
        }
        Err(message) => {
            let was_interrupted = job.status == "interrupted";
            let final_err = if was_interrupted {
                job.error
                    .clone()
                    .unwrap_or_else(|| "Download was interrupted.".to_owned())
            } else {
                run_error.clone().unwrap_or(message.clone())
            };

            // If yt-dlp completed without errors and all items were already recorded in the archive,
            // treat the job as successfully completed rather than failed.
            if message == "yt-dlp finished without producing supported media files."
                && run_error.is_none()
                && !was_interrupted
                && !is_ytdlp_auth_or_cookie_error(&stderr)
            {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                release_persisted_reservation(state, &job.id).await;
                let _ = remove_ytdlp_job(state, &job.id).await;
                tracing::info!(
                    event = "ytdlp_download_completed",
                    user = %job.user_name,
                    job_id = %job.id,
                    pid = ?pid,
                    "yt-dlp playlist sync completed (all available tracks downloaded)"
                );
                return;
            }

            // Auto-refresh cookies if auth/cookie error and not already attempted
            if !was_interrupted
                && !job.cookie_refresh_attempted
                && (is_ytdlp_auth_or_cookie_error(&final_err)
                    || is_ytdlp_auth_or_cookie_error(&stderr))
            {
                tracing::info!(job_id = %job.id, "yt-dlp job failed with auth/cookie error; attempting automatic cookie refresh");
                if let Ok((browser, _)) = perform_ytdlp_cookie_extraction(state, None).await {
                    tracing::info!(job_id = %job.id, browser = %browser, "Auto-refreshed cookies from browser; requeuing download job");
                    let _ = tokio::fs::remove_dir_all(&staging).await;
                    let _ = update_ytdlp_job(state, &job.id, |saved| {
                        saved.status = "queued".to_owned();
                        saved.error = None;
                        saved.process_pid = None;
                        saved.cookie_refresh_attempted = true;
                    })
                    .await;
                    state.ytdlp_notify.notify_one();
                    return;
                }
            }

            let video_ids = extract_ytdlp_youtube_ids(&stderr);
            let _ = tokio::fs::remove_dir_all(&staging).await;
            release_persisted_reservation(state, &job.id).await;
            let _ = update_ytdlp_job(state, &job.id, |saved| {
                saved.status = if was_interrupted {
                    "interrupted".to_owned()
                } else {
                    "failed".to_owned()
                };
                saved.error = Some(final_err.clone());
                if saved.current_item.is_none() {
                    if let Some(id) = video_ids.last() {
                        saved.current_item = Some(format!("youtube:{id}"));
                    }
                }
                saved.reserved_bytes = 0;
                saved.process_pid = None;
            })
            .await;
            tracing::warn!(
                job_id = %job.id,
                user = %job.user_name,
                pid = ?pid,
                title = %job.title,
                current_item = ?job.current_item,
                failing_video_id = ?video_ids.last(),
                youtube_ids = ?video_ids,
                error = %final_err,
                reason = "no_usable_output",
                "yt-dlp download produced no usable media"
            );
        }
    }
}

async fn monitor_and_finalize_ytdlp_job(state: &AppState, job_id: &str, pid: u32) {
    let staging = state.ytdlp_staging_dir.join(job_id);
    let mut interval = tokio::time::interval(Duration::from_millis(750));

    loop {
        interval.tick().await;

        let job_opt = {
            let jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
            jobs.jobs.into_iter().find(|j| j.id == job_id)
        };
        let Some(mut job) = job_opt else {
            return;
        };

        if job.cancel_requested {
            kill_pid_tree(pid).await;
            tracing::info!(
                job_id = %job.id,
                user = %job.user_name,
                pid = %pid,
                reason = "user_cancelled",
                "Stopped independent yt-dlp download"
            );
            let _ = tokio::fs::remove_dir_all(&staging).await;
            release_persisted_reservation(state, &job.id).await;
            let _ = remove_ytdlp_job(state, &job.id).await;
            return;
        }

        if job.status == "interrupted" {
            kill_pid_tree(pid).await;
            tracing::info!(
                job_id = %job.id,
                user = %job.user_name,
                pid = %pid,
                reason = "user_interrupted",
                "Interrupted independent yt-dlp download"
            );
            break;
        }

        let staging_copy = staging.clone();
        let bytes = tokio::task::spawn_blocking(move || staging_directory_size(&staging_copy))
            .await
            .unwrap_or(0);
        if let Err(message) = ensure_ytdlp_reservation(state, &job, bytes).await {
            kill_pid_tree(pid).await;
            tracing::warn!(
                job_id = %job.id,
                user = %job.user_name,
                pid = %pid,
                reason = "storage_reservation",
                detail = %message,
                "Stopped independent yt-dlp download"
            );
            let _ = tokio::fs::remove_dir_all(&staging).await;
            release_persisted_reservation(state, &job.id).await;
            let _ = update_ytdlp_job(state, &job.id, |saved| {
                saved.status = "failed".to_owned();
                saved.error = Some(message);
                saved.reserved_bytes = 0;
                saved.process_pid = None;
            })
            .await;
            return;
        }

        let mut job_changed = false;
        if bytes > job.reserved_bytes {
            job.reserved_bytes = bytes;
            job_changed = true;
        }

        if read_ytdlp_log_progress(&staging, &mut job).await {
            job_changed = true;
        }

        if let Some(playlist_eta) = estimate_playlist_eta(&staging, &job) {
            job.eta = Some(playlist_eta);
            job_changed = true;
        }

        if job_changed {
            let snapshot = job.clone();
            let _ = update_ytdlp_job(state, &job.id, |saved| {
                saved.downloaded_bytes = snapshot.downloaded_bytes;
                saved.reserved_bytes = snapshot.reserved_bytes;
                saved.progress = snapshot.progress;
                saved.speed = snapshot.speed;
                saved.eta = snapshot.eta;
                saved.current_item = snapshot.current_item;
            })
            .await;
        }

        let stderr = read_ytdlp_recent_stderr(&staging).await;
        if is_ytdlp_403_or_forbidden(&stderr) {
            kill_pid_tree(pid).await;
            let video_ids = extract_ytdlp_youtube_ids(&stderr);
            let failing_video = video_ids.last().cloned();
            let sanitized = sanitize_ytdlp_error(&stderr);
            let error_message = ytdlp_failure_message(&sanitized);
            tracing::warn!(
                job_id = %job.id,
                user = %job.user_name,
                pid = %pid,
                title = %job.title,
                current_item = ?job.current_item,
                failing_video_id = ?failing_video,
                youtube_ids = ?video_ids,
                stderr_excerpt = %sanitized,
                reason = "http_403_forbidden",
                "YouTube returned HTTP 403 Forbidden - stopping download immediately to prevent further rate limits"
            );
            let _ = update_ytdlp_job(state, &job.id, |saved| {
                saved.status = "interrupted".to_owned();
                saved.error = Some(error_message);
                if saved.current_item.is_none() {
                    if let Some(id) = failing_video.as_ref() {
                        saved.current_item = Some(format!("youtube:{id}"));
                    }
                }
                saved.process_pid = None;
            })
            .await;
            break;
        }

        if !is_pid_alive(pid) {
            tracing::info!(job_id = %job.id, pid = %pid, "Independent yt-dlp process exited");
            break;
        }
    }

    finalize_ytdlp_job(state, job_id, Some(pid)).await;
}

fn spawn_ytdlp_worker(state: AppState) {
    supervise("ytdlp-worker", move || {
        let state = state.clone();
        async move {
            {
                let _guard = state.persistence_lock.lock().await;
                let mut jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
                let original_count = jobs.jobs.len();
                jobs.jobs
                    .retain(|j| j.status != "complete" && j.status != "completed");
                if jobs.jobs.len() != original_count {
                    let _ = write_ytdlp_jobs(&state.download_jobs_path, &jobs).await;
                }
                let active_ids: Vec<String> = jobs.jobs.iter().map(|j| j.id.clone()).collect();
                clean_orphaned_ytdlp_staging(&state, &active_ids).await;
                for job in jobs.jobs {
                    if job.status == "running" {
                        if let Some(pid) = job.process_pid {
                            if is_pid_alive(pid) {
                                tracing::info!(
                                    job_id = %job.id,
                                    pid = %pid,
                                    "Resuming monitoring of active independent yt-dlp process across restart"
                                );
                                let worker_state = state.clone();
                                let job_id = job.id.clone();
                                tokio::spawn(async move {
                                    monitor_and_finalize_ytdlp_job(&worker_state, &job_id, pid)
                                        .await;
                                });
                                continue;
                            }
                        }
                        tracing::info!(
                            job_id = %job.id,
                            "yt-dlp process ended during server restart, finalizing"
                        );
                        let worker_state = state.clone();
                        let job_id = job.id.clone();
                        tokio::spawn(async move {
                            finalize_ytdlp_job(&worker_state, &job_id, job.process_pid).await;
                        });
                    }
                }
            }

            loop {
                let ready = state.ytdlp_tool.lock().await.ready;
                let (running_count, dead_running_jobs) = {
                    let jobs = read_ytdlp_jobs(&state.download_jobs_path).await;
                    let mut running = 0;
                    let mut dead = Vec::new();
                    for job in jobs.jobs {
                        if job.status == "running" {
                            if job.process_pid.is_some_and(is_pid_alive) {
                                running += 1;
                            } else {
                                dead.push((job.id, job.process_pid));
                            }
                        }
                    }
                    (running, dead)
                };

                for (job_id, pid) in dead_running_jobs {
                    tracing::warn!(job_id = %job_id, "Found running yt-dlp job whose process is no longer active, finalizing as interrupted");
                    let worker_state = state.clone();
                    tokio::spawn(async move {
                        finalize_ytdlp_job(&worker_state, &job_id, pid).await;
                    });
                }

                let next = if ready && running_count == 0 {
                    read_ytdlp_jobs(&state.download_jobs_path)
                        .await
                        .jobs
                        .into_iter()
                        .find(|job| job.status == "queued")
                } else {
                    None
                };

                if let Some(job) = next {
                    let staging = state.ytdlp_staging_dir.join(&job.id);
                    match spawn_detached_ytdlp_process(&state, &job, &staging).await {
                        Ok(pid) => {
                            let _ = update_ytdlp_job(&state, &job.id, |saved| {
                                saved.status = "running".to_owned();
                                saved.process_pid = Some(pid);
                                saved.error = None;
                                saved.cancel_requested = false;
                            })
                            .await;
                            tracing::info!(
                                job_id = %job.id,
                                user = %job.user_name,
                                pid = %pid,
                                "Launched detached independent yt-dlp process"
                            );
                            let worker_state = state.clone();
                            let job_id = job.id.clone();
                            tokio::spawn(async move {
                                monitor_and_finalize_ytdlp_job(&worker_state, &job_id, pid).await;
                            });
                        }
                        Err(error) => {
                            release_persisted_reservation(&state, &job.id).await;
                            let _ = update_ytdlp_job(&state, &job.id, |saved| {
                                saved.status = "failed".to_owned();
                                saved.error = Some(format!("Could not start yt-dlp: {error}"));
                                saved.reserved_bytes = 0;
                                saved.process_pid = None;
                            })
                            .await;
                        }
                    }
                    continue;
                }

                tokio::select! {
                    _ = state.ytdlp_notify.notified() => {}
                    _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                }
            }
        }
    });
}

async fn publish_ytdlp_job(
    state: &AppState,
    job: &YtDlpJob,
    staging: &Path,
) -> Result<Vec<(String, u64)>, String> {
    let libraries = read_libraries(state).await;
    let library_name = job.destination_path.split('/').next().unwrap_or_default();
    let library = libraries
        .get(library_name)
        .ok_or_else(|| "The destination library no longer exists.".to_owned())?;
    let files = WalkDir::new(staging)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    valid_upload_extension(&library.content_type, &extension.to_ascii_lowercase())
                })
        })
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Err("yt-dlp finished without producing supported media files.".to_owned());
    }
    let flatten_single = files.len() == 1;
    let use_custom_folder = job.folder_path.is_some() || job.new_folder_name.is_some();
    let destination_root = if let Some(folder_path) = job.folder_path.as_ref() {
        state.library_root.join(folder_path)
    } else if let Some(folder_name) = job.new_folder_name.as_ref() {
        state
            .library_root
            .join(&job.destination_path)
            .join(folder_name)
    } else {
        state.library_root.join(&job.destination_path)
    };
    let total_files = files.len();
    let mut published = Vec::new();
    let mut last_failure = None;
    // One unpublishable file must not strand the rest of a playlist, so each
    // file is handled independently and only a total failure aborts the job.
    for source in files {
        let Ok(relative) = source.strip_prefix(staging) else {
            last_failure = Some("yt-dlp produced a file outside its staging directory.".to_owned());
            continue;
        };
        let relative = if flatten_single {
            match source.file_name() {
                Some(name) => PathBuf::from(name),
                None => {
                    last_failure = Some("Downloaded media has no filename.".to_owned());
                    continue;
                }
            }
        } else if use_custom_folder {
            let components = relative.components().collect::<Vec<_>>();
            if components.len() > 1 {
                PathBuf::from_iter(components.into_iter().skip(1))
            } else {
                relative.to_owned()
            }
        } else {
            relative.to_owned()
        };
        let relative = clean_ytdlp_relative_path(relative);
        let destination = unique_destination_path(&destination_root.join(&relative));
        if let Some(parent) = destination.parent()
            && let Err(error) = tokio::fs::create_dir_all(parent).await
        {
            last_failure = Some(format!("Could not create the media folder: {error}"));
            continue;
        }
        if let Err(error) = tokio::fs::rename(&source, &destination).await {
            last_failure = Some(format!("Could not publish downloaded media: {error}"));
            continue;
        }
        let mut final_path = destination.clone();
        if library.content_type == "movies_tv" && is_video_file(&destination) {
            if let Ok(result) =
                organize_movie_tv_media(state, &destination, &destination_root, &job.title, None)
                    .await
                && let Some((_, organized)) = result.moves.first()
            {
                final_path = organized.clone();
            }
        }
        let Ok(metadata) = tokio::fs::metadata(&final_path).await else {
            last_failure = Some("Could not measure downloaded media.".to_owned());
            continue;
        };
        let Ok(logical) = final_path.strip_prefix(&state.library_root) else {
            last_failure = Some("Downloaded media was published outside the library.".to_owned());
            continue;
        };
        published.push((logical.to_string_lossy().replace('\\', "/"), metadata.len()));
    }
    if published.is_empty() {
        return Err(last_failure.unwrap_or_else(|| {
            "yt-dlp finished without producing supported media files.".to_owned()
        }));
    }
    if published.len() < total_files {
        tracing::warn!(
            job_id = %job.id,
            published = published.len(),
            downloaded = total_files,
            detail = last_failure.unwrap_or_default(),
            "Some downloaded files could not be published"
        );
    }
    Ok(published)
}

/// Publishing must never fail just because a name is taken, so a duplicate is
/// numbered instead of aborting the job and stranding the files already moved.
fn unique_destination_path(destination: &Path) -> PathBuf {
    if !destination.exists() {
        return destination.to_path_buf();
    }
    let parent = destination.parent().unwrap_or(Path::new(""));
    let stem = destination
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("download");
    let extension = destination.extension().and_then(|value| value.to_str());
    for index in 2..=9_999_u32 {
        let candidate = parent.join(match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        });
        if !candidate.exists() {
            return candidate;
        }
    }
    destination.to_path_buf()
}

#[cfg(test)]
mod tests {
    #[test]
    fn anime_batch_episodes_are_series_and_can_be_organized() {
        let episode = episode_name_from_release("[EMBER] The Fable - 01.mkv").unwrap();
        assert_eq!(episode.title, "The Fable");
        assert_eq!((episode.season, episode.episode), (1, 1));
        assert!(is_episode_path("Movies/The Fable S01/[EMBER] The Fable - 25 [1080p].mkv"));
        assert!(episode_name_from_release("The Fable - 2019.mkv").is_none());
        assert!(!is_episode_path("Movies/The Fable - 1080p.mkv"));
        assert!(episode_name_from_release("Movie - 01 Trailer.mkv").is_none());
    }

    use crate::qbit::{is_qbit_zero_progress_failure, is_recoverable_qbittorrent_connection_failure, qbittorrent_bound_interface, stale_vpn_interface_replacement, valid_magnet_link};
    use super::*;

    #[tokio::test]
    async fn hls_startup_waits_for_runway_but_accepts_finished_short_clips() {
        let directory = std::env::temp_dir().join(format!("tms-hls-runway-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let playlist = directory.join("stream.m3u8");
        let contents = "#EXTM3U\n#EXTINF:2.0,\nsegment_00000.ts\n";
        std::fs::write(directory.join("segment_00000.ts"), b"segment").unwrap();
        std::fs::write(&playlist, contents).unwrap();
        assert_eq!(playlist_playable_segment_count(&playlist, HLS_STARTUP_SEGMENTS).await, None);
        std::fs::write(&playlist, format!("{contents}#EXT-X-ENDLIST\n")).unwrap();
        assert_eq!(playlist_playable_segment_count(&playlist, HLS_STARTUP_SEGMENTS).await, Some(1));
        std::fs::remove_file(directory.join("segment_00000.ts")).unwrap();
        assert_eq!(playlist_playable_segment_count(&playlist, HLS_STARTUP_SEGMENTS).await, None);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn running_work_magnets_keep_controls_without_live_status() {
        assert_eq!(magnet_work_actions(false, false), vec!["resume", "cancel"]);
        assert_eq!(magnet_work_actions(true, true), vec!["resume", "cancel"]);
        assert_eq!(magnet_work_actions(true, false), vec!["pause", "cancel"]);
    }

    #[test]
    fn running_work_background_states_and_failed_completion() {
        assert_eq!(background_work_status(false, true, true, true, true), "paused");
        assert_eq!(background_work_status(true, false, true, false, false), "running");
        assert_eq!(background_work_status(false, false, false, false, false), "scanning library");
        assert_eq!(background_work_status(false, false, true, false, false), "waiting for computer idle");
        assert_eq!(background_work_status(false, false, true, false, true), "waiting for worker");
        assert_eq!(preview_completion(0, 0), 1.0);
        assert_eq!(preview_completion(10, 2), 0.8);
        assert_eq!(preview_completion(10, 0), 1.0);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn running_work_reaps_exited_children_and_preserves_output() {
        let directory = std::env::temp_dir().join(format!("tms-work-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("index.m3u8"), "cached output").unwrap();
        let mut child = hidden_async_command("cmd.exe").args(["/C", "exit", "0"]).spawn().unwrap();
        child.wait().await.unwrap();
        let live_child = hidden_async_command("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .kill_on_drop(true).spawn().unwrap();
        let mut active = BTreeMap::from([("finished".to_owned(), ActiveTranscode {
            preload: false, child, directory: directory.clone(), sessions: BTreeSet::new(),
            video_path: "episode.mkv".to_owned(), quality: "1080p".to_owned(),
            started_at: unix_now(), initiated_by: None,
        })]);
        active.insert("live".to_owned(), ActiveTranscode {
            preload: false, child: live_child, directory: directory.clone(), sessions: BTreeSet::new(),
            video_path: "playing.mkv".to_owned(), quality: "1080p".to_owned(),
            started_at: unix_now(), initiated_by: None,
        });
        prune_finished_transcodes(&mut active);
        assert!(!active.contains_key("finished"), "Exited processes must not block background work");
        assert!(active.contains_key("live"), "Running processes must remain registered");
        let mut live = active.remove("live").unwrap();
        live.child.kill().await.unwrap();
        assert!(directory.join("index.m3u8").exists(), "Viewers still need cached output");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn performance_log_matcher_only_selects_performance_events() {
        assert!(is_client_performance_line("INFO event=\"client_performance\" phase=library_load"));
        assert!(!is_client_performance_line("INFO event=\"client_error\" details=client_performance"));
        assert!(!is_client_performance_line("INFO event=\"other\" message=\"event=\\\"client_performance\\\"\""));
    }

    #[test]
    fn performance_log_reader_returns_newest_events_across_chunk_and_file_boundaries() {
        let directory = std::env::temp_dir().join(format!("tms-metrics-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let old = "tms.2026-09-22".to_owned();
        let new = "tms.2026-09-23".to_owned();
        std::fs::write(directory.join(&old), "old event=\"client_performance\" phase=library_load_complete\n").unwrap();
        std::fs::write(
            directory.join(&new),
            format!(
                "newer event=\"client_performance\" phase=library_load_complete details={}\nignored event=\"other\"\nnewest event=\"client_performance\" phase=image_load",
                "x".repeat(70_000)
            ),
        ).unwrap();
        let files = vec![old, new];
        let lines = latest_performance_lines(&directory, &files, 2);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("newest"));
        assert!(lines[1].starts_with("newer"));
        assert_eq!(latest_performance_lines(&directory, &files, 3)[2], "old event=\"client_performance\" phase=library_load_complete");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn durable_state_replaces_valid_json_and_preserves_corruption() {
        let base =
            std::env::temp_dir().join(format!("tms-persistence-test-{}", uuid::Uuid::new_v4()));
        let path = base.join("state.json");
        let first = serde_json::json!({"position": 12});
        let second = serde_json::json!({"position": 24});
        write_persisted_json(&path, &first).await.unwrap();
        write_persisted_json(&path, &second).await.unwrap();
        assert_eq!(read_persisted_json::<Value>(&path).await.unwrap(), second);
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 1);
        std::fs::write(&path, b"{broken").unwrap();
        assert!(write_persisted_json(&path, &first).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn media_moves_preserve_user_metadata_and_do_not_rewrite_sibling_prefixes() {
        let mut states: UserStates = serde_json::from_value(serde_json::json!({"users": {"1": {
            "favorites": ["Movies/Show/episode.mp4", "Movies/Showcase/other.mp4"],
            "playback": {"Movies/Show/episode.mp4": {"position": 42.0, "duration": 100.0, "updated": 10}},
            "last_accessed": {"Movies/Show/episode.mp4": 10},
            "tags": {"Movies/Show/episode.mp4": ["watch"]},
            "playlists": {"queue": {"id": "queue", "name": "Queue", "created_at": 1, "paths": ["Movies/Show/episode.mp4"]}}
        }}})).unwrap();
        rewrite_all_media_paths(&mut states, "Movies/Show", "Archive/Show");
        let user = &states.users[&1];
        assert!(user.favorites.contains("Archive/Show/episode.mp4"));
        assert!(user.favorites.contains("Movies/Showcase/other.mp4"));
        assert_eq!(user.playback["Archive/Show/episode.mp4"].position, 42.0);
        assert_eq!(user.last_accessed["Archive/Show/episode.mp4"], 10);
        assert!(user.tags["Archive/Show/episode.mp4"].contains("watch"));
        assert!(!user.playback.contains_key("Movies/Show/episode.mp4"));
        assert!(
            user.playlists["queue"]
                .paths
                .contains("Archive/Show/episode.mp4")
        );
    }
    fn test_session(access_token: &str, expires_at: u64) -> StoredSession {
        StoredSession {
            token: "device-secret".to_owned(),
            access_token: access_token.to_owned(),
            expires_at,
            user_id: 1,
            password_version: 0,
            created_at: current_unix_timestamp(),
            last_active_at: current_unix_timestamp(),
            device_id: "browser-1".to_owned(),
            device_name: "Chrome on Windows".to_owned(),
            user_agent: "test".to_owned(),
            ip_address: String::new(),
        }
    }

    #[test]
    fn device_credentials_remain_valid_when_legacy_access_tokens_expire() {
        let active = test_session("access-secret", current_unix_timestamp() + 60);
        assert!(session_accepts_access_token(&active, "access-secret"));
        assert!(session_accepts_access_token(&active, "device-secret"));
        let expired = test_session("access-secret", current_unix_timestamp().saturating_sub(1));
        assert!(!session_accepts_access_token(&expired, "access-secret"));
        assert!(session_accepts_access_token(&expired, "device-secret"));
        assert_eq!(auth_session_response(&expired, &StoredUser {
            id: 1,
            name: "Test".to_owned(),
            password_hash: None,
            created_at: 0,
            is_admin: false,
            admin_permissions: AdminPermissions::default(),
            password_version: 0,
            avatar: None,
            storage_quota_bytes: None,
        }).token, "device-secret");
    }

    #[test]
    fn device_session_ids_do_not_expose_refresh_tokens() {
        let session = test_session("access-secret", current_unix_timestamp() + 60);
        let public_id = session_public_id(&session);
        assert_ne!(public_id, session.token);
        assert_eq!(public_id.len(), 32);
        assert_eq!(public_id, session_public_id(&session));
    }

    #[test]
    fn safe_library_path_accepts_nested_relative_paths() {
        let root = Path::new(r"C:\media");
        assert_eq!(
            safe_library_path(root, "Movies/Example/video.mp4").unwrap(),
            root.join(r"Movies\Example\video.mp4")
        );
    }

    #[test]
    fn safe_library_path_rejects_traversal_and_absolute_paths() {
        let root = Path::new(r"C:\media");
        for unsafe_path in ["", "../secret", "Movies/../../secret", r"C:\secret"] {
            assert_eq!(
                safe_library_path(root, unsafe_path),
                Err(StatusCode::BAD_REQUEST)
            );
        }
    }

    #[test]
    fn automatic_folder_cover_prefers_an_image_before_a_video_frame_on_first_generation() {
        let base =
            std::env::temp_dir().join(format!("tms-folder-cover-test-{}", uuid::Uuid::new_v4()));
        let folder = base.join("Creator");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("clip.mp4"), b"video").unwrap();
        std::fs::write(folder.join("cover.png"), b"image").unwrap();

        let (chosen, kind) =
            automatic_folder_cover_candidate(&base, &folder, "Creator", None, false).unwrap();

        assert_eq!(kind, "image");
        assert_eq!(
            chosen.file_name().and_then(|name| name.to_str()),
            Some("cover.png")
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn changing_a_folder_cover_considers_images_and_videos() {
        let base =
            std::env::temp_dir().join(format!("tms-folder-cover-test-{}", uuid::Uuid::new_v4()));
        let folder = base.join("Creator");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("clip.mp4"), b"video").unwrap();
        std::fs::write(folder.join("cover.png"), b"image").unwrap();

        let kinds = (0..128)
            .filter_map(|seed| {
                automatic_folder_cover_candidate(&base, &folder, &seed.to_string(), None, true)
                    .map(|(_, kind)| kind)
            })
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(kinds, std::collections::HashSet::from(["image", "video"]));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn automatic_covers_are_disabled_for_movies_tv_folders() {
        let mut libraries = BTreeMap::new();
        libraries.insert(
            "Movies & TV".to_owned(),
            default_library_config("movies_tv".to_owned()),
        );
        libraries.insert(
            "Home Videos".to_owned(),
            default_library_config("mixed".to_owned()),
        );

        assert!(is_movies_tv_folder_path(
            "Movies & TV/Avengers Infinity War",
            &libraries
        ));
        assert!(is_movies_tv_folder_path(
            "Movies & TV/Andor/Season 01",
            &libraries
        ));
        assert!(!is_movies_tv_folder_path("Home Videos/Trips", &libraries));
        assert!(!is_movies_tv_folder_path("Missing/Folder", &libraries));
    }

    #[test]
    fn internal_data_directory_is_not_a_library() {
        assert!(!is_library_path(".tms-data"));
        assert!(!is_library_path(".TMS-DATA"));
        assert!(is_library_path("Movies"));
    }

    #[test]
    fn library_location_overlap_rejects_parents_children_and_duplicates() {
        assert!(paths_overlap(
            Path::new(r"D:\Media"),
            Path::new(r"d:\media")
        ));
        assert!(paths_overlap(
            Path::new(r"D:\Media\Shows"),
            Path::new(r"D:\Media")
        ));
        assert!(paths_overlap(
            Path::new(r"D:\Media"),
            Path::new(r"D:\Media\Shows")
        ));
        assert!(!paths_overlap(
            Path::new(r"D:\Media"),
            Path::new(r"D:\Media Archive")
        ));
        assert!(!paths_overlap(
            Path::new(r"D:\Media"),
            Path::new(r"E:\Media")
        ));
    }

    // Measured against the bundled FFmpeg build: its fps filter rounds each
    // timestamp to the nearest ten-second slot.
    #[test]
    fn trickplay_frame_estimate_matches_observed_ffmpeg_output() {
        for (duration, frames) in [
            (5.0, 1),
            (9.9, 1),
            (10.0, 1),
            (10.5, 1),
            (15.0, 2),
            (19.9, 2),
            (20.0, 2),
            (25.0, 3),
            (30.0, 3),
            (59.9, 6),
            (60.0, 6),
            (60.1, 6),
            (65.0, 7),
        ] {
            assert_eq!(
                trickplay_expected_frames(duration),
                frames,
                "duration {duration}"
            );
        }
    }

    #[test]
    fn generated_previews_are_recognised_without_regenerating_them() {
        let output_dir =
            std::env::temp_dir().join(format!("tms-trickplay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&output_dir).unwrap();

        assert!(!trickplay_is_complete(&output_dir, Some(30.0)));

        for index in 0..3 {
            std::fs::write(output_dir.join(trickplay_frame_name(index)), b"jpg").unwrap();
        }
        assert!(trickplay_is_complete(&output_dir, Some(30.0)));
        // A recognised preview records a marker, so later runs never need the
        // duration again.
        assert!(trickplay_marker_is_valid(&output_dir));
        assert!(trickplay_is_complete(&output_dir, None));

        std::fs::remove_dir_all(&output_dir).unwrap();
    }

    #[test]
    fn a_partly_generated_preview_is_still_pending() {
        let output_dir =
            std::env::temp_dir().join(format!("tms-trickplay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&output_dir).unwrap();
        for index in 0..2 {
            std::fs::write(output_dir.join(trickplay_frame_name(index)), b"jpg").unwrap();
        }

        assert!(!trickplay_is_complete(&output_dir, Some(600.0)));
        assert!(!trickplay_marker_is_valid(&output_dir));

        std::fs::remove_dir_all(&output_dir).unwrap();
    }

    #[test]
    fn a_marker_left_without_its_frames_does_not_count_as_generated() {
        let output_dir =
            std::env::temp_dir().join(format!("tms-trickplay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&output_dir).unwrap();
        write_trickplay_marker(&output_dir, 4);

        assert!(!trickplay_marker_is_valid(&output_dir));
        assert!(!trickplay_is_complete(&output_dir, Some(50.0)));

        std::fs::remove_dir_all(&output_dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn mounted_library_can_be_browsed_through_its_logical_path() {
        let base =
            std::env::temp_dir().join(format!("tms-library-mount-test-{}", uuid::Uuid::new_v4()));
        let root = base.join("main");
        let source = base.join("external");
        let mount = root.join("External Media");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("example.mp4"), b"test").unwrap();
        create_directory_mount(&source, &mount).unwrap();

        let entries = scan_folder(&root, &mount, &BTreeMap::new());
        assert!(
            entries
                .iter()
                .any(|entry| entry.path == "External Media/example.mp4")
        );
        assert!(mount.join("example.mp4").is_file());

        remove_directory_mount(&mount).unwrap();
        assert!(!mount.exists());
        assert!(source.join("example.mp4").is_file());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn library_sort_is_server_owned_and_keeps_folders_first() {
        let mut entries = vec![
            LibraryEntry {
                path: "Library/short.mp4".to_owned(),
                device_path: None,
                name: "short.mp4".to_owned(),
                kind: "file",
                preview_path: None,
                preview_kind: None,
                item_count: None,
                catalog_kind: None,
                catalog_title_path: None,
                size: 10,
                created_at: 100,
                duration: Some(30.0),
                thumbnail_aspect_ratio: None,
                modified_at: 100,
            },
            LibraryEntry {
                path: "Library/Season 1".to_owned(),
                device_path: None,
                name: "Season 1".to_owned(),
                kind: "folder",
                preview_path: None,
                preview_kind: None,
                item_count: None,
                catalog_kind: None,
                catalog_title_path: None,
                size: 0,
                created_at: 50,
                duration: None,
                thumbnail_aspect_ratio: None,
                modified_at: 50,
            },
            LibraryEntry {
                path: "Library/long.mp4".to_owned(),
                device_path: None,
                name: "long.mp4".to_owned(),
                kind: "file",
                preview_path: None,
                preview_kind: None,
                item_count: None,
                catalog_kind: None,
                catalog_title_path: None,
                size: 20,
                created_at: 200,
                duration: Some(300.0),
                thumbnail_aspect_ratio: None,
                modified_at: 200,
            },
        ];

        sort_library_entries(&mut entries, "length", "desc", None);

        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["Library/Season 1", "Library/long.mp4", "Library/short.mp4"]
        );
    }

    #[test]
    fn title_folder_preview_identifies_a_paged_series() {
        let mut libraries = BTreeMap::new();
        libraries.insert(
            "Movies & TV".to_owned(),
            LibraryConfig {
                content_type: "movies_tv".to_owned(),
                members: Vec::new(),
                title_folders: BTreeSet::new(),
                trickplay_enabled: false,
                folder_structure_static: false,
                source_path: None,
                folder_mounts: Vec::new(),
            },
        );
        let mut entries = vec![LibraryEntry {
            path: "Movies & TV/Andor".to_owned(),
            device_path: None,
            name: "Andor".to_owned(),
            kind: "folder",
            preview_path: Some("Movies & TV/Andor/Season 02/Andor S02E01.mp4".to_owned()),
            preview_kind: Some("video"),
            item_count: Some(12),
            catalog_kind: None,
            catalog_title_path: None,
            size: 0,
            created_at: 0,
            duration: None,
            thumbnail_aspect_ratio: None,
            modified_at: 0,
        }];

        annotate_catalog_entries(&mut entries, &libraries);

        assert_eq!(entries[0].catalog_kind, Some("series"));
        assert_eq!(
            entries[0].catalog_title_path.as_deref(),
            Some("Movies & TV/Andor")
        );
    }

    #[test]
    fn transcode_cleanup_removes_all_show_variants_and_preserves_other_media() {
        let root = std::env::temp_dir().join(format!("tms-transcode-cleanup-{}", uuid::Uuid::new_v4()));
        let library = Path::new("C:/TariqsMediaServer");
        for (key, source) in [("one", "TV/Show/Season 01/Episode.mkv"), ("two", "TV/Show/Season 02/Episode.mkv"), ("other", "TV/Show Extra/Episode.mkv")] {
            let directory = root.join(key);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("source-path.txt"), source).unwrap();
            std::fs::write(directory.join("segment_00000.ts"), "segment").unwrap();
        }
        let legacy = root.join("legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("ffmpeg.log"), "Input #0, matroska, from 'C:\\old\\TariqsMediaServer\\TV\\Show\\Episode.mkv':\n").unwrap();
        let master = root.join("auto");
        std::fs::create_dir_all(&master).unwrap();
        std::fs::write(master.join("master.m3u8"), "#EXTM3U\n/api/transcode/variant?video_path=TV%2FShow%2FEpisode.mkv&height=720\n").unwrap();
        let unknown = root.join("unknown");
        std::fs::create_dir_all(&unknown).unwrap();
        assert_eq!(remove_transcode_caches(&root, library, "TV/Show").unwrap(), 4);
        assert!(root.join("other/segment_00000.ts").is_file());
        assert!(unknown.is_dir());
        assert_eq!(remove_transcode_caches(&root, library, "TV/Show").unwrap(), 0);
        assert_eq!(remove_transcode_caches(&root, library, "TV/Show Extra/Episode.mkv").unwrap(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transcode_sources_reject_paths_outside_the_library() {
        let root = Path::new("C:/TariqsMediaServer");
        assert_eq!(logical_transcode_source("C:/elsewhere/movie.mkv", root), None);
        assert_eq!(logical_transcode_source("../movie.mkv", root), None);
        assert_eq!(logical_transcode_source("C:/old/TariqsMeidaServer/Movies/Movie.mkv", root).as_deref(), Some("Movies/Movie.mkv"));
        assert_eq!(logical_transcode_source("Movies/Movie.mkv", root).as_deref(), Some("Movies/Movie.mkv"));
    }

    #[test]
    fn trash_storage_keeps_the_original_folder_hierarchy() {
        assert_eq!(
            trash_stored_name("delete-123", "TV/Example Show/Season 01"),
            Some("delete-123/TV/Example Show/Season 01".to_owned())
        );
        assert_eq!(trash_stored_name("delete-123", "../outside"), None);
    }

    #[test]
    fn renamed_paths_update_the_item_and_descendants_only() {
        assert_eq!(
            rewrite_path_prefix(
                "Videos/Trips/Old name",
                "Videos/Trips/Old name",
                "Videos/Trips/New name"
            ),
            "Videos/Trips/New name"
        );
        assert_eq!(
            rewrite_path_prefix(
                "Videos/Trips/Old name/clip.mp4",
                "Videos/Trips/Old name",
                "Videos/Trips/New name"
            ),
            "Videos/Trips/New name/clip.mp4"
        );
        assert_eq!(
            rewrite_path_prefix(
                "Videos/Trips/Old names/clip.mp4",
                "Videos/Trips/Old name",
                "Videos/Trips/New name"
            ),
            "Videos/Trips/Old names/clip.mp4"
        );
    }

    #[test]
    fn tags_are_trimmed_and_deduplicated_case_insensitively() {
        let tags = normalize_tags(vec![
            "  Favorite clip ".to_owned(),
            "#Travel".to_owned(),
            "travel".to_owned(),
            " ".to_owned(),
        ])
        .unwrap();
        assert_eq!(
            tags,
            BTreeSet::from(["Favorite clip".to_owned(), "Travel".to_owned()])
        );
        assert!(normalize_tags(vec!["x".repeat(33)]).is_none());
    }

    #[test]
    fn magnet_links_require_a_bittorrent_info_hash() {
        assert!(valid_magnet_link(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(valid_magnet_link(
            "MAGNET:?XT=URN:BTIH:0123456789ABCDEF0123456789ABCDEF01234567"
        ));
        assert!(!valid_magnet_link("https://example.com/file.torrent"));
        assert!(!valid_magnet_link("magnet:?dn=missing-hash"));
        assert!(!valid_magnet_link("magnet:?xt=urn:btih:not-a-real-hash"));
        assert_eq!(
            magnet_info_hash("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            Some("0000000000000000000000000000000000000000".to_owned())
        );
    }

    #[test]
    fn magnet_status_accepts_current_and_legacy_route_flags() {
        for value in ["1", "true", "TRUE", "yes"] {
            assert!(
                MagnetStatusQuery {
                    check_route: Some(value.to_owned()),
                }
                .should_check_route()
            );
        }
        for value in ["0", "false", "no", "unexpected"] {
            assert!(
                !MagnetStatusQuery {
                    check_route: Some(value.to_owned()),
                }
                .should_check_route()
            );
        }
        assert!(!MagnetStatusQuery::default().should_check_route());
    }

    #[test]
    fn recognizes_season_packs_before_torrent_metadata_arrives() {
        assert_eq!(
            release_season_from_name(
                "Solar.Opposites.S05.COMPLETE.1080p.WEB.H264-SuccessfulCrab[TGx]"
            ),
            Some(ReleaseSeason {
                title: "Solar Opposites".to_owned(),
                season: 5,
            })
        );
        assert_eq!(
            magnet_display_name(
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Solar.Opposites.S03.COMPLETE"
            ),
            Some("Solar.Opposites.S03.COMPLETE".to_owned())
        );
        assert_eq!(
            release_season_from_name("The Boondocks (2005) Season 4"),
            Some(ReleaseSeason {
                title: "The Boondocks (2005)".to_owned(),
                season: 4,
            })
        );
    }

    #[test]
    fn qbittorrent_binding_prefers_the_display_interface_name() {
        let preferences = serde_json::json!({
            "current_interface_name": "ProtonVPN",
            "current_network_interface": "iftype53_32771"
        });
        assert_eq!(qbittorrent_bound_interface(&preferences), "ProtonVPN");

        let legacy_preferences = serde_json::json!({
            "current_interface_name": "",
            "current_network_interface": "ProtonVPN"
        });
        assert_eq!(
            qbittorrent_bound_interface(&legacy_preferences),
            "ProtonVPN"
        );
    }

    #[test]
    fn qbittorrent_stale_vpn_adapter_id_is_rebound() {
        let interfaces = vec![
            serde_json::json!({ "name": "ProtonVPN", "value": "iftype53_32769" }),
            serde_json::json!({ "name": "Tailscale", "value": "iftype53_32768" }),
        ];
        let stale = serde_json::json!({
            "current_interface_name": "ProtonVPN",
            "current_network_interface": "iftype53_32771"
        });
        assert_eq!(
            stale_vpn_interface_replacement(&stale, &interfaces, "ProtonVPN").as_deref(),
            Some("iftype53_32769")
        );

        let current = serde_json::json!({
            "current_interface_name": "ProtonVPN",
            "current_network_interface": "iftype53_32769"
        });
        assert_eq!(stale_vpn_interface_replacement(&current, &interfaces, "ProtonVPN"), None);

        // Never silently move a binding the user pointed at another adapter.
        let other = serde_json::json!({
            "current_interface_name": "Tailscale",
            "current_network_interface": "iftype53_1"
        });
        assert_eq!(stale_vpn_interface_replacement(&other, &interfaces, "ProtonVPN"), None);

        // A missing VPN adapter is a disconnected VPN, not a stale binding.
        assert_eq!(stale_vpn_interface_replacement(&stale, &interfaces[1..], "ProtonVPN"), None);
    }

    #[test]
    fn qbit_zero_progress_recovery_ignores_ordinary_stalls() {
        let active_zero = QbittorrentTorrent {
            hash: String::new(),
            name: String::new(),
            state: "downloading".to_owned(),
            progress: 0.0,
            dlspeed: 0,
            dl_limit: 0,
            upspeed: 0,
            eta: 0,
            completed: 0,
            size: 0,
            amount_left: 0,
            num_seeds: 0,
            num_leechs: 0,
            added_on: 0,
            save_path: String::new(),
            content_path: String::new(),
            category: String::new(),
        };
        assert!(is_qbit_zero_progress_failure(&active_zero));

        let metadata_zero = QbittorrentTorrent {
            state: "metaDL".to_owned(),
            ..active_zero.clone()
        };
        assert!(is_qbit_zero_progress_failure(&metadata_zero));

        let forced_metadata_zero = QbittorrentTorrent {
            state: "forcedMetaDL".to_owned(),
            ..active_zero.clone()
        };
        assert!(is_qbit_zero_progress_failure(&forced_metadata_zero));

        let no_peers = QbittorrentTorrent {
            state: "stalledDL".to_owned(),
            ..active_zero.clone()
        };
        assert!(!is_qbit_zero_progress_failure(&no_peers));

        let making_progress = QbittorrentTorrent {
            dlspeed: 1,
            ..active_zero
        };
        assert!(!is_qbit_zero_progress_failure(&making_progress));

        assert!(is_recoverable_qbittorrent_connection_failure(
            "Could not reach the qBittorrent Web UI."
        ));
        assert!(is_recoverable_qbittorrent_connection_failure(
            "The qBittorrent Web UI check timed out."
        ));
        assert!(!is_recoverable_qbittorrent_connection_failure(
            "qBittorrent rejected the Web UI login."
        ));
    }

    #[test]
    fn auto_skip_offsets_are_limited_to_ten_minutes() {
        assert!(valid_playback_preferences(&PlaybackPreferences {
            auto_skip_enabled: true,
            auto_skip_by_show: BTreeMap::new(),
            auto_next_enabled: true,
            captions_enabled: false,
            intro_seconds: 90,
            ending_seconds: 120,
            buffer_size_mb: 500,
            image_seconds: 5,
            load_all_items: false,
            caption_preferences: CaptionPreferences::default(),
        }));
        assert!(!valid_playback_preferences(&PlaybackPreferences {
            auto_skip_enabled: true,
            auto_skip_by_show: BTreeMap::new(),
            auto_next_enabled: true,
            captions_enabled: false,
            intro_seconds: 601,
            ending_seconds: 0,
            buffer_size_mb: 500,
            image_seconds: 5,
            load_all_items: false,
            caption_preferences: CaptionPreferences::default(),
        }));
        assert!(!valid_playback_preferences(&PlaybackPreferences {
            auto_skip_enabled: true,
            auto_skip_by_show: BTreeMap::new(),
            auto_next_enabled: true,
            captions_enabled: false,
            intro_seconds: 0,
            ending_seconds: 0,
            buffer_size_mb: 501,
            image_seconds: 5,
            load_all_items: false,
            caption_preferences: CaptionPreferences::default(),
        }));
        assert!(!valid_playback_preferences(&PlaybackPreferences {
            auto_skip_enabled: true,
            auto_skip_by_show: BTreeMap::new(),
            auto_next_enabled: true,
            captions_enabled: false,
            intro_seconds: 0,
            ending_seconds: 0,
            buffer_size_mb: 500,
            image_seconds: 0,
            load_all_items: false,
            caption_preferences: CaptionPreferences::default(),
        }));
    }

    fn skip_provider(name: &str, kind: &str, start: f64, end: f64) -> SkipProviderEvidence {
        SkipProviderEvidence {
            provider: name.to_owned(),
            status: "success".to_owned(),
            latency_ms: 1,
            segments: vec![SkipSegmentEvidence {
                kind: kind.to_owned(),
                start,
                end,
                provider_confidence: None,
                submission_count: None,
                label: None,
            }],
            error: None,
            raw: None,
        }
    }

    #[test]
    fn agreeing_skip_sources_are_safe_for_automatic_skipping() {
        let decisions = decide_skip_segments(
            &[
                skip_provider("theintrodb.org", "intro", 30.0, 89.0),
                skip_provider("introdb.app", "intro", 32.0, 91.0),
                skip_provider("local_chapters", "intro", 31.0, 90.0),
            ],
            2_700.0,
        );
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].agreement, 3);
        assert!(decisions[0].auto_skip_safe);
        assert!((decisions[0].start - 31.0).abs() < 0.2);
        assert!(decisions[0].confidence >= 0.95);
    }

    #[test]
    fn disagreeing_skip_sources_remain_manual_buttons() {
        let decisions = decide_skip_segments(
            &[
                skip_provider("theintrodb.org", "credits", 2_400.0, 2_700.0),
                skip_provider("introdb.app", "credits", 2_100.0, 2_700.0),
            ],
            2_700.0,
        );
        assert_eq!(decisions.len(), 2);
        assert!(decisions.iter().all(|decision| !decision.auto_skip_safe));
        assert!(decisions.iter().all(|decision| decision.agreement == 1));
    }

    #[test]
    fn chapter_labels_only_accept_explicit_skip_markers() {
        assert_eq!(chapter_segment_kind("Opening Credits"), Some("intro"));
        assert_eq!(chapter_segment_kind("Previously On"), Some("recap"));
        assert_eq!(chapter_segment_kind("End Credits"), Some("credits"));
        assert_eq!(chapter_segment_kind("Chapter 1"), None);
        assert!(valid_imdb_id("tt0903747"));
        assert!(!valid_imdb_id("0903747"));
    }

    #[test]
    fn local_fingerprint_finds_a_shifted_noisy_audio_anchor() {
        let mut target = (0..220_u32)
            .map(|value| 0x8100_0000_u32.wrapping_add(value.wrapping_mul(7919)))
            .collect::<Vec<_>>();
        let mut peer = (0..240_u32)
            .map(|value| 0x4200_0000_u32.wrapping_add(value.wrapping_mul(6151)))
            .collect::<Vec<_>>();
        for index in 0..72 {
            let point = 0x1234_0000_u32.wrapping_add(index as u32 * 37);
            target[80 + index] = point;
            peer[100 + index] = if index % 11 == 0 {
                point ^ 0b10101
            } else {
                point
            };
        }

        let found = compare_local_fingerprints(&target, &peer).unwrap();
        assert!((found.target_start - 80.0 * CHROMAPRINT_SAMPLE_DURATION).abs() < 0.01);
        assert!((found.peer_start - 100.0 * CHROMAPRINT_SAMPLE_DURATION).abs() < 0.01);
        assert!(found.target_end - found.target_start > 8.0);
    }

    #[test]
    fn local_fingerprint_expands_anchor_to_black_boundaries() {
        let parsed = parse_black_intervals(
            "black_start:334.167 black_end:336.628 black_duration:2.461\n\
             black_start:358.650 black_end:358.942 black_duration:0.292\n\
             black_start:404.195 black_end:410.827 black_duration:6.632",
        );
        let boundary = refine_intro_from_black_intervals(
            FingerprintRange {
                target_start: 339.2,
                target_end: 347.6,
                peer_start: 0.0,
                peer_end: 0.0,
            },
            &parsed,
            3_635.0,
        )
        .unwrap();
        assert!((boundary.0 - 334.167).abs() < 0.001);
        assert!((boundary.1 - 410.827).abs() < 0.001);
    }

    #[test]
    fn local_fingerprint_accepts_openings_that_start_at_zero() {
        let parsed =
            parse_black_intervals("black_start:79.400 black_end:79.850 black_duration:0.450");
        let boundary = refine_intro_from_black_intervals(
            FingerprintRange {
                target_start: 0.4,
                target_end: 79.2,
                peer_start: 0.0,
                peer_end: 0.0,
            },
            &parsed,
            1_400.0,
        )
        .unwrap();
        assert!((boundary.0 - 0.0).abs() < 0.001);
        assert!((boundary.1 - 79.850).abs() < 0.001);
    }

    #[test]
    fn local_fingerprint_falls_back_to_audio_anchor_without_black_frames() {
        let boundary = fallback_intro_from_audio_anchor(
            FingerprintRange {
                target_start: 0.2,
                target_end: 81.0,
                peer_start: 0.0,
                peer_end: 0.0,
            },
            1_400.0,
        )
        .unwrap();
        assert!((boundary.0 - 0.0).abs() < 0.001);
        assert!((boundary.1 - 81.0).abs() < 0.001);
    }

    #[test]
    fn anizip_maps_season_episode_to_absolute_episode() {
        let mapping = serde_json::json!({
            "episodes": {
                "1": { "seasonNumber": 1, "episodeNumber": 1, "absoluteEpisodeNumber": 1 },
                "27": { "seasonNumber": 2, "episodeNumber": 1, "absoluteEpisodeNumber": 27 },
                "28": { "seasonNumber": 2, "episodeNumber": 2, "absoluteEpisodeNumber": 28 }
            }
        });
        assert_eq!(absolute_episode_from_anizip(&mapping, 1, 1), Some(1));
        assert_eq!(absolute_episode_from_anizip(&mapping, 2, 1), Some(27));
        assert_eq!(absolute_episode_from_anizip(&mapping, 2, 2), Some(28));
    }

    #[test]
    fn upload_formats_match_the_library_type() {
        assert!(valid_upload_extension("mixed", "mp4"));
        assert!(valid_upload_extension("mixed", "flac"));
        assert!(valid_upload_extension("mixed", "png"));
        assert!(valid_upload_extension("movies_tv", "mkv"));
        assert!(!valid_upload_extension("movies_tv", "jpg"));
        assert!(!valid_upload_extension("mixed", "exe"));
        assert!(valid_upload_extension("files", "pdf"));
        assert!(valid_upload_extension("files", "exe"));
    }

    #[test]
    fn folder_archives_keep_nested_file_paths() {
        let base =
            std::env::temp_dir().join(format!("tms-folder-download-test-{}", uuid::Uuid::new_v4()));
        let source = base.join("Zak").join("School");
        let archive = base.join("download.zip");
        std::fs::create_dir_all(source.join("Notes")).unwrap();
        std::fs::write(source.join("assignment.pdf"), b"pdf").unwrap();
        std::fs::write(source.join("Notes").join("readme.txt"), b"notes").unwrap();

        assert_eq!(create_folder_archive(&source, &archive).unwrap(), 2);
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        assert!(zip.by_name("assignment.pdf").is_ok());
        assert!(zip.by_name("Notes/readme.txt").is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn document_only_folders_keep_their_item_count_without_a_preview() {
        let base =
            std::env::temp_dir().join(format!("tms-folder-count-test-{}", uuid::Uuid::new_v4()));
        let folder = base.join("School");
        std::fs::create_dir_all(folder.join("Notes")).unwrap();
        std::fs::write(folder.join("assignment.pdf"), b"pdf").unwrap();
        std::fs::write(folder.join("Notes").join("readme.txt"), b"notes").unwrap();

        let entry = scan_folder(&base, &base, &BTreeMap::new())
            .into_iter()
            .find(|entry| entry.name == "School")
            .unwrap();
        assert_eq!(entry.item_count, Some(2));
        assert_eq!(entry.preview_path, None);
        assert_eq!(entry.preview_kind, None);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn movies_tv_uploads_are_grouped_into_shows_and_seasons() {
        assert!(upload_should_organize_movie_tv(
            "movies_tv",
            "Episode.S01E01.mkv"
        ));
        assert!(upload_should_organize_movie_tv(
            "movies_tv",
            "Show/Season 01/Episode.S01E01.mkv"
        ));
        assert!(!upload_should_organize_movie_tv(
            "mixed",
            "Episode.S01E01.mkv"
        ));
    }

    #[test]
    fn movie_title_inference_stops_at_year_and_release_markers() {
        assert_eq!(
            inferred_movie_title(Path::new(r"C:\media\Blade.Runner.2049.2017.1080p")),
            Some(("Blade Runner 2049".to_owned(), Some("2017".to_owned())))
        );
        assert_eq!(
            inferred_movie_title(Path::new(r"C:\media\Arrival WEB-DL 1080p")),
            Some(("Arrival".to_owned(), None))
        );
    }

    #[test]
    fn catalog_title_normalization_matches_release_punctuation() {
        assert_eq!(
            normalize_catalog_title("Spider-Man.Across.The.Spider-Verse"),
            normalize_catalog_title("Spider-Man: Across the Spider-Verse")
        );
        assert_eq!(
            normalize_catalog_title("Dungeons.and.Dragons.Honor.Among.Thieves."),
            normalize_catalog_title("Dungeons & Dragons: Honor Among Thieves")
        );
    }

    #[test]
    fn hunter_caption_validation_rejects_another_episodes_title_card() {
        let episode_one = "WEBVTT\n\n00:01:20.000 --> 00:01:23.000\nDeparture x And x Friends";
        let episode_ninety_one =
            "WEBVTT\n\n00:01:20.000 --> 00:01:23.000\nIkalgo x And x Lightning";
        assert!(hunter_x_hunter_title_matches_caption(
            episode_one,
            "Departure x And x Friends"
        ));
        assert!(!hunter_x_hunter_title_matches_caption(
            episode_ninety_one,
            "Departure x And x Friends"
        ));
    }

    #[test]
    fn exact_movie_title_prefers_matching_filename_year() {
        let requested = normalize_catalog_title("Dune");
        assert!(
            catalog_title_match_score(&requested, "dune", Some("2021"), "2021")
                > catalog_title_match_score(&requested, "dune", Some("2021"), "1984")
        );
    }

    #[test]
    fn catalog_matching_rejects_unrelated_search_results() {
        assert_eq!(
            catalog_title_match_score(
                "the apothecary diaries",
                "ahead of time the extraordinary journey of ruth gruber",
                None,
                "2009",
            ),
            0
        );
        assert_eq!(catalog_title_match_score("", "ahead of time", None, ""), 0);
        assert_eq!(catalog_title_match_score("it", "item", None, ""), 0);
        assert!(catalog_title_match_score(
            "the apothecary diaries", "the apothecary diaries", None, ""
        ) > 0);
    }

    #[test]
    fn multi_season_series_evidence_prefers_the_matching_year_remake() {
        let requested = normalize_catalog_title("Avatar: The Last Airbender");
        assert!(
            catalog_title_match_score(
                &requested,
                "avatar the last airbender",
                Some("2005"),
                "2005-2008"
            ) > catalog_title_match_score(
                &requested,
                "avatar the last airbender",
                Some("2005"),
                "2024-"
            )
        );
    }

    #[test]
    fn episode_release_names_are_cleaned_into_a_show_and_numbers() {
        assert_eq!(
            episode_name_from_release(
                "House.of.the.Dragon.S03E05.1080p.HEVC.x265-MeGusta[EZTVx.to].mkv"
            ),
            Some(EpisodeName {
                title: "House of the Dragon".to_owned(),
                season: 3,
                episode: 5,
            })
        );
        assert_eq!(episode_name_from_release("A movie 1080p.mkv"), None);
    }

    #[test]
    fn locked_completed_media_is_retried() {
        assert!(OrganizeError::media_move(std::io::Error::from_raw_os_error(32)).retryable);
        assert!(
            !OrganizeError::media_move(std::io::Error::from(std::io::ErrorKind::NotFound))
                .retryable
        );
    }

    #[test]
    fn rename_retries_only_temporary_windows_handle_errors() {
        assert!(is_transient_rename_error(
            &std::io::Error::from_raw_os_error(32)
        ));
        assert!(is_transient_rename_error(
            &std::io::Error::from_raw_os_error(33)
        ));
        assert!(!is_transient_rename_error(&std::io::Error::from(
            std::io::ErrorKind::NotFound
        )));
    }

    #[test]
    fn transcode_bitrates_are_monotonic() {
        assert!(bitrate_for_height(1080) > bitrate_for_height(720));
        assert!(bitrate_for_height(720) > bitrate_for_height(480));
        assert!(bitrate_for_height(480) > bitrate_for_height(360));
    }

    #[test]
    fn english_audio_wins_over_japanese_default() {
        let tracks = vec![
            AudioTrack { stream_index: 1, label: "Japanese".into(), language: "jpn".into(), is_default: true },
            AudioTrack { stream_index: 2, label: "English".into(), language: "eng".into(), is_default: false },
        ];
        assert_eq!(default_audio_stream(&tracks), Some(2));
        let (english, _) = transcode_key_and_url("episode.mkv", 1080, 0, Some(2), None);
        let (japanese, _) = transcode_key_and_url("episode.mkv", 1080, 0, Some(1), None);
        assert_ne!(english, japanese);
    }

    #[test]
    fn continuous_transcode_cache_is_anchored_to_the_seek_position() {
        let (beginning, _) = transcode_key_and_url("Shows/Episode.mkv", 1080, 0, Some(1), None);
        let (seeked, _) = transcode_key_and_url("Shows/Episode.mkv", 1080, 600, Some(1), None);
        assert_ne!(beginning, seeked);
    }

    #[test]
    fn hls_startup_buffer_uses_actual_segment_durations() {
        let playlist =
            "#EXTM3U\n#EXTINF:10.427089,\nsegment_00000.ts\n#EXTINF:10.427078,\nsegment_00001.ts\n";
        assert_eq!(
            playlist_segments_with_durations(playlist),
            vec![
                ("segment_00000.ts", 10.427089),
                ("segment_00001.ts", 10.427078)
            ]
        );
    }

    #[test]
    fn subtitle_conversion_normalizes_srt_timestamps() {
        let response = subtitle_response("1\r\n00:00:01,500 --> 00:00:02,000\r\nHello", "no-cache");
        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response.headers().get("content-type").unwrap();
        assert_eq!(content_type, "text/vtt; charset=utf-8");
    }

    #[test]
    fn admin_user_response_never_exposes_password_hash() {
        let stored = StoredUser {
            id: 1,
            name: "Tariq".to_owned(),
            password_hash: Some("$2b$12$private".to_owned()),
            created_at: 42,
            is_admin: true,
            admin_permissions: AdminPermissions::default(),
            password_version: 3,
            avatar: None,
            storage_quota_bytes: Some(DEFAULT_STORAGE_QUOTA_BYTES),
        };
        let response = AdminUser::from_user(&stored, &StorageLedger::default(), None);
        let json = serde_json::to_value(response).unwrap();

        assert_eq!(json["name"], "Tariq");
        assert_eq!(json["password_set"], true);
        assert!(json.get("password_hash").is_none());
    }

    #[test]
    fn legacy_users_default_to_no_granular_admin_permissions() {
        let user: StoredUser = serde_json::from_value(serde_json::json!({
            "id": 2,
            "name": "Legacy member",
            "password_hash": null,
            "created_at": 1,
            "is_admin": false
        }))
        .unwrap();

        assert_eq!(user.admin_permissions, AdminPermissions::default());
        assert!(!has_admin_capability(&user, |permissions| permissions.view_logs));
    }

    #[test]
    fn full_admin_override_and_panel_gate_are_enforced() {
        let mut user = StoredUser {
            id: 3,
            name: "Scoped admin".to_owned(),
            password_hash: None,
            created_at: 1,
            is_admin: false,
            admin_permissions: AdminPermissions {
                view_logs: true,
                ..AdminPermissions::default()
            },
            password_version: 0,
            avatar: None,
            storage_quota_bytes: Some(DEFAULT_STORAGE_QUOTA_BYTES),
        };
        assert!(!has_admin_capability(&user, |permissions| permissions.view_logs));

        user.admin_permissions.access_admin_panel = true;
        assert!(has_admin_capability(&user, |permissions| permissions.view_logs));
        assert!(!has_admin_capability(&user, |permissions| permissions.delete_users));

        user.is_admin = true;
        assert!(has_admin_capability(&user, |permissions| permissions.delete_users));
        assert_eq!(effective_admin_permissions(&user), AdminPermissions::full());
    }

    #[test]
    fn storage_reservations_never_overcommit_a_user_quota() {
        let user = StoredUser {
            id: 7,
            name: "Quota user".to_owned(),
            password_hash: None,
            created_at: 1,
            is_admin: false,
            admin_permissions: AdminPermissions::default(),
            password_version: 0,
            avatar: None,
            storage_quota_bytes: Some(100),
        };
        let mut ledger = StorageLedger::default();
        assert!(reserve_storage(&mut ledger, &user, "first", "upload", 60));
        assert!(!reserve_storage(&mut ledger, &user, "second", "yt-dlp", 41));
        assert!(reserve_storage(&mut ledger, &user, "second", "yt-dlp", 40));
        assert_eq!(storage_usage(&ledger, user.id), (0, 100));
    }

    #[test]
    fn permanently_deleting_a_users_download_releases_its_usage() {
        let user = StoredUser {
            id: 10,
            name: "Download owner".to_owned(),
            password_hash: None,
            created_at: 1,
            is_admin: false,
            admin_permissions: AdminPermissions::default(),
            password_version: 0,
            avatar: None,
            storage_quota_bytes: Some(100),
        };
        let mut ledger = StorageLedger {
            allocations: vec![StorageAllocation {
                id: "download-file".to_owned(),
                user_id: user.id,
                source: "yt-dlp".to_owned(),
                path: "Mixed/clip.mkv".to_owned(),
                bytes: 60,
                created_at: 1,
                trash_id: Some("trash-download".to_owned()),
                job_id: Some("job-1".to_owned()),
            }],
            reservations: Vec::new(),
        };

        assert_eq!(
            storage_quota_response(&user, &ledger).available_bytes,
            Some(40)
        );
        release_storage_from_trash(&mut ledger, "trash-download");
        assert_eq!(
            storage_quota_response(&user, &ledger).available_bytes,
            Some(100)
        );
    }

    #[test]
    fn unlimited_storage_accepts_reservations() {
        let user = StoredUser {
            id: 8,
            name: "Unlimited user".to_owned(),
            password_hash: None,
            created_at: 1,
            is_admin: false,
            admin_permissions: AdminPermissions::default(),
            password_version: 0,
            avatar: None,
            storage_quota_bytes: None,
        };
        let mut ledger = StorageLedger::default();
        assert!(reserve_storage(
            &mut ledger,
            &user,
            "large",
            "magnet",
            u64::MAX
        ));
        assert!(storage_quota_response(&user, &ledger).unlimited);
    }

    #[test]
    fn administrators_bypass_legacy_storage_quotas() {
        let admin = StoredUser {
            id: 9,
            name: "Admin".to_owned(),
            password_hash: None,
            created_at: 1,
            is_admin: true,
            admin_permissions: AdminPermissions::default(),
            password_version: 0,
            avatar: None,
            // Simulates an administrator created before admins became unlimited.
            storage_quota_bytes: Some(100),
        };
        let mut ledger = StorageLedger::default();
        assert!(reserve_storage(&mut ledger, &admin, "large", "yt-dlp", 101));
        let quota = storage_quota_response(&admin, &ledger);
        assert_eq!(quota.storage_quota_bytes, None);
        assert_eq!(quota.available_bytes, None);
        assert!(quota.unlimited);
    }

    #[test]
    fn admin_quota_update_distinguishes_unlimited_from_omitted() {
        let unlimited: UpdateUserRequest =
            serde_json::from_str(r#"{"storage_quota_bytes":null}"#).unwrap();
        let omitted: UpdateUserRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(unlimited.storage_quota_bytes, Some(None));
        assert_eq!(omitted.storage_quota_bytes, None);
    }

    #[test]
    fn clean_ytdlp_download_stem_removes_index_prefix_and_video_id_suffix() {
        assert_eq!(
            clean_ytdlp_download_stem("0001 - mars [aX_PVL_Kg4c]"),
            "mars"
        );
        assert_eq!(
            clean_ytdlp_download_stem("0002 - Rain Sounds - Ten Hours [bdFco257lJY]"),
            "Rain Sounds - Ten Hours"
        );
        assert_eq!(clean_ytdlp_download_stem("title []"), "title");
    }

    #[test]
    fn clean_ytdlp_download_stem_keeps_legitimate_brackets() {
        assert_eq!(clean_ytdlp_download_stem("Song [Live]"), "Song [Live]");
    }

    #[test]
    fn cleaned_ytdlp_file_name_returns_none_when_already_clean() {
        assert_eq!(cleaned_ytdlp_file_name("mars.mkv"), None);
    }

    #[test]
    fn po_token_warning_is_not_treated_as_http_403() {
        let warning = "WARNING: [youtube] aX_PVL_Kg4c: mweb client https formats require a GVS PO Token which was not provided. They will be skipped as they may yield HTTP Error 403.";
        assert!(!is_ytdlp_403_or_forbidden(warning));
        assert!(!is_ytdlp_auth_or_cookie_error(warning));
        assert_eq!(
            extract_ytdlp_youtube_ids(warning),
            vec!["aX_PVL_Kg4c".to_owned()]
        );
    }

    #[test]
    fn real_http_403_error_still_triggers_stop() {
        let stderr = "ERROR: unable to download video data: HTTP Error 403: Forbidden";
        assert!(is_ytdlp_403_or_forbidden(stderr));
        assert!(is_ytdlp_auth_or_cookie_error(stderr));
    }

    #[test]
    fn sanitize_prefers_real_errors_over_po_token_warnings() {
        let stderr = "WARNING: [youtube] aX_PVL_Kg4c: mweb client https formats require a GVS PO Token which was not provided. They will be skipped as they may yield HTTP Error 403.\nERROR: [youtube] aX_PVL_Kg4c: Private video";
        assert_eq!(
            sanitize_ytdlp_error(stderr),
            "ERROR: [youtube] aX_PVL_Kg4c: Private video"
        );
    }
}

fn spawn_background_indexer(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        loop {
            let start = Instant::now();
            let libraries = read_libraries(&state).await;
            let generation = state
                .library_cache_generation
                .load(std::sync::atomic::Ordering::SeqCst);
            let root = state.library_root.clone();
            let scanned = tokio::task::spawn_blocking(move || {
                let mut new_cache = HashMap::new();
                if root.is_dir() {
                    let root_entries = scan_library(&root, &libraries);

                    let mut folders_to_scan = BTreeSet::new();
                    for entry in &root_entries {
                        if entry.kind == "folder" {
                            folders_to_scan.insert(entry.path.clone());
                        }
                        let path = Path::new(&entry.path);
                        let mut current = path.parent();
                        while let Some(parent) = current {
                            if !parent.as_os_str().is_empty() {
                                folders_to_scan.insert(parent.to_string_lossy().replace('\\', "/"));
                            }
                            current = parent.parent();
                        }
                    }

                    new_cache.insert(None, root_entries);

                    for folder_rel_path in folders_to_scan {
                        if let Ok(folder_path) = safe_library_path(&root, &folder_rel_path) {
                            if folder_path.is_dir() {
                                let folder_entries = scan_folder(&root, &folder_path, &libraries);
                                new_cache.insert(Some(folder_rel_path), folder_entries);
                            }
                        }
                    }
                }

                new_cache
            })
            .await;
            if let Ok(new_cache) = scanned {
                let mut cache = state.library_cache.write().await;
                if generation
                    == state
                        .library_cache_generation
                        .load(std::sync::atomic::Ordering::SeqCst)
                {
                    *cache = new_cache;
                }
            }

            let elapsed = start.elapsed();
            tracing::debug!("Background indexer completed in {}ms", elapsed.as_millis());
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
