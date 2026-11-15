//! Watch Together rooms.
//!
//! Rooms are public, short-lived and kept in memory only. Every member holds a
//! WebSocket to this server; the server orders playback commands, stamps them
//! with its own clock and broadcasts the resulting room state. Clients project
//! the shared position forward from that timestamp and correct their own
//! drift, so personal settings (quality, captions, audio track, volume) never
//! leave the device.
//!
//! Rooms never widen library access. Every member (and every caller of the
//! room list) receives a view of the room filtered by their own permissions:
//! media from a library they cannot open is replaced by `media_hidden`, with
//! no name, path, URL or position, and other members' paths are dropped the
//! same way. Sharing media requires access to it, and each member's session
//! and permissions are re-checked while connected.
//!
//! Everything noteworthy is logged under the `tms_server::watch_rooms` target
//! (room lifecycle, every command with its sequence number, member drift
//! reports and client-side diagnostics) so sync problems can be traced from
//! the server log alone.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    Json,
    extract::{
        ConnectInfo, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::{AppState, LibraryConfig, StoredUser};
use std::collections::BTreeMap;

const LOG_TARGET: &str = "tms_server::watch_rooms";
/// An empty room survives briefly so a refresh or a dropped connection can
/// rejoin it without losing what was playing.
const EMPTY_ROOM_GRACE: Duration = Duration::from_secs(90);
/// Clients ping every few seconds; a silent socket is treated as gone.
const SOCKET_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ROOMS: usize = 50;
const MAX_MEMBERS: usize = 32;
const DRIFT_LOG_THRESHOLD_SECONDS: f64 = 3.0;
const DRIFT_LOG_INTERVAL: Duration = Duration::from_secs(15);
const MEDIA_DUPLICATE_WINDOW: Duration = Duration::from_secs(6);
/// How often a connected member's session and library access are re-read.
const ACCESS_RECHECK_INTERVAL: Duration = Duration::from_secs(20);

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoomSettings {
    #[serde(default)]
    pub auto_skip: bool,
    #[serde(default = "default_true")]
    pub auto_next: bool,
    #[serde(default = "default_image_seconds")]
    pub image_seconds: f64,
    #[serde(default)]
    pub loop_enabled: bool,
}

fn default_true() -> bool {
    true
}

fn default_image_seconds() -> f64 {
    5.0
}

impl Default for RoomSettings {
    fn default() -> Self {
        Self { auto_skip: false, auto_next: true, image_seconds: 5.0, loop_enabled: false }
    }
}

impl RoomSettings {
    fn sanitized(mut self) -> Self {
        if !self.image_seconds.is_finite() || self.image_seconds < 1.0 {
            self.image_seconds = 5.0;
        }
        self.image_seconds = self.image_seconds.min(3600.0);
        self
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RoomSettingsPatch {
    pub auto_skip: Option<bool>,
    pub auto_next: Option<bool>,
    pub image_seconds: Option<f64>,
    pub loop_enabled: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoomMedia {
    pub path: String,
    pub name: String,
    pub kind: String,
    /// The `/watch?...` query that opens this media, without per-viewer
    /// fields (resume position, play attempt ids, return URL).
    pub url: String,
}

impl RoomMedia {
    fn valid(&self) -> bool {
        !self.path.is_empty()
            && self.path.len() <= 4096
            && self.url.len() <= 16 * 1024
            && self.name.len() <= 1024
            && self.url.starts_with("/watch?")
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct RoomPlayback {
    pub playing: bool,
    /// Media position, in seconds, at server time `at`.
    pub position: f64,
    pub rate: f64,
    /// Server clock (Unix milliseconds) when `position` was true.
    pub at: f64,
}

impl RoomPlayback {
    fn position_at(&self, time_ms: f64) -> f64 {
        if !self.playing {
            return self.position;
        }
        self.position + ((time_ms - self.at).max(0.0) / 1000.0) * self.rate
    }
}

/// Whose permissions a room view is filtered by.
#[derive(Clone)]
pub struct Viewer {
    user: StoredUser,
    libraries: Arc<BTreeMap<String, LibraryConfig>>,
}

impl Viewer {
    pub async fn load(state: &AppState, user: StoredUser) -> Self {
        // Admins can open every library, so the configuration is not needed.
        let libraries = if user.is_admin { BTreeMap::new() } else { crate::read_libraries(state).await };
        Self { user, libraries: Arc::new(libraries) }
    }

    fn can_view(&self, path: &str) -> bool {
        !path.is_empty() && !crate::escapes_root(path) && crate::can_view_library_path(&self.user, &self.libraries, path)
    }
}

/// The share URL must open exactly the media it names, so a member cannot
/// pair a permitted path with a URL for something else.
fn media_is_consistent(media: &RoomMedia) -> bool {
    let Some(query) = media.url.strip_prefix("/watch?") else { return false };
    let mut src_matches = false;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let Ok(value) = urlencoding::decode(&value.replace('+', " ")).map(|value| value.into_owned()) else { return false };
        match key {
            "src" => {
                let Some(encoded) = value.strip_prefix("/media/") else { return false };
                let decoded: Result<Vec<String>, _> = encoded.split('/').map(|segment| urlencoding::decode(segment).map(|part| part.into_owned())).collect();
                match decoded {
                    Ok(parts) if parts.join("/") == media.path => src_matches = true,
                    _ => return false,
                }
            }
            "path" if value != media.path => return false,
            "offlineBundle" | "offlineFile" => return false,
            _ => {}
        }
    }
    src_matches
}

#[derive(Clone, Debug, Serialize)]
pub struct RoomAction {
    pub seq: u64,
    pub action: String,
    pub by: String,
    pub by_connection: u64,
    pub at: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RoomMember {
    pub connection: u64,
    pub user_id: u64,
    pub name: String,
    pub device: String,
    pub joined_at: f64,
    /// Last reported media position and whether the member is waiting on
    /// data. Shown to the room and used for drift diagnostics.
    pub position: Option<f64>,
    pub buffering: bool,
    pub media_path: Option<String>,
    pub reported_at: f64,
}

struct MemberSlot {
    member: RoomMember,
    sender: mpsc::UnboundedSender<String>,
    last_drift_log: Option<Instant>,
    viewer: Viewer,
    /// The media generation last reported as hidden for this member, so the
    /// log records each denial once instead of on every update.
    hidden_media_seq: Option<u64>,
}

struct Room {
    id: String,
    name: String,
    created_by: String,
    created_at: f64,
    media: Option<RoomMedia>,
    media_seq: u64,
    media_changed_at: Option<Instant>,
    playback: RoomPlayback,
    settings: RoomSettings,
    seq: u64,
    last_action: Option<RoomAction>,
    members: HashMap<u64, MemberSlot>,
    empty_since: Option<Instant>,
}

#[derive(Serialize)]
pub struct RoomSnapshot {
    id: String,
    name: String,
    created_by: String,
    created_at: f64,
    media: Option<RoomMedia>,
    /// The room is playing something this viewer has no access to. Nothing
    /// else about that media is included.
    media_hidden: bool,
    media_seq: u64,
    playback: RoomPlayback,
    settings: RoomSettings,
    seq: u64,
    last_action: Option<RoomAction>,
    members: Vec<RoomMember>,
}

impl Room {
    fn members_for(&self, viewer: &Viewer) -> Vec<RoomMember> {
        let mut members: Vec<RoomMember> = self
            .members
            .values()
            .map(|slot| {
                let mut member = slot.member.clone();
                if member.media_path.as_deref().is_some_and(|path| !viewer.can_view(path)) {
                    member.media_path = None;
                    member.position = None;
                }
                member
            })
            .collect();
        members.sort_by(|a, b| a.joined_at.total_cmp(&b.joined_at));
        members
    }

    /// The room as `viewer` may see it.
    fn snapshot_for(&self, viewer: &Viewer) -> RoomSnapshot {
        let visible = self.media.as_ref().is_none_or(|media| viewer.can_view(&media.path));
        RoomSnapshot {
            id: self.id.clone(),
            name: self.name.clone(),
            created_by: self.created_by.clone(),
            created_at: self.created_at,
            media: if visible { self.media.clone() } else { None },
            media_hidden: !visible,
            media_seq: self.media_seq,
            playback: if visible {
                self.playback.clone()
            } else {
                RoomPlayback { playing: false, position: 0.0, rate: self.playback.rate, at: self.playback.at }
            },
            settings: self.settings.clone(),
            seq: self.seq,
            last_action: self.last_action.clone(),
            members: self.members_for(viewer),
        }
    }

    fn broadcast_state(&mut self) {
        let server_time = now_ms();
        let room_id = self.id.clone();
        let media_seq = self.media_seq;
        let media_path = self.media.as_ref().map(|media| media.path.clone());
        let snapshots: Vec<(u64, String)> = self
            .members
            .iter()
            .map(|(connection, slot)| {
                let message = serde_json::json!({ "type": "state", "room": self.snapshot_for(&slot.viewer), "server_time": server_time }).to_string();
                (*connection, message)
            })
            .collect();
        for (connection, message) in snapshots {
            let Some(slot) = self.members.get_mut(&connection) else { continue };
            if let Some(path) = media_path.as_deref()
                && !slot.viewer.can_view(path)
                && slot.hidden_media_seq != Some(media_seq)
            {
                slot.hidden_media_seq = Some(media_seq);
                tracing::info!(
                    target: LOG_TARGET,
                    event = "media_hidden",
                    room = %room_id,
                    connection,
                    user = %slot.member.name,
                    media = path,
                    media_seq,
                    "Room media hidden from a member without access"
                );
            }
            let _ = slot.sender.send(message);
        }
    }

    fn broadcast_members(&self) {
        let server_time = now_ms();
        for slot in self.members.values() {
            let message = serde_json::json!({ "type": "members", "members": self.members_for(&slot.viewer), "server_time": server_time }).to_string();
            let _ = slot.sender.send(message);
        }
    }
}

#[derive(Default)]
struct Registry {
    rooms: HashMap<String, Room>,
    next_connection: u64,
}

#[derive(Default)]
pub struct WatchRooms {
    inner: Mutex<Registry>,
}

pub type SharedWatchRooms = Arc<WatchRooms>;

impl WatchRooms {
    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        // A panic while holding the lock leaves only in-memory room state,
        // which is still consistent enough to keep serving.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn spawn_room_sweeper(rooms: SharedWatchRooms) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            let mut registry = rooms.lock();
            let expired: Vec<String> = registry
                .rooms
                .values()
                .filter(|room| room.members.is_empty() && room.empty_since.is_some_and(|since| since.elapsed() >= EMPTY_ROOM_GRACE))
                .map(|room| room.id.clone())
                .collect();
            for id in expired {
                if let Some(room) = registry.rooms.remove(&id) {
                    tracing::info!(
                        target: LOG_TARGET,
                        event = "room_closed",
                        room = %room.id,
                        name = %room.name,
                        lifetime_seconds = ((now_ms() - room.created_at) / 1000.0).round(),
                        "Watch room closed after staying empty"
                    );
                }
            }
        }
    });
}

#[derive(Deserialize)]
pub struct CreateRoomRequest {
    name: Option<String>,
    #[serde(default)]
    settings: Option<RoomSettings>,
    media: Option<RoomMedia>,
    position: Option<f64>,
    playing: Option<bool>,
    rate: Option<f64>,
}

fn clean_name(name: Option<&str>, fallback: &str) -> String {
    let trimmed: String = name.unwrap_or("").trim().chars().filter(|c| !c.is_control()).take(60).collect();
    if trimmed.is_empty() { fallback.to_owned() } else { trimmed }
}

fn clamp_rate(rate: f64) -> f64 {
    if rate.is_finite() { rate.clamp(0.25, 16.0) } else { 1.0 }
}

fn clamp_position(position: f64) -> f64 {
    if position.is_finite() { position.max(0.0) } else { 0.0 }
}

async fn require_user(state: &AppState, headers: &HeaderMap) -> Result<StoredUser, Response> {
    crate::authenticated_user(state, headers)
        .await
        .ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())
}

pub async fn list_rooms(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let viewer = Viewer::load(&state, user).await;
    let registry = state.watch_rooms.lock();
    let mut rooms: Vec<RoomSnapshot> = registry.rooms.values().map(|room| room.snapshot_for(&viewer)).collect();
    rooms.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
    Json(serde_json::json!({ "rooms": rooms, "server_time": now_ms() })).into_response()
}

pub async fn create_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateRoomRequest>,
) -> Response {
    let user = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let viewer = Viewer::load(&state, user.clone()).await;
    if let Some(media) = request.media.as_ref()
        && !(media.valid() && media_is_consistent(media) && viewer.can_view(&media.path))
    {
        tracing::warn!(target: LOG_TARGET, event = "room_create_rejected", reason = "media_not_shareable", user = %user.name, media = %media.path, "Watch room media refused");
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "message": "You can't share that in a room." }))).into_response();
    }
    let mut registry = state.watch_rooms.lock();
    if registry.rooms.len() >= MAX_ROOMS {
        tracing::warn!(target: LOG_TARGET, event = "room_create_rejected", user = %user.name, rooms = registry.rooms.len(), "Too many watch rooms are open");
        return (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({ "message": "Too many rooms are open. Join one instead." }))).into_response();
    }
    let media = request.media.filter(RoomMedia::valid);
    let now = now_ms();
    let id = uuid::Uuid::new_v4().simple().to_string()[..10].to_owned();
    let room = Room {
        id: id.clone(),
        name: clean_name(request.name.as_deref(), &format!("{}'s room", user.name)),
        created_by: user.name.clone(),
        created_at: now,
        media_seq: u64::from(media.is_some()),
        media_changed_at: media.as_ref().map(|_| Instant::now()),
        playback: RoomPlayback {
            playing: media.is_some() && request.playing.unwrap_or(false),
            position: clamp_position(request.position.unwrap_or(0.0)),
            rate: clamp_rate(request.rate.unwrap_or(1.0)),
            at: now,
        },
        media,
        settings: request.settings.unwrap_or_default().sanitized(),
        seq: 1,
        last_action: Some(RoomAction { seq: 1, action: "create".into(), by: user.name.clone(), by_connection: 0, at: now }),
        members: HashMap::new(),
        // A room nobody connects to is cleaned up like an abandoned one.
        empty_since: Some(Instant::now()),
    };
    tracing::info!(
        target: LOG_TARGET,
        event = "room_created",
        room = %room.id,
        name = %room.name,
        user = %user.name,
        media = room.media.as_ref().map(|media| media.path.as_str()).unwrap_or(""),
        position = room.playback.position,
        playing = room.playback.playing,
        settings = ?room.settings,
        "Watch room created"
    );
    let snapshot = room.snapshot_for(&viewer);
    registry.rooms.insert(id, room);
    Json(serde_json::json!({ "room": snapshot, "server_time": now })).into_response()
}

