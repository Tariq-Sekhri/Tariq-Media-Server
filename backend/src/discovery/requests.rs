use crate::qbit::{queue_magnet_for_user, remove_completed_qbittorrent_torrent, stop_qbittorrent_torrent};
use super::*;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Permission {
    pub user_id: u64,
    pub library: String,
    pub can_request: bool,
    pub auto_approve_requests: bool,
    pub weekly_limit: u32,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Request {
    pub id: String,
    pub kind: String,
    pub tmdb_id: u64,
    pub title: String,
    pub season: Option<u16>,
    pub expected_episodes: BTreeSet<u16>,
    pub monitor_future: bool,
    pub library: String,
    pub owner_id: u64,
    #[serde(default)]
    pub download_user_id: Option<u64>,
    #[serde(default)]
    pub quota_override_by: Option<u64>,
    pub subscribers: BTreeSet<u64>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub hash: Option<String>,
    pub service_id: Option<u64>,
    pub progress: f64,
    #[serde(default)]
    pub approved_by: Option<u64>,
    #[serde(default)]
    pub service_snapshot: Option<Value>,
    #[serde(default)]
    pub submitted: bool,
    #[serde(default)]
    pub search_started: bool,
    #[serde(default)]
    pub metadata_handoffs: BTreeMap<String, Value>,
    #[serde(default)]
    pub expected_bytes: Option<u64>,
    #[serde(default)]
    pub grab_guid: Option<String>,
    #[serde(default)]
    pub torrent_hash: Option<String>,
    #[serde(default)]
    pub auto_download: bool,
    #[serde(default)]
    pub auto_download_seasons: BTreeSet<u16>,
    #[serde(default)]
    pub auto_download_complete_series: bool,
    #[serde(default)]
    pub subscription_id: Option<String>,
    #[serde(default)]
    pub monitor_from: Option<u64>,
    #[serde(default)]
    pub monitor_applied_at: u64,
    // Why auto pick stopped short and left the request for an administrator.
    #[serde(default)]
    pub auto_pick_note: Option<String>,
    // The release auto pick chose for a request still awaiting approval.
    #[serde(default)]
    pub proposal: Option<String>,
}
#[derive(Default, Deserialize, Serialize)]
pub struct Queue {
    pub requests: Vec<Request>,
}
impl Request {
    pub fn download_user_id(&self) -> u64 {
        self.download_user_id.unwrap_or(self.owner_id)
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RequestQuota { Requester, Override, Admin }

fn set_request_quota(r: &mut Request, mode: RequestQuota, caller: &StoredUser) -> Result<(), (StatusCode, Json<Value>)> {
    if !caller.is_admin {
        return Err(error(StatusCode::FORBIDDEN, "Only full administrators can change request quotas."));
    }
    if !needs_action(r) || r.hash.is_some() || r.torrent_hash.is_some() || (r.submitted && r.service_id.is_none()) || r.search_started {
        return Err(error(StatusCode::CONFLICT, "Change the quota before the download has been submitted."));
    }
    r.download_user_id = matches!(mode, RequestQuota::Admin).then_some(caller.id);
    r.quota_override_by = matches!(mode, RequestQuota::Override).then_some(caller.id);
    if r.status == "failed" { r.status = "queued".into(); r.error = None; }
    Ok(())
}
pub fn active(r: &Request) -> bool {
    !matches!(r.status.as_str(), "declined" | "cancelled")
}
fn closed(status: &str) -> bool {
    matches!(status, "declined" | "cancelled")
}
// Requests are an action inbox, not a download-progress queue. Once Server
// Download owns a magnet, its own job/status surfaces are authoritative.
pub(super) fn needs_action(r: &Request) -> bool {
    r.hash.is_none() && r.subscription_id.is_none() && matches!(
        r.status.as_str(),
        "pending" | "queued" | "pick" | "searching" | "failed" | "submitting"
    )
}
// Auto pick owns the row until it hands the downloads off, so it leaves the
// inbox at once. A note (handed back) or an error brings it back.
pub(super) fn auto_picking(r: &Request) -> bool {
    r.auto_download && r.auto_pick_note.is_none() && r.error.is_none() && r.hash.is_none()
        && matches!(r.status.as_str(), "queued" | "searching" | "pick")
}
fn needs_download_cleanup(r: &Request) -> bool {
    r.hash.is_some() || r.torrent_hash.is_some() || r.submitted || r.search_started
}
fn purge_closed(queue: &mut Queue) -> bool {
    let before = queue.requests.len();
    queue.requests.retain(|r| !closed(&r.status));
    before != queue.requests.len()
}
pub async fn remove(state: &AppState, id: &str) -> Result<(), (StatusCode, Json<Value>)> {
    let mut queue: Queue = load(state, "discovery-requests.json").await?;
    queue.requests.retain(|r| r.id != id);
    save(state, &queue).await
}
pub fn same_target(r: &Request, kind: &str, id: u64, library: &str, season: Option<u16>) -> bool {
    r.kind == kind && r.tmdb_id == id && r.library == library && r.season == season && active(r)
}
fn covered_by_pack(r: &Request, kind: &str, tmdb_id: u64, library: &str, seasons: &BTreeSet<u16>) -> bool {
    r.kind == kind && r.tmdb_id == tmdb_id && r.library == library
        && r.hash.is_none() && r.subscription_id.is_none() && matches!(r.status.as_str(), "queued" | "pick" | "failed" | "searching")
        && r.season.is_some_and(|season| seasons.contains(&season))
}
fn covered_by_automatic_pack(row: &Request, source: &Request, seasons: &BTreeSet<u16>) -> bool {
    covered_by_pack(row, &source.kind, source.tmdb_id, &source.library, seasons)
        || (source.auto_download && row.status == "pending" && row.hash.is_none()
            && row.owner_id == source.owner_id && row.kind == source.kind
            && row.tmdb_id == source.tmdb_id && row.library == source.library
            && row.season.is_some_and(|season| seasons.contains(&season)
                && source.auto_download_seasons.contains(&season)))
}
pub async fn save(state: &AppState, queue: &Queue) -> Result<(), (StatusCode, Json<Value>)> {
    write_persisted_json(&data_path(state, "discovery-requests.json"), queue)
        .await
        .map_err(internal)
}
pub async fn access(
    state: &AppState,
    user: &StoredUser,
) -> Result<Vec<Permission>, (StatusCode, Json<Value>)> {
    let libraries = read_libraries(state).await;
    Ok(library_access(user, &libraries))
}

fn library_access(user: &StoredUser, libraries: &BTreeMap<String, LibraryConfig>) -> Vec<Permission> {
    libraries
        .iter()
        .filter(|(name, l)| l.content_type == "movies_tv" && !l.folder_structure_static
            && visible(user, libraries, name))
        .map(|(name, library)| Permission {
            user_id: user.id,
            library: name.clone(),
            can_request: user.is_admin || library.members.iter().any(|member|
                member.can_download && member.name.eq_ignore_ascii_case(&user.name)),
            auto_approve_requests: user.is_admin,
            // Retained in the response for older clients. Storage quota is the limit.
            weekly_limit: 0,
        })
        .collect()
}

pub async fn destination(
    state: &AppState,
    user: &StoredUser,
    library: &str,
) -> Result<(String, PathBuf), (StatusCode, Json<Value>)> {
    let libraries = read_libraries(state).await;
    if !safe_relative_path(library)
        || library.contains(['/', '\\'])
        || !libraries
            .get(library)
            .is_some_and(|l| l.content_type == "movies_tv" && !l.folder_structure_static)
        || !visible(user, &libraries, library)
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Choose a Movies & TV library you can access.",
        ));
    }
    let path = state.library_root.join(library);
    if !path.is_dir() {
        return Err(error(
            StatusCode::CONFLICT,
            "The destination library is unavailable.",
        ));
    }
    Ok((library.into(), path))
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/discover/requests", get(list).post(create))
        .route("/api/discover/requests/{id}", post(action))
}
async fn list(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    let user = user(&state, &headers).await?;
    if !user.is_admin {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Only full administrators can view requests.",
        ));
    }
    let libraries = read_libraries(&state).await;
    let users = read_users(&state.users_path).await;
    let mut queue: Queue = load(&state, "discovery-requests.json").await?;
    if purge_closed(&mut queue) {
        save(&state, &queue).await?;
    }
    let rows: Vec<_> = queue
        .requests
        .into_iter()
        .filter(|r| needs_action(r) && !auto_picking(r) && visible(&user, &libraries, &r.library))
        .map(|mut r| {
            r.service_snapshot = None;
            r.metadata_handoffs.clear();
            let requested_by = users.iter().find(|u| u.id == r.owner_id).map(|u| u.name.as_str()).unwrap_or("Unknown user");
            let download_user = users.iter().find(|u| u.id == r.download_user_id()).map(|u| u.name.as_str()).unwrap_or("Unknown user");
            let mut value = serde_json::to_value(r).unwrap_or(Value::Null);
            if let Some(object) = value.as_object_mut() {
                object.insert("requested_by_name".into(), json!(requested_by));
                object.insert("download_user_name".into(), json!(download_user));
            }
            value
        })
        .collect();
    Ok(Json(json!({"requests":rows})))
}
#[derive(Deserialize)]
struct Create {
    kind: String,
    tmdb_id: u64,
    library: String,
    #[serde(default)]
    seasons: BTreeSet<u16>,
    #[serde(default)]
    monitor_future: bool,
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut input): Json<Create>,
) -> ApiResult<Value> {
    let user = user(&state, &headers).await?;
    let catalog = if input.kind == "movie" {
        "movie"
    } else if input.kind == "tv" {
        "tv"
    } else {
        media_kind(&input.kind)?
    };
    input.kind = catalog.to_owned();
    destination(&state, &user, &input.library).await?;
    let _run = state.discovery_lock.lock().await;
    let permission = access(&state, &user)
        .await?
        .into_iter()
        .find(|p| p.library == input.library && p.can_request)
        .ok_or_else(|| {
            error(
                StatusCode::FORBIDDEN,
                "You do not have permission to download into this library.",
            )
        })?;
    if input.kind == "tv" && input.seasons.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Select at least one season.",
        ));
    }
    if input.seasons.len() > 100 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Request at most 100 seasons at once.",
        ));
    }
    let detail = tmdb(&state, &format!("{}/{}", input.kind, input.tmdb_id), &[]).await?;
    let title = detail["title"]
        .as_str()
        .or(detail["name"].as_str())
        .unwrap_or("Untitled")
        .to_owned();
    let mut targets = vec![];
    let today = time::OffsetDateTime::now_utc().date().to_string();
    let mut completed_seasons = BTreeSet::new();
    if input.kind == "movie" {
        let released = tmdb(&state, &format!("movie/{}/release_dates", input.tmdb_id), &[]).await
            .ok().is_some_and(|dates| eligibility::digital_movie(&dates, &today));
        targets.push((None, BTreeSet::new(), released));
    } else {
        for season in input.seasons {
            if !detail["seasons"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|s| s["season_number"].as_u64() == Some(season as u64))
            }) {
                return Err(error(
                    StatusCode::BAD_REQUEST,
                    "One of the selected seasons does not exist.",
                ));
            }
            let season_detail = tmdb(
                &state,
                &format!("tv/{}/season/{season}", input.tmdb_id),
                &[],
            )
            .await?;
            let episodes = season_detail["episodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| {
                    e["episode_number"]
                        .as_u64()
                        .and_then(|n| u16::try_from(n).ok())
                })
                .collect();
            let completed = eligibility::completed_season(&detail, &season_detail, &today);
            if completed { completed_seasons.insert(season); }
            targets.push((Some(season), episodes, completed));
        }
    }
    let mut queue: Queue = load(&state, "discovery-requests.json").await?;
    let mut new_count = 0;
    let mut ids = vec![];
    let all_series_seasons: BTreeSet<_> = detail["seasons"].as_array().into_iter().flatten()
        .filter_map(|s| s["season_number"].as_u64().and_then(|n| u16::try_from(n).ok()))
        .filter(|n| *n > 0).collect();
    let completed_series = matches!(detail["status"].as_str(), Some("Ended" | "Canceled"))
        && !all_series_seasons.is_empty() && all_series_seasons == completed_seasons;
    let mut automatic = 0usize;
    let mut follow = false;
    let _storage = state.persistence_lock.lock().await;
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    let original_ledger = ledger.clone();
    for (season, expected_episodes, eligible) in targets {
        if let Some(existing) = queue
            .requests
            .iter_mut()
            .find(|r| same_target(r, &input.kind, input.tmdb_id, &input.library, season) && r.subscription_id.is_none())
        {
            existing.subscribers.insert(user.id);
            ids.push(existing.id.clone());
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let reserved = eligible && reserve_storage(&mut ledger, &user,
            &format!("discover:{id}"), "discover", arr::REQUEST_BUDGET_BYTES);
        // Every request searches and auto picks first. The reservation only
        // lets released titles skip administrator approval of that pick.
        let approved = reserved || permission.auto_approve_requests;
        let auto_download = true;
        automatic += usize::from(approved);
        follow |= approved && input.kind == "tv";
        ids.push(id.clone());
        new_count += 1;
        queue.requests.push(Request {
            id,
            kind: input.kind.clone(),
            tmdb_id: input.tmdb_id,
            title: title.clone(),
            season,
            expected_episodes,
            monitor_future: input.monitor_future && input.kind == "tv",
            library: input.library.clone(),
            owner_id: user.id,
            download_user_id: None,
            quota_override_by: None,
            subscribers: BTreeSet::from([user.id]),
            status: "queued".into(),
            error: None,
            created_at: unix_now(),
            updated_at: unix_now(),
            hash: None,
            service_id: None,
            progress: 0.0,
            approved_by: approved.then_some(user.id),
            service_snapshot: None,
            submitted: false,
            search_started: false,
            metadata_handoffs: BTreeMap::new(),
            expected_bytes: None,
            grab_guid: None,
            torrent_hash: None,
            auto_download,
            auto_download_seasons: completed_seasons.clone(),
            auto_download_complete_series: completed_series,
            subscription_id: None,
            monitor_from: None,
            monitor_applied_at: 0,
            auto_pick_note: None,
            proposal: None,
        });
    }
    write_storage_ledger(&state.storage_path, &ledger).await.map_err(internal)?;
    if let Err(problem) = save(&state, &queue).await {
        write_storage_ledger(&state.storage_path, &original_ledger).await.map_err(internal)?;
        return Err(problem);
    }
    drop(_storage);
    if follow {
        if let Err((_, Json(problem))) = subscriptions::follow_airing(&state, input.tmdb_id, &input.library, user.id, &BTreeSet::from([user.id])).await {
            tracing::warn!(tmdb_id=input.tmdb_id, message=%problem, "Could not subscribe to the requested show's new episodes");
        }
    }
    Ok(Json(json!({"ids":ids,"created":new_count,"automatic":automatic})))
}
#[derive(Deserialize)]
struct Action {
    action: String,
    magnet: Option<String>,
    guid: Option<String>,
    indexer_id: Option<u64>,
    quota: Option<RequestQuota>,
}
async fn action(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<Action>,
) -> ApiResult<Value> {
    let caller = user(&state, &headers).await?;
    if !caller.is_admin {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Only full administrators can manage requests.",
        ));
    }
    let manager = caller.is_admin;
    let _run = state.discovery_lock.lock().await;
    let mut queue: Queue = load(&state, "discovery-requests.json").await?;
    let mut remove_after_download_handoff = false;
    let mut pack_handoff = None;
    let mut follow = None;
    {
        let r = queue
            .requests
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or_else(|| error(StatusCode::NOT_FOUND, "Request not found."))?;
        if !visible(&caller, &read_libraries(&state).await, &r.library)
            || (!manager && !r.subscribers.contains(&caller.id))
        {
            return Err(error(
                StatusCode::FORBIDDEN,
                "You cannot manage this request.",
            ));
        }
        match input.action.as_str() {
            "quota" => {
                let mode = input.quota.ok_or_else(|| error(StatusCode::BAD_REQUEST, "Choose a quota option."))?;
                // Validate first; do not change live reservations after handoff.
                let mut next = r.clone();
                set_request_quota(&mut next, mode, &caller)?;
                arr::release_request_reservation(&state, r).await?;
                tracing::info!(request_id=%id, admin_id=caller.id, download_user_id=next.download_user_id(), quota_override=next.quota_override_by.is_some(), "Admin changed Discover request quota");
                *r = next;
            }
            "approve" | "decline" if manager && r.status == "pending" => {
                r.status = if input.action == "approve" {
                    "queued"
                } else {
                    "declined"
                }
                .into();
                r.approved_by = Some(caller.id);
                r.proposal = None;
                if input.action == "approve" {
                    // The next tick re-runs auto pick over the same saved
                    // results and downloads the proposed release.
                    r.auto_download = true;
                    r.auto_pick_note = None;
                    if r.kind == "tv" {
                        follow = Some((r.tmdb_id, r.library.clone(), r.owner_id, r.subscribers.clone()));
                    }
                }
            }
            // Let auto pick choose instead of picking a torrent by hand.
            "auto"
                if manager
                    && r.hash.is_none()
                    && r.subscription_id.is_none()
                    && matches!(r.status.as_str(), "pending" | "queued" | "pick" | "failed" | "searching") =>
            {
                tracing::info!(request_id=%id, admin_id=caller.id, title=%r.title, season=?r.season, "Admin asked Discover auto pick to download the request");
                arr::forget_releases(&state, &id).await;
                r.status = "queued".into();
                r.approved_by = Some(caller.id);
                r.auto_download = true;
                r.auto_pick_note = None;
                r.error = None;
                r.search_started = false;
                r.grab_guid = None;
                r.torrent_hash = None;
                if r.kind == "tv" {
                    follow = Some((r.tmdb_id, r.library.clone(), r.owner_id, r.subscribers.clone()));
                }
            }
            "retry" if manager && r.status == "failed" => {
                r.status = "queued".into();
                r.auto_download = true;
                r.auto_pick_note = None;
                r.error = None;
                r.search_started = false;
                r.grab_guid = None;
                r.torrent_hash = None;
            }
            "grab"
                if manager
                    && matches!(
                        r.status.as_str(),
                        "pending" | "queued" | "pick" | "failed" | "searching"
                    )
                    && r.hash.is_none() =>
            {
                let guid = input.guid.filter(|g| !g.trim().is_empty()).ok_or_else(|| {
                    error(StatusCode::BAD_REQUEST, "Choose a release to download.")
                })?;
                let indexer_id = input.indexer_id.ok_or_else(|| {
                    error(StatusCode::BAD_REQUEST, "Choose a release to download.")
                })?;
                tracing::info!(request_id=%id, indexer_id, guid=%guid, guid_len=guid.len(), info_hash=?magnet_info_hash(&guid), "Discover grab action received");
                let seasons = arr::grab_selected_release(&state, r, &guid, indexer_id, caller.is_admin).await?;
                r.approved_by = Some(caller.id);
                pack_handoff = Some((r.kind.clone(), r.tmdb_id, r.library.clone(), seasons));
                remove_after_download_handoff = r.status == "downloading";
            }
            "cancel" if active(r) && (r.status != "ready" || r.monitor_future) => {
                if !manager {
                    r.subscribers.remove(&caller.id);
                }
                if manager || r.subscribers.is_empty() {
                    r.status = if needs_download_cleanup(r) {
                        "cancelling"
                    } else {
                        "cancelled"
                    }
                    .into();
                }
            }
            "magnet"
                if manager
                    && matches!(r.status.as_str(), "queued" | "pick" | "failed")
                    && r.service_id.is_none()
                    && !r.submitted =>
            {
                let magnet = input.magnet.unwrap_or_default();
                let hash = magnet_info_hash(&magnet)
                    .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Enter a valid magnet link."))?;
                if r.hash.as_ref().is_some_and(|h| h != &hash) {
                    return Err(error(
                        StatusCode::CONFLICT,
                        "Retry with the same magnet, or cancel this request first.",
                    ));
                }
                let owner = read_users(&state.users_path)
                    .await
                    .into_iter()
                    .find(|u| u.id == r.download_user_id())
                    .ok_or_else(|| {
                        error(
                            StatusCode::CONFLICT,
                            "The requesting user no longer exists.",
                        )
                    })?;
                let dest = destination(&state, &owner, &r.library).await?;
                let jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
                if jobs.jobs.iter().any(|j| {
                    j.hash == hash
                        && (j.user_id != owner.id
                            || !j.destination_path.starts_with(&format!("{}/", r.library))
                                && j.destination_path != r.library)
                }) {
                    return Err(error(
                        StatusCode::CONFLICT,
                        "This magnet already belongs to another download.",
                    ));
                }
                r.hash = Some(hash);
                r.status = "submitting".into();
                r.error = None;
                let library = r.library.clone();
                let quota_override = r.quota_override_by.is_some();
                save(&state, &queue).await?;
                let (status, response) = queue_magnet_for_user(
                    state.clone(),
                    owner,
                    MagnetDownloadRequest {
                        magnet,
                        destination_path: library,
                    },
                    Some(dest),
                    None,
                    caller.is_admin,
                    quota_override,
                )
                .await;
                let r = queue.requests.iter_mut().find(|r| r.id == id).unwrap();
                r.status = if status.is_success() {
                    "downloading"
                } else {
                    "failed"
                }
                .into();
                if !status.is_success() {
                    r.error = Some(response.0.message);
                }
                remove_after_download_handoff = status.is_success();
            }
            _ => {
                return Err(error(
                    StatusCode::CONFLICT,
                    "This action is not available in the request's current state.",
                ));
            }
        }
    };
    if remove_after_download_handoff {
        tracing::info!(request_id=%id, action=%input.action, "Discover request handed to Server Download and removed from action inbox");
        let removed: Vec<_> = queue.requests.iter().filter(|row| row.id == id || pack_handoff.as_ref().is_some_and(|(kind, tmdb_id, library, seasons)| {
            covered_by_pack(row, kind, *tmdb_id, library, seasons)
        })).cloned().collect();
        for row in &removed { arr::release_request_reservation(&state, row).await?; }
        queue.requests.retain(|row| !removed.iter().any(|removed| removed.id == row.id));
    } else if let Some(r) = queue.requests.iter_mut().find(|r| r.id == id) {
        r.updated_at = unix_now();
    }
    purge_closed(&mut queue);
    save(&state, &queue).await?;
    if let Some((tmdb_id, library, owner_id, subscribers)) = follow {
        if let Err((_, Json(problem))) = subscriptions::follow_airing(&state, tmdb_id, &library, owner_id, &subscribers).await {
            tracing::warn!(request_id=%id, message=%problem, "Could not subscribe to the approved show's new episodes");
        }
    }
    Ok(Json(json!({"saved":true})))
}