#[derive(Deserialize)]
pub struct SocketQuery {
    room: String,
    token: Option<String>,
    device: Option<String>,
}

pub async fn room_socket(
    State(state): State<AppState>,
    ConnectInfo(remote): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<SocketQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    // Browsers cannot attach an Authorization header to a WebSocket, so the
    // session token comes from the query (never logged) or the file cookie.
    let token = query
        .token
        .clone()
        .filter(|token| !token.is_empty())
        .or_else(|| crate::session_cookie(&headers).map(str::to_owned));
    let user = match token.as_deref() {
        Some(token) => crate::user_for_token(&state, token).await,
        None => None,
    };
    let (Some(user), Some(token)) = (user, token) else {
        tracing::warn!(target: LOG_TARGET, event = "socket_rejected", reason = "unauthenticated", room = %query.room, remote = %remote, "Watch room connection rejected");
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !state.watch_rooms.lock().rooms.contains_key(&query.room) {
        tracing::info!(target: LOG_TARGET, event = "socket_rejected", reason = "room_not_found", room = %query.room, user = %user.name, "Watch room connection rejected");
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "message": "That room has closed." }))).into_response();
    }
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let device = clean_name(query.device.as_deref(), "Device");
    let room_id = query.room.clone();
    upgrade
        .on_failed_upgrade(|error| {
            tracing::warn!(target: LOG_TARGET, event = "socket_upgrade_failed", %error, "Watch room WebSocket upgrade failed");
        })
        .on_upgrade(move |socket| run_member(state, socket, user, token, room_id, device, remote.to_string(), forwarded))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Ping {
        id: Option<u64>,
        t: Option<f64>,
    },
    Command {
        action: String,
        playing: Option<bool>,
        position: Option<f64>,
        rate: Option<f64>,
        /// Client's estimate of the server time when `position` was sampled.
        at: Option<f64>,
        media: Option<RoomMedia>,
        settings: Option<RoomSettingsPatch>,
        reason: Option<String>,
    },
    Report {
        position: Option<f64>,
        buffering: Option<bool>,
        playing: Option<bool>,
        media_path: Option<String>,
        at: Option<f64>,
    },
    Rename {
        name: String,
    },
    Diag {
        event: String,
        #[serde(default)]
        detail: Value,
    },
    Leave,
}

#[allow(clippy::too_many_arguments)]
async fn run_member(
    state: AppState,
    mut socket: WebSocket,
    user: StoredUser,
    token: String,
    room_id: String,
    device: String,
    remote: String,
    forwarded: Option<String>,
) {
    let (sender, mut outgoing) = mpsc::unbounded_channel::<String>();
    let connected_at = Instant::now();
    let viewer = Viewer::load(&state, user.clone()).await;
    let joined: Result<u64, &'static str> = (|| {
        let mut registry = state.watch_rooms.lock();
        registry.next_connection += 1;
        let connection = registry.next_connection;
        let Some(room) = registry.rooms.get_mut(&room_id) else { return Err("Room closed") };
        if room.members.len() >= MAX_MEMBERS {
            return Err("Room is full");
        }
        let now = now_ms();
        room.members.insert(connection, MemberSlot {
            member: RoomMember {
                connection,
                user_id: user.id,
                name: user.name.clone(),
                device: device.clone(),
                joined_at: now,
                position: None,
                buffering: false,
                media_path: None,
                reported_at: now,
            },
            sender: sender.clone(),
            last_drift_log: None,
            viewer: viewer.clone(),
            hidden_media_seq: None,
        });
        room.empty_since = None;
        tracing::info!(
            target: LOG_TARGET,
            event = "member_joined",
            room = %room.id,
            connection,
            user = %user.name,
            device = %device,
            remote = %remote,
            forwarded = forwarded.as_deref().unwrap_or(""),
            members = room.members.len(),
            media = room.media.as_ref().map(|media| media.path.as_str()).unwrap_or(""),
            position = room.playback.position_at(now),
            playing = room.playback.playing,
            "Joined watch room"
        );
        let welcome = serde_json::json!({
            "type": "welcome",
            "connection": connection,
            "room": room.snapshot_for(&viewer),
            "server_time": now,
        })
        .to_string();
        let _ = sender.send(welcome);
        room.broadcast_state();
        Ok(connection)
    })();
    let connection = match joined {
        Ok(connection) => connection,
        Err(reason) => {
            tracing::info!(target: LOG_TARGET, event = "join_refused", room = %room_id, user = %user.name, reason, "Watch room join refused");
            let _ = socket
                .send(Message::Text(serde_json::json!({ "type": "closed", "reason": reason }).to_string().into()))
                .await;
            return;
        }
    };

    let mut close_reason = "client closed";
    let mut access_check = tokio::time::interval(ACCESS_RECHECK_INTERVAL);
    access_check.tick().await;
    loop {
        tokio::select! {
            _ = access_check.tick() => {
                // Signing out or losing library access applies to an open
                // room straight away, not only on the next join.
                let Some(current) = crate::user_for_token(&state, &token).await else {
                    close_reason = "session ended";
                    let _ = socket.send(Message::Text(serde_json::json!({ "type": "closed", "reason": "Your session ended." }).to_string().into())).await;
                    break;
                };
                let refreshed = Viewer::load(&state, current).await;
                let mut registry = state.watch_rooms.lock();
                let Some(room) = registry.rooms.get_mut(&room_id) else { close_reason = "room closed"; break };
                if let Some(slot) = room.members.get_mut(&connection) {
                    slot.viewer = refreshed;
                }
                room.broadcast_state();
            }
            incoming = tokio::time::timeout(SOCKET_IDLE_TIMEOUT, socket.recv()) => {
                let message = match incoming {
                    Err(_) => { close_reason = "idle timeout"; break; }
                    Ok(None) => break,
                    Ok(Some(Err(error))) => {
                        tracing::info!(target: LOG_TARGET, event = "socket_error", room = %room_id, connection, user = %user.name, %error, "Watch room socket error");
                        close_reason = "socket error";
                        break;
                    }
                    Ok(Some(Ok(message))) => message,
                };
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                if text.len() > 64 * 1024 {
                    tracing::warn!(target: LOG_TARGET, event = "message_rejected", room = %room_id, connection, bytes = text.len(), "Oversized watch room message ignored");
                    continue;
                }
                let parsed: ClientMessage = match serde_json::from_str(&text) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        tracing::warn!(target: LOG_TARGET, event = "message_rejected", room = %room_id, connection, %error, "Unreadable watch room message ignored");
                        continue;
                    }
                };
                match parsed {
                    ClientMessage::Leave => { close_reason = "left"; break; }
                    message => {
                        if !handle_message(&state, &room_id, connection, &user, &sender, message) {
                            close_reason = "room closed";
                            break;
                        }
                    }
                }
            }
            outgoing = outgoing.recv() => {
                let Some(text) = outgoing else { break };
                if socket.send(Message::Text(text.into())).await.is_err() {
                    close_reason = "send failed";
                    break;
                }
            }
        }
    }

    let mut registry = state.watch_rooms.lock();
    if let Some(room) = registry.rooms.get_mut(&room_id) {
        room.members.remove(&connection);
        if room.members.is_empty() {
            room.empty_since = Some(Instant::now());
        }
        tracing::info!(
            target: LOG_TARGET,
            event = "member_left",
            room = %room.id,
            connection,
            user = %user.name,
            reason = close_reason,
            connected_seconds = connected_at.elapsed().as_secs(),
            members = room.members.len(),
            "Left watch room"
        );
        room.broadcast_state();
    }
}