pub fn start_worker(state: AppState) {
    supervise("discovery_requests", move || {
        let state = state.clone();
        async move {
            {
                let _run = state.discovery_lock.lock().await;
                if let Err((_, Json(value))) = arr::initialize_budget(&state).await {
                    tracing::warn!(message=%value, "Request budget migration failed");
                }
            }
            loop {
                {
                    let _run = state.discovery_lock.lock().await;
                    if let Err((_, Json(value))) = reconcile_manual(&state).await {
                        tracing::warn!(message=%value,"Request reconciliation failed");
                    }
                    if let Err((_, Json(value))) = arr::tick(&state).await {
                        tracing::warn!(message=%value,"Automatic request reconciliation failed");
                    }
                    if let Err((_, Json(value))) = subscriptions::tick(&state).await {
                        tracing::warn!(message=%value,"Subscription check failed");
                    }
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
    });
}
pub fn covered(r: &Request, files: &[(String, u64)]) -> bool {
    if r.kind == "movie" {
        return !files.is_empty();
    }
    let inv = inventory(files);
    !r.expected_episodes.is_empty()
        && r.season
            .and_then(|s| inv.get(&s))
            .is_some_and(|have| r.expected_episodes.is_subset(have))
}
pub(super) async fn finish_download_handoff(state: &AppState, r: &Request, seasons: &BTreeSet<u16>) -> Result<(), (StatusCode, Json<Value>)> {
    let mut queue: Queue = load(state, "discovery-requests.json").await?;
    let removed: Vec<_> = queue.requests.iter().filter(|row| row.id == r.id
        || covered_by_automatic_pack(row, r, seasons)).cloned().collect();
    for row in &removed { arr::release_request_reservation(state, row).await?; }
    queue.requests.retain(|row| !removed.iter().any(|removed| removed.id == row.id));
    save(state, &queue).await
}
async fn reconcile_manual(state: &AppState) -> Result<(), (StatusCode, Json<Value>)> {
    let mut queue: Queue = load(state, "discovery-requests.json").await?;
    let mut changed = purge_closed(&mut queue);
    if !queue
        .requests
        .iter()
        .any(|r| r.hash.is_some() && active(r) && r.status != "ready")
    {
        if changed {
            save(state, &queue).await?;
        }
        return Ok(());
    }
    let jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
    let ledger = read_storage_ledger(&state.storage_path).await;
    let mut additions = vec![];
    for r in &mut queue.requests {
        let Some(hash) = r.hash.as_ref() else {
            continue;
        };
        if !active(r) || r.status == "ready" {
            continue;
        }
        if r.status == "cancelling" {
            let session = connect_qbittorrent(state).await.map_err(|_| {
                error(
                    StatusCode::BAD_GATEWAY,
                    "Could not connect to qBittorrent to pause the request.",
                )
            })?;
            if !stop_qbittorrent_torrent(state, &session, hash).await {
                continue;
            }
            r.status = "cancelled".into();
            r.updated_at = unix_now();
            changed = true;
            continue;
        }
        let Some(job) = jobs.jobs.iter().find(|j| &j.hash == hash) else {
            if r.status == "submitting" {
                r.status = "failed".into();
                r.error = Some(
                    "Submission was interrupted. Retry the same magnet to reconcile it.".into(),
                );
                changed = true;
            }
            continue;
        };
        if job.status == "failed" {
            r.status = "failed".into();
            r.error = job.error.clone();
            changed = true;
            continue;
        }
        if job.status != "completed" {
            r.status = "downloading".into();
            changed = true;
            continue;
        }
        let files: Vec<_> = ledger
            .allocations
            .iter()
            .filter(|a| {
                a.job_id.as_deref() == Some(hash)
                    && a.trash_id.is_none()
                    && state.library_root.join(&a.path).is_file()
            })
            .map(|a| (a.path.clone(), a.bytes))
            .collect();
        // Normally the server-download watcher did this before it marked the
        // magnet job complete. Repeat it here for completed legacy jobs so a
        // finished request can never leave a seeding qBittorrent item behind.
        if let Ok(session) = connect_qbittorrent(state).await {
            let _ = stop_qbittorrent_torrent(state, &session, hash).await;
            let _ = remove_completed_qbittorrent_torrent(state, &session, hash).await;
        }
        r.status = if covered(r, &files) {
            "ready"
        } else if files.is_empty() {
            "importing"
        } else {
            "partial"
        }
        .into();
        r.progress = if r.status == "ready" { 1.0 } else { 0.0 };
        r.error = None;
        r.updated_at = unix_now();
        changed = true;
        for (path, _) in files {
            additions.push(TitleMatch {
                kind: r.kind.clone(),
                tmdb_id: r.tmdb_id,
                path,
            });
        }
    }
    // Completed magnet jobs are finalized by the regular server-download
    // watcher, which stops and removes the qBittorrent torrent. A request is
    // only queue state, so do not leave a completed download in this list.
    let before = queue.requests.len();
    queue.requests.retain(|r| r.status != "ready");
    if queue.requests.len() != before {
        changed = true;
    }
    if purge_closed(&mut queue) {
        changed = true;
    }
    if !additions.is_empty() {
        let _guard = state.persistence_lock.lock().await;
        let mut matches: Matches = load(state, "discovery-matches.json").await?;
        for m in additions {
            matches.titles.retain(|old| old.path != m.path);
            matches.titles.push(m);
        }
        write_persisted_json(&data_path(state, "discovery-matches.json"), &matches)
            .await
            .map_err(internal)?;
    }
    if changed {
        save(state, &queue).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn discover_uses_library_download_access_without_a_separate_policy() {
        let mut user: StoredUser = serde_json::from_value(json!({
            "id": 42, "name": "Member", "password_hash": null, "created_at": 0
        })).unwrap();
        let mut libraries: BTreeMap<String, LibraryConfig> = serde_json::from_value(json!({
            "Movies": {"content_type": "movies_tv", "members": [
                {"name": "member", "can_view": true, "can_download": true}
            ]},
            "View only": {"content_type": "movies_tv", "members": [
                {"name": "Member", "can_view": true}
            ]},
            "Hidden": {"content_type": "movies_tv", "members": [
                {"name": "Member", "can_view": false, "can_download": true}
            ]},
            "Static": {"content_type": "movies_tv", "folder_structure_static": true},
            "Music": {"content_type": "music"}
        })).unwrap();
        let access = library_access(&user, &libraries);
        assert_eq!(access.len(), 2);
        let movies = access.iter().find(|p| p.library == "Movies").unwrap();
        assert!(movies.can_request);
        assert_eq!(movies.weekly_limit, 0);
        assert!(!access.iter().find(|p| p.library == "View only").unwrap().can_request);
        libraries.get_mut("Movies").unwrap().members[0].can_download = false;
        assert!(!library_access(&user, &libraries).iter().find(|p| p.library == "Movies").unwrap().can_request);
        user.is_admin = true;
        let admin = library_access(&user, &libraries);
        assert_eq!(admin.len(), 3);
        assert!(admin.iter().all(|p| p.can_request && p.auto_approve_requests));
    }

    use super::*;
    fn sample() -> Request {
        serde_json::from_value(json!({"id":"1","kind":"tv","tmdb_id":10,"title":"A","season":1,"expected_episodes":[1,2],"monitor_future":false,"library":"TV","owner_id":1,"subscribers":[1],"status":"pending","error":null,"created_at":1,"updated_at":1,"hash":null,"service_id":null,"progress":0.0})).unwrap()
    }
    fn quota_admin() -> StoredUser {
        serde_json::from_value(json!({"id":2,"name":"Admin","created_at":0,"password_hash":null,"is_admin":true})).unwrap()
    }
    #[test]
    fn request_quota_choices_preserve_requester_and_survive_reload() {
        let admin = quota_admin();
        let mut r = sample();
        r.status = "failed".into();
        r.error = Some("Quota exceeded".into());
        set_request_quota(&mut r, RequestQuota::Override, &admin).unwrap();
        assert_eq!(r.owner_id, 1);
        assert_eq!(r.download_user_id(), 1);
        assert_eq!(r.quota_override_by, Some(2));
        assert_eq!(r.status, "queued");
        assert!(r.error.is_none());
        let mut r: Request = serde_json::from_value(serde_json::to_value(r).unwrap()).unwrap();
        assert_eq!(r.quota_override_by, Some(2));
        set_request_quota(&mut r, RequestQuota::Admin, &admin).unwrap();
        assert_eq!(r.download_user_id(), 2);
        assert!(r.quota_override_by.is_none());
        assert_eq!(r.owner_id, 1);
        assert_eq!(r.subscribers, BTreeSet::from([1]));
        set_request_quota(&mut r, RequestQuota::Requester, &admin).unwrap();
        assert_eq!(r.download_user_id(), 1);
        assert!(r.quota_override_by.is_none());
    }
    #[test]
    fn search_registration_does_not_block_admin_quota_choice_or_approve_request() {
        let mut r = sample();
        r.submitted = true;
        r.service_id = Some(10);
        set_request_quota(&mut r, RequestQuota::Admin, &quota_admin()).unwrap();
        assert_eq!(r.status, "pending");
        assert!(r.approved_by.is_none());
        assert_eq!(r.download_user_id(), 2);
    }
    #[test]
    fn request_quota_changes_require_admin_and_reject_in_flight_downloads() {
        let mut caller = quota_admin();
        caller.is_admin = false;
        let mut r = sample();
        assert_eq!(set_request_quota(&mut r, RequestQuota::Override, &caller).unwrap_err().0, StatusCode::FORBIDDEN);
        assert!(r.quota_override_by.is_none());
        caller.is_admin = true;
        for field in ["hash", "torrent_hash", "submitted", "search_started"] {
            let mut r = sample();
            match field {
                "hash" => r.hash = Some("hash".into()),
                "torrent_hash" => r.torrent_hash = Some("hash".into()),
                "submitted" => r.submitted = true,
                _ => r.search_started = true,
            }
            assert_eq!(set_request_quota(&mut r, RequestQuota::Admin, &caller).unwrap_err().0, StatusCode::CONFLICT);
            assert!(r.download_user_id.is_none());
        }
    }
    #[test]
    fn a_budgeted_series_pack_clears_its_requesters_completed_pending_seasons() {
        let mut source = sample();
        source.auto_download = true;
        source.auto_download_seasons = [1, 2].into_iter().collect();
        let mut row = sample();
        row.season = Some(2);
        let seasons = [1, 2, 3].into_iter().collect();
        assert!(covered_by_automatic_pack(&row, &source, &seasons));
        row.owner_id = 2;
        assert!(!covered_by_automatic_pack(&row, &source, &seasons));
        row.owner_id = 1;
        row.season = Some(3);
        assert!(!covered_by_automatic_pack(&row, &source, &seasons));
        row.season = Some(2);
        source.auto_download = false;
        assert!(!covered_by_automatic_pack(&row, &source, &seasons));
    }
    #[test]
    fn pack_handoff_only_clears_covered_approved_requests_for_same_title_and_library() {
        let mut r = sample();
        let seasons = [1, 2, 3].into_iter().collect();
        assert!(!covered_by_pack(&r, "tv", 10, "TV", &seasons));
        r.status = "pick".into();
        assert!(covered_by_pack(&r, "tv", 10, "TV", &seasons));
        r.season = Some(3);
        assert!(covered_by_pack(&r, "tv", 10, "TV", &seasons));
        r.season = Some(4);
        assert!(!covered_by_pack(&r, "tv", 10, "TV", &seasons));
        r.season = Some(1);
        assert!(!covered_by_pack(&r, "tv", 11, "TV", &seasons));
        assert!(!covered_by_pack(&r, "tv", 10, "Other", &seasons));
        r.hash = Some("already-downloading".into());
        assert!(!covered_by_pack(&r, "tv", 10, "TV", &seasons));
    }
    #[test]
    fn dedup_is_scoped_to_kind_library_and_season() {
        let r = sample();
        assert!(same_target(&r, "tv", 10, "TV", Some(1)));
        assert!(!same_target(&r, "movie", 10, "TV", Some(1)));
        assert!(!same_target(&r, "tv", 10, "Other", Some(1)));
        assert!(!same_target(&r, "tv", 10, "TV", Some(2)));
    }
    #[test]
    fn cancelled_requests_do_not_block_new_requests() {
        let mut r = sample();
        r.status = "cancelled".into();
        assert!(!same_target(&r, "tv", 10, "TV", Some(1)));
    }
    #[test]
    fn metadata_only_request_can_be_removed_without_download_cleanup() {
        let mut r = sample();
        r.status = "pick".into();
        r.service_id = Some(3);
        assert!(needs_action(&r));
        assert!(!needs_download_cleanup(&r));
        r.hash = Some("server-download-job".into());
        assert!(!needs_action(&r));
        assert!(needs_download_cleanup(&r));
    }
    #[test]
    fn auto_picking_rows_leave_the_inbox_until_handed_back() {
        let mut r = sample();
        r.status = "queued".into();
        r.auto_download = true;
        assert!(auto_picking(&r));
        r.auto_pick_note = Some("No complete season fit the budget.".into());
        assert!(!auto_picking(&r));
        r.auto_pick_note = None;
        r.error = Some("Indexer search failed.".into());
        assert!(!auto_picking(&r));
        r.error = None;
        r.status = "failed".into();
        assert!(!auto_picking(&r));
    }
    #[test]
    fn legacy_request_defaults_do_not_resubmit_existing_job() {
        let r = sample();
        assert!(!r.submitted);
        assert!(r.service_snapshot.is_none());
    }
}