/// Returns false when the member's room no longer exists.
fn handle_message(
    state: &AppState,
    room_id: &str,
    connection: u64,
    user: &StoredUser,
    sender: &mpsc::UnboundedSender<String>,
    message: ClientMessage,
) -> bool {
    let now = now_ms();
    match message {
        ClientMessage::Ping { id, t } => {
            let _ = sender.send(serde_json::json!({ "type": "pong", "id": id, "t": t, "server_time": now_ms() }).to_string());
            true
        }
        ClientMessage::Diag { event, detail } => {
            let event: String = event.chars().take(64).collect();
            let detail = detail.to_string();
            let detail: String = detail.chars().take(2000).collect();
            tracing::info!(target: LOG_TARGET, event = "client_diagnostic", room = %room_id, connection, user = %user.name, client_event = %event, detail = %detail, "Watch room client diagnostic");
            true
        }
        ClientMessage::Report { position, buffering, playing, media_path, at } => {
            let mut registry = state.watch_rooms.lock();
            let Some(room) = registry.rooms.get_mut(room_id) else { return false };
            let expected = room.playback.position_at(at.unwrap_or(now).clamp(now - 5000.0, now));
            let room_media = room.media.as_ref().map(|media| media.path.clone());
            let room_playing = room.playback.playing;
            let room_id_owned = room.id.clone();
            let Some(slot) = room.members.get_mut(&connection) else { return true };
            slot.member.position = position.map(clamp_position);
            slot.member.buffering = buffering.unwrap_or(false);
            slot.member.media_path = media_path.clone();
            slot.member.reported_at = now;
            if let Some(position) = position
                && media_path.is_some()
                && media_path == room_media
                && !slot.member.buffering
            {
                let drift = position - expected;
                if drift.abs() >= DRIFT_LOG_THRESHOLD_SECONDS
                    && slot.last_drift_log.is_none_or(|last| last.elapsed() >= DRIFT_LOG_INTERVAL)
                {
                    slot.last_drift_log = Some(Instant::now());
                    tracing::warn!(
                        target: LOG_TARGET,
                        event = "member_drift",
                        room = %room_id_owned,
                        connection,
                        user = %user.name,
                        drift_seconds = (drift * 100.0).round() / 100.0,
                        position,
                        expected,
                        member_playing = playing.unwrap_or(false),
                        room_playing,
                        "Watch room member is out of sync"
                    );
                }
            }
            // Member positions are informational; share them at most as
            // often as clients report, which is a few seconds apart.
            room.broadcast_members();
            true
        }
        ClientMessage::Rename { name } => {
            let mut registry = state.watch_rooms.lock();
            let Some(room) = registry.rooms.get_mut(room_id) else { return false };
            room.name = clean_name(Some(&name), &room.name);
            room.seq += 1;
            room.last_action = Some(RoomAction { seq: room.seq, action: "rename".into(), by: user.name.clone(), by_connection: connection, at: now });
            tracing::info!(target: LOG_TARGET, event = "room_renamed", room = %room.id, user = %user.name, name = %room.name, "Watch room renamed");
            room.broadcast_state();
            true
        }
        ClientMessage::Command { action, playing, position, rate, at, media, settings, reason } => {
            let mut registry = state.watch_rooms.lock();
            let Some(room) = registry.rooms.get_mut(room_id) else { return false };
            // The client samples its position slightly before the message
            // arrives. Using its estimate of server time removes that delay,
            // within limits so a bad clock cannot rewrite history.
            let at = at.filter(|at| at.is_finite()).unwrap_or(now).clamp(now - 3000.0, now);
            let sender_viewer = room.members.get(&connection).map(|slot| slot.viewer.clone());
            // A member who cannot see the current media cannot steer it either:
            // a seek or play from them would reveal nothing but still act
            // blindly on something they are not allowed to watch.
            let sender_sees_media = room.media.as_ref().is_none_or(|media| sender_viewer.as_ref().is_some_and(|viewer| viewer.can_view(&media.path)));
            if !sender_sees_media && matches!(action.as_str(), "play" | "pause" | "seek" | "rate" | "sync") {
                tracing::warn!(target: LOG_TARGET, event = "command_rejected", reason = "no_access", room = %room.id, connection, user = %user.name, action = %action, "Watch room command from a member without access to the media");
                let _ = sender.send(serde_json::json!({ "type": "error", "message": "The room is playing something you don't have access to." }).to_string());
                return true;
            }
            let previous = room.playback.clone();
            let current_position = previous.position_at(at);
            let mut action = action;
            let accepted = match action.as_str() {
                "play" | "pause" | "seek" | "rate" | "sync" => {
                    room.playback = RoomPlayback {
                        playing: playing.unwrap_or(match action.as_str() {
                            "play" => true,
                            "pause" => false,
                            _ => previous.playing,
                        }),
                        position: position.map(clamp_position).unwrap_or(current_position),
                        rate: rate.map(clamp_rate).unwrap_or(previous.rate),
                        at,
                    };
                    true
                }
                "media" => match media.filter(|media| {
                    media.valid()
                        && media_is_consistent(media)
                        && sender_viewer.as_ref().is_some_and(|viewer| viewer.can_view(&media.path))
                }) {
                    // Members on auto-next reach the next episode together and
                    // each announce it. Only the first one restarts playback.
                    Some(media)
                        if room.media.as_ref().is_some_and(|current| current.path == media.path)
                            && room.media_changed_at.is_some_and(|at| at.elapsed() < MEDIA_DUPLICATE_WINDOW) =>
                    {
                        action = "media_duplicate".into();
                        true
                    }
                    Some(media) => {
                        room.media_changed_at = Some(Instant::now());
                        room.media = Some(media);
                        room.media_seq += 1;
                        room.playback = RoomPlayback {
                            playing: playing.unwrap_or(true),
                            position: position.map(clamp_position).unwrap_or(0.0),
                            rate: rate.map(clamp_rate).unwrap_or(previous.rate),
                            at,
                        };
                        true
                    }
                    None => false,
                },
                "clear_media" => {
                    room.media = None;
                    room.media_changed_at = Some(Instant::now());
                    room.media_seq += 1;
                    room.playback = RoomPlayback { playing: false, position: 0.0, rate: previous.rate, at };
                    true
                }
                "settings" => match settings {
                    Some(patch) => {
                        let mut next = room.settings.clone();
                        if let Some(value) = patch.auto_skip { next.auto_skip = value; }
                        if let Some(value) = patch.auto_next { next.auto_next = value; }
                        if let Some(value) = patch.image_seconds { next.image_seconds = value; }
                        if let Some(value) = patch.loop_enabled { next.loop_enabled = value; }
                        room.settings = next.sanitized();
                        true
                    }
                    None => false,
                },
                _ => false,
            };
            if !accepted {
                tracing::warn!(target: LOG_TARGET, event = "command_rejected", room = %room.id, connection, user = %user.name, action = %action, "Watch room command rejected");
                let _ = sender.send(serde_json::json!({ "type": "error", "message": format!("Could not apply {action}") }).to_string());
                return true;
            }
            room.seq += 1;
            room.last_action = Some(RoomAction { seq: room.seq, action: action.clone(), by: user.name.clone(), by_connection: connection, at: now });
            tracing::info!(
                target: LOG_TARGET,
                event = "command",
                room = %room.id,
                seq = room.seq,
                connection,
                user = %user.name,
                action = %action,
                reason = reason.as_deref().unwrap_or(""),
                media = room.media.as_ref().map(|media| media.path.as_str()).unwrap_or(""),
                media_seq = room.media_seq,
                playing = room.playback.playing,
                position = (room.playback.position * 1000.0).round() / 1000.0,
                previous_position = (current_position * 1000.0).round() / 1000.0,
                rate = room.playback.rate,
                transit_ms = (now - at).round(),
                settings = ?room.settings,
                "Watch room command"
            );
            room.broadcast_state();
            true
        }
        ClientMessage::Leave => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(name: &str, is_admin: bool) -> StoredUser {
        serde_json::from_value(serde_json::json!({ "id": 1, "name": name, "password_hash": null, "created_at": 0, "is_admin": is_admin })).unwrap()
    }

    fn viewer(name: &str) -> Viewer {
        let libraries: BTreeMap<String, LibraryConfig> = serde_json::from_value(serde_json::json!({
            "Shared": { "content_type": "videos", "members": [{ "name": "member", "can_view": true }, { "name": "outsider", "can_view": true }] },
            "Private": { "content_type": "videos", "members": [{ "name": "member", "can_view": true }] },
        }))
        .unwrap();
        Viewer { user: user(name, false), libraries: Arc::new(libraries) }
    }

    fn media(path: &str) -> RoomMedia {
        let src = format!("/media/{}", path.split('/').map(|part| urlencoding::encode(part).into_owned()).collect::<Vec<_>>().join("/"));
        RoomMedia {
            path: path.to_owned(),
            name: "Episode 1.mkv".to_owned(),
            kind: "video".to_owned(),
            url: format!("/watch?src={}&path={}&name=Episode+1.mkv", urlencoding::encode(&src), urlencoding::encode(path)),
        }
    }

    fn room_with(media: RoomMedia) -> Room {
        let (sender, _receiver) = mpsc::unbounded_channel();
        let mut members = HashMap::new();
        members.insert(7, MemberSlot {
            member: RoomMember { connection: 7, user_id: 2, name: "member".into(), device: "Device".into(), joined_at: 0.0, position: Some(42.0), buffering: false, media_path: Some(media.path.clone()), reported_at: 0.0 },
            sender,
            last_drift_log: None,
            viewer: viewer("member"),
            hidden_media_seq: None,
        });
        Room {
            id: "room".into(),
            name: "Room".into(),
            created_by: "member".into(),
            created_at: 0.0,
            media: Some(media),
            media_seq: 1,
            media_changed_at: None,
            playback: RoomPlayback { playing: true, position: 42.0, rate: 1.0, at: now_ms() },
            settings: RoomSettings::default(),
            seq: 1,
            last_action: None,
            members,
            empty_since: None,
        }
    }

    #[test]
    fn share_url_must_name_the_same_media() {
        assert!(media_is_consistent(&media("Shared/Show/Episode 1.mkv")));
        let mut swapped = media("Shared/Show/Episode 1.mkv");
        swapped.path = "Shared/Show/Other.mkv".into();
        assert!(!media_is_consistent(&swapped));
        let mut offline = media("Shared/Show/Episode 1.mkv");
        offline.url.push_str("&offlineBundle=x");
        assert!(!media_is_consistent(&offline));
        let mut external = media("Shared/Show/Episode 1.mkv");
        external.url = "https://example.invalid/watch?src=x".into();
        assert!(!media_is_consistent(&external));
    }

    #[test]
    fn media_outside_a_members_libraries_is_hidden() {
        let room = room_with(media("Private/Secret Title/Episode 1.mkv"));
        let hidden = room.snapshot_for(&viewer("outsider"));
        assert!(hidden.media.is_none());
        assert!(hidden.media_hidden);
        assert_eq!(hidden.playback.position, 0.0);
        assert!(!hidden.playback.playing);
        assert!(hidden.members.iter().all(|member| member.media_path.is_none() && member.position.is_none()));
        let serialized = serde_json::to_string(&hidden).unwrap();
        assert!(!serialized.contains("Secret Title"));
        assert!(!serialized.contains("Private"));

        let visible = room.snapshot_for(&viewer("member"));
        assert!(!visible.media_hidden);
        assert_eq!(visible.media.unwrap().path, "Private/Secret Title/Episode 1.mkv");
    }

    #[test]
    fn shared_libraries_stay_visible_and_paths_cannot_escape() {
        let room = room_with(media("Shared/Show/Episode 1.mkv"));
        assert!(!room.snapshot_for(&viewer("outsider")).media_hidden);
        assert!(!viewer("member").can_view("../Private/x.mkv"));
        assert!(!viewer("member").can_view(""));
    }
}
