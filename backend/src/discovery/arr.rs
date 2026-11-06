use crate::qbit::{qbittorrent_all_torrents, queue_magnet_for_user, resume_qbittorrent_torrent, stop_qbittorrent_torrent, vpn_interface_is_up};
use super::requests::{Queue, Request};
use super::subscriptions;
use super::*;

struct ReleaseSearch {
    rows: Option<Vec<Value>>,
    running: bool,
    error: Option<String>,
}
static RELEASE_SEARCHES: std::sync::LazyLock<std::sync::Mutex<BTreeMap<String, ReleaseSearch>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(BTreeMap::new()));
static RELEASE_SEARCH_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static NYAA_SEARCH_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

fn cached_releases(id: &str) -> Option<Vec<Value>> {
    RELEASE_SEARCHES.lock().ok()?.get(id)?
        .rows.clone()
}

fn release_snapshot_path(state: &AppState, id: &str) -> PathBuf {
    data_path(state, "discovery-releases").join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
}
async fn read_release_snapshot(path: &std::path::Path) -> Result<Option<Vec<Value>>, (StatusCode, Json<Value>)> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| error(StatusCode::CONFLICT, "Saved torrent results are damaged. Use Refresh info to replace them.")),
        Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error(StatusCode::INTERNAL_SERVER_ERROR, "Saved torrent results could not be read.")),
    }
}
async fn saved_releases(state: &AppState, id: &str) -> Result<Option<Vec<Value>>, (StatusCode, Json<Value>)> {
    if let Some(rows) = cached_releases(id) { return Ok(Some(rows)); }
    read_release_snapshot(&release_snapshot_path(state, id)).await
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct Service {
    kind: String,
    library: String,
    url: String,
    api_key: String,
    root_folder: String,
    staging_folder: String,
    quality_profile_id: u64,
    category: String,
    enabled: bool,
    #[serde(default = "default_request_budget")]
    budget_gb: u32,
}
#[derive(Default, Deserialize, Serialize)]
struct Services {
    services: Vec<Service>,
    #[serde(default)]
    budget_policy_version: u8,
}

pub(super) const REQUEST_BUDGET_BYTES: u64 = 50 * 1024 * 1024 * 1024;
// Older builds stored this as a row error while qBittorrent was restarting.
const QBIT_UNAVAILABLE: &str = "qBittorrent is unavailable.";
fn default_request_budget() -> u32 { 50 }

pub(super) async fn tv_service_enabled(state: &AppState, library: &str) -> Result<bool, (StatusCode, Json<Value>)> {
    let config: Services = load(state, "discovery-services.json").await?;
    Ok(config.services.iter().any(|s| s.enabled && s.kind == "tv" && s.library == library))
}

pub(super) async fn initialize_budget(state: &AppState) -> Result<(), (StatusCode, Json<Value>)> {
    let mut config: Services = load(state, "discovery-services.json").await?;
    if config.budget_policy_version >= 1 { return Ok(()); }
    for service in &mut config.services { service.budget_gb = 50; }
    let mut queue: Queue = load(state, "discovery-requests.json").await?;
    for request in &mut queue.requests {
        if request.hash.is_none() && !request.submitted {
            if let Some(snapshot) = request.service_snapshot.as_mut() { snapshot["budget_gb"] = json!(50); }
        }
    }
    requests::save(state, &queue).await?;
    config.budget_policy_version = 1;
    write_persisted_json(&data_path(state, "discovery-services.json"), &config).await.map_err(internal)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/discover/services",
            axum::routing::get(list).put(configure),
        )
        .route("/api/discover/services/test", post(test_connection))
        .route(
            "/api/discover/requests/{id}/releases",
            axum::routing::get(list_releases),
        )
}
fn validate_url(value: &str) -> Result<(), (StatusCode, Json<Value>)> {
    let url = reqwest::Url::parse(value).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "Enter an http:// or https:// service URL.",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Service URLs cannot include credentials, query strings or fragments.",
        ));
    }
    Ok(())
}
async fn call(
    service: &Service,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, (StatusCode, Json<Value>)> {
    call_timed(service, method, path, body, Duration::from_secs(15)).await
}
async fn call_timed(
    service: &Service,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Value, (StatusCode, Json<Value>)> {
    validate_url(&service.url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not initialize service connection.",
            )
        })?;
    let mut request = client
        .request(
            method,
            format!("{}/api/v3/{path}", service.url.trim_end_matches('/')),
        )
        .header("X-Api-Key", &service.api_key);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "Media service is unreachable. Check its URL and retry.",
        )
    })?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "Incomplete service response."))?;
    if !status.is_success() {
        let detail = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| {
                v["message"]
                    .as_str()
                    .or(v["errorMessage"].as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(error(
            StatusCode::BAD_GATEWAY,
            format!(
                "Media service failed for {}: {detail}",
                path.split('?').next().unwrap_or(path)
            ),
        ));
    }
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "Invalid media service response."))
}
async fn get(s: &Service, path: &str) -> Result<Value, (StatusCode, Json<Value>)> {
    call(s, reqwest::Method::GET, path, None).await
}
fn public_service(s: &Service) -> Value {
    json!({"kind":s.kind,"library":s.library,"url":s.url,"root_folder":s.root_folder,"staging_folder":s.staging_folder,"quality_profile_id":s.quality_profile_id,"category":s.category,"enabled":s.enabled,"budget_gb":s.budget_gb,"key_configured":!s.api_key.is_empty()})
}
async fn list(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    admin(&state, &headers).await?;
    let config: Services = load(&state, "discovery-services.json").await?;
    Ok(Json(
        json!({"services":config.services.iter().map(public_service).collect::<Vec<_>>()}),
    ))
}
async fn merged_key(
    state: &AppState,
    mut s: Service,
) -> Result<Service, (StatusCode, Json<Value>)> {
    media_kind(&s.kind)?;
    validate_url(&s.url)?;
    if s.api_key.is_empty() {
        let config: Services = load(state, "discovery-services.json").await?;
        // Never send a saved key to a newly entered host.
        s.api_key = config
            .services
            .into_iter()
            .find(|old| old.kind == s.kind && old.library == s.library && old.url == s.url)
            .map(|old| old.api_key)
            .unwrap_or_default();
    }
    if s.api_key.trim().is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "Enter the service API key."));
    }
    Ok(s)
}
async fn test_connection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(s): Json<Service>,
) -> ApiResult<Value> {
    admin(&state, &headers).await?;
    let s = merged_key(&state, s).await?;
    let status = get(&s, "system/status").await?;
    let roots = get(&s, "rootfolder").await?;
    let profiles = get(&s, "qualityprofile").await?;
    Ok(Json(
        json!({"version":status["version"],"roots":roots,"profiles":profiles}),
    ))
}
fn normalized_path(path: &str) -> String {
    // Windows APIs accept repeated separators, but Sonarr can return a canonical
    // single-backslash path for a root TMS saved with doubled backslashes.
    // Compare path components, not the spelling of those separators.
    let value = path.replace('\\', "/");
    let value = value.trim_start_matches("//?/");
    value
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
        .to_lowercase()
}
async fn validate_service(state: &AppState, s: &Service) -> Result<(), (StatusCode, Json<Value>)> {
    if s.budget_gb == 0 || s.budget_gb > 1000 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Set a request storage budget between 1 and 1000 GiB.",
        ));
    }
    let libraries = read_libraries(state).await;
    if !libraries
        .get(&s.library)
        .is_some_and(|l| l.content_type == "movies_tv" && !l.folder_structure_static)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Choose a writable Movies & TV library.",
        ));
    }
    let tms_root = tokio::fs::canonicalize(state.library_root.join(&s.library))
        .await
        .map_err(|_| error(StatusCode::CONFLICT, "TMS library is unavailable."))?;
    let arr_root = tokio::fs::canonicalize(&s.root_folder).await.map_err(|_| {
        error(
            StatusCode::CONFLICT,
            "Service root must be a local folder accessible to TMS.",
        )
    })?;
    if tms_root != arr_root {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Service root must point to the same physical folder as the selected TMS library.",
        ));
    }
    let protected = normalized_path(&arr_root.to_string_lossy());
    let staging = tokio::fs::canonicalize(&s.staging_folder)
        .await
        .map_err(|_| {
            error(
                StatusCode::BAD_REQUEST,
                "Choose an existing download staging folder.",
            )
        })?;
    if staging.starts_with(&arr_root) || arr_root.starts_with(&staging) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Staging and library folders must be separate.",
        ));
    }
    if normalized_path(&staging.to_string_lossy()).starts_with("c:/jellyfin")
        || normalized_path(&staging.to_string_lossy()).starts_with("c:/programdata/jellyfin")
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Choose a TMS download staging folder.",
        ));
    }
    if protected == "c:/jellyfin"
        || protected.starts_with("c:/jellyfin/")
        || protected.starts_with("c:/programdata/jellyfin/")
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Use a TMS library root for automatic downloads.",
        ));
    }
    let profiles = get(s, "qualityprofile").await?;
    let profile = profiles
        .as_array()
        .and_then(|p| {
            p.iter()
                .find(|v| v["id"].as_u64() == Some(s.quality_profile_id))
        })
        .ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "Selected quality profile does not exist.",
            )
        })?;
    if profile["upgradeAllowed"] == true {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Choose a quality profile with automatic upgrades disabled.",
        ));
    }
    if s.category.is_empty() || s.category.eq_ignore_ascii_case("TMS") {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Use a separate qBittorrent category, such as tms-radarr or tms-sonarr.",
        ));
    }
    let clients = get(s, "downloadclient").await?;
    let enabled: Vec<_> = clients
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["enable"] == true)
        .collect();
    let qbit_url = state
        .qbittorrent_url
        .as_ref()
        .and_then(|u| reqwest::Url::parse(u).ok())
        .ok_or_else(|| error(StatusCode::CONFLICT, "Configure TMS qBittorrent first."))?;
    if enabled.len() != 1 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Use one enabled qBittorrent client in this service so TMS can verify ownership and quotas.",
        ));
    }
    let c = enabled[0];
    let field = |name: &str| {
        c["fields"]
            .as_array()
            .and_then(|f| f.iter().find(|f| f["name"] == name))
            .map(|f| f["value"].clone())
            .unwrap_or(Value::Null)
    };
    let host = field("host");
    let port = field("port")
        .as_u64()
        .or_else(|| field("port").as_i64().and_then(|v| u64::try_from(v).ok()))
        .or_else(|| field("port").as_str().and_then(|v| v.parse().ok()));
    let initial = field("initialState")
        .as_u64()
        .or_else(|| {
            field("initialState")
                .as_i64()
                .and_then(|v| u64::try_from(v).ok())
        })
        .or_else(|| field("initialState").as_str().and_then(|v| v.parse().ok()));
    let host_ok = host
        .as_str()
        .zip(qbit_url.host_str())
        .is_some_and(|(a, b)| {
            a.eq_ignore_ascii_case(b)
                || ["localhost", "127.0.0.1", "::1"].contains(&a)
                    && ["localhost", "127.0.0.1", "::1"].contains(&b)
        });
    if c["implementation"] != "QBittorrent"
        || field(if s.kind == "movie" {
            "movieCategory"
        } else {
            "tvCategory"
        }) != s.category
        || !host_ok
        || port != qbit_url.port_or_known_default().map(u64::from)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Service download client must use TMS's qBittorrent host/port and the specified separate category.",
        ));
    }
    if initial != Some(2) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Set the service's qBittorrent Initial State to Stopped. TMS starts each download after checking its actual size and VPN binding.",
        ));
    }
    Ok(())
}
async fn configure(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(s): Json<Service>,
) -> ApiResult<Value> {
    admin(&state, &headers).await?;
    let _run = state.discovery_lock.lock().await;
    let s = merged_key(&state, s).await?;
    if s.enabled {
        validate_service(&state, &s).await?;
    }
    let mut config: Services = load(&state, "discovery-services.json").await?;
    if config
        .services
        .iter()
        .any(|old| old.enabled && s.enabled && old.kind != s.kind && old.category == s.category)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Movies and series need different qBittorrent categories.",
        ));
    }
    config
        .services
        .retain(|old| old.kind != s.kind || old.library != s.library);
    config.services.push(s);
    write_persisted_json(&data_path(&state, "discovery-services.json"), &config)
        .await
        .map_err(internal)?;
    Ok(Json(json!({"saved":true})))
}

fn resource(kind: &str) -> &str {
    if kind == "movie" { "movie" } else { "series" }
}
async fn reserve(
    state: &AppState,
    r: &Request,
    owner: &StoredUser,
    bytes: u64,
) -> Result<(), (StatusCode, Json<Value>)> {
    let _guard = state.persistence_lock.lock().await;
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    let key = format!("discover:{}", r.id);
    if bytes == 0 {
        // Search/approval has no known payload. Drop legacy ceiling-sized
        // reservations; enforce quota when a release or metadata has a size.
        release_storage_reservation(&mut ledger, &key);
        return write_storage_ledger(&state.storage_path, &ledger).await.map_err(internal);
    }
    if !reserve_storage_with_override(
        &mut ledger,
        owner,
        &key,
        "discover",
        bytes,
        r.quota_override_by.is_some(),
    ) {
        return Err(error(
            StatusCode::CONFLICT,
            "This download exceeds the selected user's available storage quota.",
        ));
    }
    write_storage_ledger(&state.storage_path, &ledger)
        .await
        .map_err(internal)
}
async fn persist_row(state: &AppState, r: &Request) -> Result<(), (StatusCode, Json<Value>)> {
    if matches!(r.status.as_str(), "declined" | "cancelled") {
        return requests::remove(state, &r.id).await;
    }
    let mut queue: Queue = load(state, "discovery-requests.json").await?;
    if let Some(old) = queue.requests.iter_mut().find(|old| old.id == r.id) {
        *old = r.clone();
    }
    requests::save(state, &queue).await
}
async fn tag(s: &Service) -> Result<u64, (StatusCode, Json<Value>)> {
    let tags = get(s, "tag").await?;
    if let Some(id) = tags
        .as_array()
        .and_then(|a| a.iter().find(|t| t["label"] == "tms-discover"))
        .and_then(|t| t["id"].as_u64())
    {
        return Ok(id);
    }
    let value = call(
        s,
        reqwest::Method::POST,
        "tag",
        Some(json!({"label":"tms-discover"})),
    )
    .await?;
    value["id"]
        .as_u64()
        .ok_or_else(|| error(StatusCode::BAD_GATEWAY, "Service did not return a tag ID."))
}
async fn ensure_media(
    state: &AppState,
    s: &Service,
    r: &mut Request,
) -> Result<Value, (StatusCode, Json<Value>)> {
    let marker = tag(s).await?;
    let external = if r.kind == "movie" {
        r.tmdb_id
    } else {
        let detail = tmdb(state, &format!("tv/{}/external_ids", r.tmdb_id), &[]).await?;
        detail["tvdb_id"].as_u64().ok_or_else(|| {
            error(
                StatusCode::CONFLICT,
                "This series has no TVDB mapping for Sonarr.",
            )
        })?
    };
    let id_field = if r.kind == "movie" {
        "tmdbId"
    } else {
        "tvdbId"
    };
    let all = get(s, &format!("{}?{id_field}={external}", resource(&r.kind))).await?;
    let existing = all
        .as_array()
        .and_then(|a| a.iter().find(|v| v[id_field].as_u64() == Some(external)))
        .cloned();
    let media = if let Some(media) = existing {
        let path = media["path"].as_str().unwrap_or("");
        if !normalized_path(path).starts_with(&format!("{}/", normalized_path(&s.root_folder))) {
            return Err(error(
                StatusCode::CONFLICT,
                "This title is already managed in a different root folder.",
            ));
        }
        if !media["tags"]
            .as_array()
            .is_some_and(|tags| tags.iter().any(|t| t.as_u64() == Some(marker)))
        {
            return Err(error(
                StatusCode::CONFLICT,
                "This title is already managed outside TMS requests. Match its existing files in Discover first.",
            ));
        }
        media
    } else {
        let lookup = get(
            s,
            &format!(
                "{}/lookup?term={}:{external}",
                resource(&r.kind),
                if r.kind == "movie" { "tmdb" } else { "tvdb" }
            ),
        )
        .await?;
        let mut value = lookup
            .as_array()
            .and_then(|a| a.iter().find(|v| v[id_field].as_u64() == Some(external)))
            .cloned()
            .ok_or_else(|| {
                error(
                    StatusCode::CONFLICT,
                    "The service could not resolve this title.",
                )
            })?;
        value["rootFolderPath"] = json!(s.root_folder);
        value["qualityProfileId"] = json!(s.quality_profile_id);
        value["tags"] = json!([marker]);
        value["monitored"] = json!(false);
        if r.kind == "movie" {
            value["minimumAvailability"] = json!("released");
            value["addOptions"] = json!({"searchForMovie":false});
        } else {
            value["seasonFolder"] = json!(true);
            value["addOptions"] = json!({"searchForMissingEpisodes":false,"searchForCutoffUnmetEpisodes":false,"monitor":"none"});
            let japanese = value["originalLanguage"]["name"].as_str() == Some("Japanese")
                || value["originalLanguage"]["id"].as_u64() == Some(25);
            if japanese {
                value["seriesType"] = json!("anime");
            }
            if let Some(seasons) = value["seasons"].as_array_mut() {
                for season in seasons {
                    season["monitored"] = json!(false);
                }
            }
        }
        // Persist intent BEFORE the external write. A timeout is reconciled by
        // external ID, root and ownership tag on the next run.
        r.submitted = true;
        persist_row(state, r).await?;
        call(s, reqwest::Method::POST, resource(&r.kind), Some(value)).await?
    };
    r.service_id = media["id"].as_u64();
    if r.service_id.is_none() {
        return Err(error(
            StatusCode::BAD_GATEWAY,
            "Service did not return a media ID.",
        ));
    }
    persist_row(state, r).await?;
    Ok(media)
}
fn air_time(episode: &Value) -> Option<u64> {
    let parsed = time::OffsetDateTime::parse(
        episode["airDateUtc"].as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    u64::try_from(parsed.unix_timestamp()).ok()
}
// Subscriptions only follow episodes from the subscription date onward; an
// episode with no usable air date is kept so it is never silently skipped.
fn episode_should_monitor(episode: &Value, r: &Request, enabled: bool) -> bool {
    if !enabled {
        return true;
    }
    if r.monitor_future {
        return r.monitor_from.is_none_or(|from| air_time(episode).is_none_or(|air| air >= from));
    }
    episode["episodeNumber"]
        .as_u64()
        .is_some_and(|n| r.expected_episodes.contains(&(n as u16)))
}
const MONITOR_REAPPLY_SECS: u64 = 6 * 3600;
// Episodes Sonarr should already have grabbed (monitored, aired since the
// subscription began and at least an hour ago) but has no file for.
fn catch_up_episode_ids(episodes: &[Value], season: u64, from: u64, now: u64) -> Vec<u64> {
    episodes
        .iter()
        .filter(|e| e["seasonNumber"].as_u64() == Some(season))
        .filter(|e| e["monitored"] == true && e["hasFile"] != true)
        .filter(|e| air_time(e).is_some_and(|air| air >= from && air <= now.saturating_sub(3600)))
        .filter_map(|e| e["id"].as_u64())
        .collect()
}
async fn catch_up_search(s: &Service, r: &Request, now: u64) -> Result<(), (StatusCode, Json<Value>)> {
    let (Some(id), Some(season), Some(from)) = (r.service_id, r.season, r.monitor_from) else {
        return Ok(());
    };
    let episodes = get(s, &format!("episode?seriesId={id}")).await?;
    let ids = catch_up_episode_ids(episodes.as_array().map(Vec::as_slice).unwrap_or_default(), u64::from(season), from, now);
    if ids.is_empty() {
        return Ok(());
    }
    tracing::info!(request_id=%r.id, episodes=ids.len(), "Discover subscription catch-up search");
    call(s, reqwest::Method::POST, "command", Some(json!({"name":"EpisodeSearch","episodeIds":ids}))).await?;
    Ok(())
}
async fn set_monitor(
    s: &Service,
    r: &Request,
    enabled: bool,
) -> Result<(), (StatusCode, Json<Value>)> {
    let Some(id) = r.service_id else {
        return Ok(());
    };
    // Media is added unmonitored and only monitoring rows turn it on, so a
    // picked request has nothing to undo and must not unmonitor episodes a
    // subscription is following in the same season.
    if !enabled && !r.monitor_future {
        return Ok(());
    }
    let mut media = get(s, &format!("{}/{id}", resource(&r.kind))).await?;
    if r.kind == "movie" {
        media["monitored"] = json!(enabled);
    } else {
        if enabled {
            media["monitored"] = json!(true);
        }
        if let Some(seasons) = media["seasons"].as_array_mut() {
            for season in seasons {
                if season["seasonNumber"].as_u64() == r.season.map(u64::from) {
                    season["monitored"] = json!(enabled);
                }
            }
        }
        let episodes = get(s, &format!("episode?seriesId={id}")).await?;
        let ids: Vec<_> = episodes
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["seasonNumber"].as_u64() == r.season.map(u64::from))
            .filter(|e| episode_should_monitor(e, r, enabled))
            .filter_map(|e| e["id"].as_u64())
            .collect();
        if !ids.is_empty() {
            call(
                s,
                reqwest::Method::PUT,
                "episode/monitor",
                Some(json!({"episodeIds":ids,"monitored":enabled})),
            )
            .await?;
        }
    }
    call(
        s,
        reqwest::Method::PUT,
        &format!("{}/{id}", resource(&r.kind)),
        Some(media),
    )
    .await?;
    Ok(())
}
async fn queue_rows(s: &Service, r: &Request) -> Result<Vec<Value>, (StatusCode, Json<Value>)> {
    let mut page = 1;
    let mut result = vec![];
    loop {
        let data = get(
            s,
            &format!(
                "queue?page={page}&pageSize=100&includeUnknownSeriesItems=false&includeEpisode=true"
            ),
        )
        .await?;
        let rows = data["records"].as_array().ok_or_else(|| {
            error(
                StatusCode::BAD_GATEWAY,
                "Service queue response has no records.",
            )
        })?;
        for row in rows {
            let matches_id = row[if r.kind == "movie" {
                "movieId"
            } else {
                "seriesId"
            }]
            .as_u64()
                == r.service_id;
            let matches_season = r.kind == "movie"
                || row["seasonNumber"]
                    .as_u64()
                    .or(row["episode"]["seasonNumber"].as_u64())
                    == r.season.map(u64::from);
            if matches_id && matches_season {
                result.push(row.clone());
            }
        }
        if page * 100 >= data["totalRecords"].as_u64().unwrap_or(0) || rows.is_empty() {
            break;
        }
        page += 1;
        if page > 100 {
            return Err(error(
                StatusCode::BAD_GATEWAY,
                "Service queue exceeds supported pagination limit.",
            ));
        }
    }
    Ok(result)
}
const MIN_SEEDERS: u64 = 5;
fn release_seeders(value: &Value) -> u64 {
    value["seeders"]
        .as_u64()
        .or_else(|| {
            value["seeders"]
                .as_i64()
                .and_then(|n| u64::try_from(n).ok())
        })
        .unwrap_or(0)
}
fn release_size(value: &Value) -> u64 {
    value["size"]
        .as_u64()
        .or_else(|| value["size"].as_i64().and_then(|n| u64::try_from(n).ok()))
        .unwrap_or(0)
}
fn release_quality_rank(value: &Value) -> u8 {
    let quality = value["quality"]["quality"]["name"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase();
    if quality.contains("1080p") {
        3
    } else if quality.contains("2160p") || quality.contains("4k") {
        2
    } else if quality.contains("720p") {
        1
    } else {
        0
    }
}
fn release_preferred(a: &Value, b: &Value) -> std::cmp::Ordering {
    // Pairwise "twice as many peers" rules create cycles and panic Rust's
    // sorter. Fixed swarm bands retain the size preference within a healthy
    // band while providing a consistent total order across all releases.
    let key = |release: &Value| {
        let seeds = release_seeders(release);
        let quality = release_quality_rank(release);
        let healthy = seeds >= 25;
        (healthy, if healthy { quality } else { 0 },
            if healthy { u64::from((seeds / 25).ilog2()) } else { seeds },
            if healthy { 0 } else { quality }, std::cmp::Reverse(release_size(release)),
            seeds, release["approved"] == true)
    };
    key(b).cmp(&key(a)).then_with(|| a["guid"].as_str().cmp(&b["guid"].as_str()))
}
fn quality_label(value: &Value) -> String {
    let name = value["quality"]["quality"]["name"]
        .as_str()
        .unwrap_or("Unknown");
    match name {
        "Bluray-1080p" => "1080p BluRay".into(),
        "Remux-1080p" => "1080p Remux".into(),
        "WEBDL-1080p" => "1080p WEB-DL".into(),
        "WEBRip-1080p" => "1080p WEBRip".into(),
        "HDTV-1080p" => "1080p HDTV".into(),
        "Bluray-720p" => "720p BluRay".into(),
        "WEBDL-720p" => "720p WEB-DL".into(),
        "WEBRip-720p" => "720p WEBRip".into(),
        other => other.into(),
    }
}
fn format_size(bytes: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= GIB {
        format!("{:.1} GiB", bytes as f64 / GIB)
    } else {
        format!("{:.0} MiB", bytes as f64 / MIB)
    }
}
async fn service_for_request(
    state: &AppState,
    r: &Request,
) -> Result<Service, (StatusCode, Json<Value>)> {
    if let Some(snapshot) = &r.service_snapshot {
        return serde_json::from_value::<Service>(snapshot.clone()).map_err(|_| {
            error(
                StatusCode::CONFLICT,
                "Saved service configuration is invalid.",
            )
        });
    }
    let config: Services = load(state, "discovery-services.json").await?;
    config
        .services
        .into_iter()
        .find(|s| s.enabled && s.kind == r.kind && s.library == r.library)
        .ok_or_else(|| {
            error(
                StatusCode::CONFLICT,
                "Connect and enable Radarr/Sonarr for this library in Discover settings.",
            )
        })
}
fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(&xml[start..end])
}
fn parse_size_bytes(s: &str) -> u64 {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.is_empty() {
        return 0;
    }
    let num: f64 = parts[0].parse().unwrap_or(0.0);
    let unit = parts
        .get(1)
        .map(|u| u.to_ascii_uppercase())
        .unwrap_or_default();
    let multiplier: f64 = match unit.as_str() {
        "KIB" | "KB" => 1024.0,
        "MIB" | "MB" => 1024.0 * 1024.0,
        "GIB" | "GB" => 1024.0 * 1024.0 * 1024.0,
        "TIB" | "TB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (num * multiplier) as u64
}
fn detect_anime_quality(title: &str) -> &'static str {
    let lower = title.to_ascii_lowercase();
    if lower.contains("2160p") || lower.contains("4k") {
        "2160p"
    } else if lower.contains("1080p") {
        if lower.contains("remux") {
            "1080p Remux"
        } else if lower.contains("bd") || lower.contains("bluray") || lower.contains("blu-ray") {
            "1080p BluRay"
        } else if lower.contains("web-dl") || lower.contains("webdl") || lower.contains("cr web") {
            "1080p WEB-DL"
        } else if lower.contains("webrip") || lower.contains("web") {
            "1080p WEBRip"
        } else {
            "1080p"
        }
    } else if lower.contains("720p") {
        if lower.contains("bd") || lower.contains("bluray") {
            "720p BluRay"
        } else {
            "720p"
        }
    } else {
        "1080p"
    }
}
fn clean_anime_search_title(title: &str) -> String {
    let mut s = title.to_string();
    for suffix in [
        ": The Movie",
        "- The Movie",
        ": the movie",
        "- the movie",
        " The Movie",
        " the movie",
        "(The Movie)",
        "(the movie)",
    ] {
        if let Some(pos) = s.to_ascii_lowercase().find(&suffix.to_ascii_lowercase()) {
            s.truncate(pos);
            break;
        }
    }
    s = s.replace([':', '!', '?', '-', '(', ')', '[', ']'], " ");
    let cleaned = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        title.to_string()
    } else {
        cleaned
    }
}
async fn is_anime_request(state: &AppState, r: &Request) -> (bool, Vec<String>) {
    let mut titles = vec![clean_anime_search_title(&r.title)];
    if r.kind == "anime" || r.library.to_ascii_lowercase().contains("anime") {
        return (true, titles);
    }
    let catalog = if r.kind == "movie" { "movie" } else { "tv" };
    if let Ok(detail) = tmdb(
        state,
        &format!("{catalog}/{}", r.tmdb_id),
        &[("append_to_response", "alternative_titles".into())],
    )
    .await
    {
        let is_jp = detail["original_language"] == "ja"
            || detail["origin_country"]
                .as_array()
                .is_some_and(|c| c.iter().any(|x| x == "JP"));
        let is_anim = detail["genre_ids"]
            .as_array()
            .is_some_and(|g| g.iter().any(|x| x == 16))
            || detail["genres"]
                .as_array()
                .is_some_and(|g| g.iter().any(|x| x == 16 || x["id"] == 16));
        if is_jp && is_anim {
            if let Some(orig) = detail["original_title"]
                .as_str()
                .or_else(|| detail["original_name"].as_str())
            {
                let cleaned_orig = clean_anime_search_title(orig);
                if !titles.iter().any(|t| t.eq_ignore_ascii_case(&cleaned_orig)) {
                    titles.push(cleaned_orig);
                }
            }
            let alt_key = if catalog == "movie" {
                "titles"
            } else {
                "results"
            };
            if let Some(alt_list) = detail["alternative_titles"][alt_key].as_array() {
                for alt in alt_list {
                    if let Some(alt_title) = alt["title"].as_str() {
                        let cleaned_alt = clean_anime_search_title(alt_title);
                        if !cleaned_alt.is_empty()
                            && !titles.iter().any(|t| t.eq_ignore_ascii_case(&cleaned_alt))
                        {
                            titles.push(cleaned_alt);
                            if titles.len() >= 8 {
                                break;
                            }
                        }
                    }
                }
            }
            return (true, titles);
        }
    }
    (false, titles)
}
// Titles not originally in English need a release with an English audio
// track (dual audio or a dub); a subtitled-only copy does not satisfy them.
async fn needs_english_audio(state: &AppState, r: &Request) -> Result<bool, (StatusCode, Json<Value>)> {
    let catalog = if r.kind == "movie" { "movie" } else { "tv" };
    let detail = tmdb(state, &format!("{catalog}/{}", r.tmdb_id), &[]).await?;
    Ok(detail["original_language"].as_str().is_some_and(|language| language != "en"))
}
fn release_has_english_audio(release: &Value) -> bool {
    let tokens = title_tokens(release["title"].as_str().unwrap_or(""));
    let pair = |first: &str, second: &[&str]| tokens.windows(2).any(|w| w[0] == first && second.contains(&w[1].as_str()));
    tokens.iter().any(|t| matches!(t.as_str(), "dual" | "dualaudio" | "dub" | "dubs" | "dubbed" | "multiaudio"))
        || pair("multi", &["audio"])
        || pair("triple", &["audio"])
        || pair("english", &["audio", "dub"])
        || pair("eng", &["audio", "dub"])
        // Arr parses audio languages; more than one including English is dual audio.
        || release["languages"].as_array().is_some_and(|languages| languages.len() > 1
            && languages.iter().any(|language| language["name"] == "English"))
}
fn english_audio_first(english: bool, a: &Value, b: &Value) -> std::cmp::Ordering {
    if english { release_has_english_audio(b).cmp(&release_has_english_audio(a)) } else { std::cmp::Ordering::Equal }
}
fn nyaa_matches_season(title: &str, season: u16) -> bool {
    let tokens = title_tokens(title);
    let specials = tokens.iter().any(|t| matches!(t.as_str(), "special" | "specials" | "extras" | "ova" | "mini"));
    let mut seasons = release_seasons(title);
    for (i, token) in tokens.iter().enumerate() {
        if let Some(n) = token.strip_prefix('s').and_then(|rest| rest.split('e').next()).and_then(|n| n.parse::<u16>().ok()) { seasons.insert(n); }
        if token == "season" && i > 0 {
            let ordinal = tokens[i-1].trim_end_matches(|c: char| c.is_ascii_alphabetic());
            if let Ok(n) = ordinal.parse::<u16>() { seasons.insert(n); }
        }
    }
    if season == 0 { return specials || seasons.contains(&0); }
    if specials && !seasons.contains(&season) { return false; }
    if seasons.is_empty() { season == 1 } else { seasons.contains(&season) }
}
fn nyaa_title(raw: &str) -> String {
    raw.trim().trim_start_matches("<![CDATA[").trim_end_matches("]]>")
        .replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
        .replace("&lt;", "<").replace("&gt;", ">")
}
async fn fetch_nyaa_releases(
    state: &AppState,
    r: &Request,
    titles: &[String],
    budget: u64,
) -> Vec<Value> {
    let Ok(_slot) = NYAA_SEARCH_SLOTS.acquire().await else { return vec![]; };
    let mut queries = Vec::new();
    for clean in titles {
        let query = if r.kind == "tv" {
            if let Some(season) = r.season {
                if season > 1 {
                    format!("{clean} S{season:02}")
                } else {
                    clean.clone()
                }
            } else {
                clean.clone()
            }
        } else {
            clean.clone()
        };
        if !queries
            .iter()
            .any(|q: &String| q.eq_ignore_ascii_case(&query))
        {
            queries.push(query);
        }
    }
    let mut results = vec![];
    let mut seen_hashes = std::collections::BTreeSet::new();
    for query in queries {
        let url = format!(
            "https://nyaa.si/?page=rss&q={}&c=1_2&f=0",
            urlencoding::encode(&query)
        );
        let Ok(resp) = state
            .http
            .get(&url)
            // Nyaa is a supplementary source. Keep individual title lookups
            // short so alternate anime names cannot make the picker time out.
            .timeout(Duration::from_secs(5))
            .send()
            .await
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(body) = resp.text().await else {
            continue;
        };
        let mut cursor = 0;
        while let Some(item_start) = body[cursor..].find("<item>") {
            let actual_start = cursor + item_start;
            let Some(item_end_rel) = body[actual_start..].find("</item>") else {
                break;
            };
            let actual_end = actual_start + item_end_rel + 7;
            let item_xml = &body[actual_start..actual_end];
            cursor = actual_end;

            let Some(title) = xml_tag(item_xml, "title") else {
                continue;
            };
            let title = nyaa_title(title);
            if r.kind != "movie" && r.season.is_some_and(|season| !nyaa_matches_season(&title, season)) { continue; }
            let Some(info_hash) = xml_tag(item_xml, "nyaa:infoHash") else {
                continue;
            };
            let clean_hash = info_hash.trim().to_ascii_lowercase();
            if !seen_hashes.insert(clean_hash) {
                continue;
            }
            let seeders: u64 = xml_tag(item_xml, "nyaa:seeders")
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            let leechers: u64 = xml_tag(item_xml, "nyaa:leechers")
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            let size_str = xml_tag(item_xml, "nyaa:size").unwrap_or("");
            let size = parse_size_bytes(size_str);
            if size == 0 || size > budget {
                continue;
            }
            let download_url = xml_tag(item_xml, "link").unwrap_or("").trim().to_string();
            let pub_date = xml_tag(item_xml, "pubDate")
                .unwrap_or("")
                .trim()
                .to_string();
            let magnet = format!(
                "magnet:?xt=urn:btih:{}&dn={}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce",
                info_hash.trim(),
                urlencoding::encode(title.trim())
            );
            let quality_name = detect_anime_quality(&title);
            results.push(json!({
                "guid": magnet,
                "indexerId": 9999,
                "protocol": "torrent",
                "title": title.trim(),
                "indexer": "Nyaa.si",
                "size": size,
                "seeders": seeders,
                "leechers": leechers,
                "publishDate": pub_date,
                "approved": true,
                "seasonNumber": r.season,
                "fullSeason": title_tokens(&title).iter().any(|t| matches!(t.as_str(), "batch" | "complete")),
                "downloadUrl": download_url,
                "magnetUrl": magnet,
                "quality": {
                    "quality": {
                        "name": quality_name
                    }
                }
            }));
        }
        // The primary title normally finds the show. Avoid serial alias queries
        // once this season has usable candidates.
        if !results.is_empty() { break; }
    }
    results
}
fn title_tokens(value: &str) -> Vec<String> {
    value
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}
fn release_seasons(title: &str) -> BTreeSet<u16> {
    let lower = title.to_ascii_lowercase();
    let tokens = title_tokens(title);
    if tokens.iter().any(|t| t == "episode" || t == "episodes"
        || t.strip_prefix('e').is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
        || (t.starts_with('s') && t.contains('e') && t.chars().any(|c| c.is_ascii_digit()))) {
        return BTreeSet::new();
    }
    let mut markers: Vec<(u16, usize, usize)> = Vec::new();
    let mut offset = 0;
    for (i, token) in tokens.iter().enumerate() {
        let start = offset + lower[offset..].find(token.as_str()).unwrap_or(0);
        let end = start + token.len();
        let number = token.strip_prefix('s').and_then(|n| n.parse::<u16>().ok())
            .or_else(|| (i > 0 && matches!(tokens[i-1].as_str(), "season" | "seasons")).then(|| token.parse::<u16>().ok()).flatten());
        if let Some(n) = number.filter(|n| *n <= 100) { markers.push((n, start, end)); }
        else if markers.last().is_some_and(|(_, _, previous_end)| matches!(lower[*previous_end..start].trim(), "-" | "to" | "&" | "and" | ",")) {
            if let Ok(n) = token.parse::<u16>() { if n <= 100 { markers.push((n, start, end)); } }
        }
        offset = end;
    }
    let mut seasons: BTreeSet<u16> = markers.iter().map(|(n, _, _)| *n).collect();
    for pair in markers.windows(2) {
        if matches!(lower[pair[0].2..pair[1].1].trim(), "-" | "to") && pair[0].0 <= pair[1].0 {
            seasons.extend(pair[0].0..=pair[1].0);
        }
    }
    if tokens.iter().any(|t| t == "specials" || t == "extras") { seasons.insert(0); }
    seasons
}
fn release_is_season_pack(title: &str, season: u16) -> bool {
    release_seasons(title).contains(&season)
}
fn release_matches_season(title: &str, season: u16) -> bool {
    if release_is_season_pack(title, season) { return true; }
    let tokens = title_tokens(title);
    let episode_seasons: BTreeSet<u16> = tokens.iter().enumerate().filter_map(|(i, token)| {
        let rest = token.strip_prefix('s')?;
        let (number, episode) = rest.split_once('e').or_else(|| {
            tokens.get(i + 1)?.strip_prefix('e').map(|episode| (rest, episode))
        })?;
        if episode.is_empty() || !episode.starts_with(|c: char| c.is_ascii_digit()) { return None; }
        number.parse::<u16>().ok()
    }).collect();
    episode_seasons == BTreeSet::from([season])
}
fn leading_number(text: &str) -> Option<(u16, &str)> {
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || digits > 4 { return None; }
    Some((text[..digits].parse().ok()?, &text[digits..]))
}
// Episode numbers a release carries for one season: `S01E05`, `S01 E05`,
// `S01E05E06` and ranges such as `S01E05-E07` or `S01E05-07`. A release that
// also names another season carries no episodes for this season.
fn release_episodes(title: &str, season: u16) -> BTreeSet<u16> {
    let lower = title.to_ascii_lowercase();
    let mut spans = vec![];
    let mut start = None;
    for (i, c) in lower.char_indices() {
        if c.is_ascii_alphanumeric() { start.get_or_insert(i); } else if let Some(s) = start.take() { spans.push((s, i)); }
    }
    if let Some(s) = start { spans.push((s, lower.len())); }
    let token = |i: usize| &lower[spans[i].0..spans[i].1];
    let (mut seasons, mut episodes) = (BTreeSet::new(), BTreeSet::new());
    let mut i = 0;
    while i < spans.len() {
        let current = token(i);
        i += 1;
        let Some((number, rest)) = current.strip_prefix('s').and_then(leading_number) else { continue };
        let mut marker = rest;
        if marker.is_empty() && i < spans.len() && token(i).starts_with('e') {
            marker = token(i);
            i += 1;
        }
        let mut last = None;
        while let Some((episode, rest)) = marker.strip_prefix('e').and_then(leading_number) {
            episodes.insert(episode);
            last = Some(episode);
            marker = rest;
        }
        let Some(mut last) = last else { continue };
        while i < spans.len() && lower[spans[i - 1].1..spans[i].0].trim() == "-" {
            let text = token(i);
            let Some((end, "")) = leading_number(text.strip_prefix('e').unwrap_or(text)) else { break };
            if end <= last || end - last > 200 { break; }
            episodes.extend(last + 1..=end);
            last = end;
            i += 1;
        }
        seasons.insert(number);
    }
    if seasons == BTreeSet::from([season]) { episodes } else { BTreeSet::new() }
}
// Sonarr rows also carry parsed episode numbers when the title is unusual.
fn release_episode_set(release: &Value, season: u16) -> BTreeSet<u16> {
    let parsed = release_episodes(release["title"].as_str().unwrap_or(""), season);
    if !parsed.is_empty() || release["fullSeason"] == true || release["seasonNumber"].as_u64() != Some(u64::from(season)) {
        return parsed;
    }
    release["episodeNumbers"].as_array().into_iter().flatten()
        .filter_map(|n| n.as_u64().and_then(|n| u16::try_from(n).ok()))
        .collect()
}
fn release_names_show(title: &str, request: &Request) -> bool {
    let lower = title.to_ascii_lowercase();
    let mut words = title_tokens(&request.title);
    words.retain(|word| word.len() >= 4);
    words.dedup();
    !words.is_empty() && words.iter().all(|word| lower.contains(word.as_str()))
}
fn release_has_hd_resolution(title: &str) -> bool {
    let lower = title.to_ascii_lowercase();
    ["2160p", "1080p", "720p", "4k"]
        .iter()
        .any(|marker| lower.contains(marker))
}
fn indexer_field<'a>(indexer: &'a Value, name: &str) -> Option<&'a str> {
    indexer["fields"]
        .as_array()
        .and_then(|fields| fields.iter().find(|item| item["name"] == name))
        .and_then(|item| item["value"].as_str())
}
fn is_masked_secret(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty() || trimmed.chars().all(|c| c == '*')
}
fn url_origin(value: &reqwest::Url) -> String {
    let mut origin = value.clone();
    origin.set_path("");
    origin.set_query(None);
    origin.set_fragment(None);
    origin.to_string().trim_end_matches('/').to_owned()
}
fn prowlarr_indexer_route(base_url: &str) -> Option<(String, String)> {
    let url = reqwest::Url::parse(base_url).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let id = url
        .path_segments()?
        .find(|part| !part.is_empty())?
        .to_owned();
    if !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((url_origin(&url), id))
}
fn prowlarr_api_key_from_rows(rows: &[Value], origin: &str) -> Option<String> {
    rows.iter().find_map(|row| {
        ["downloadUrl", "magnetUrl", "infoUrl"]
            .iter()
            .find_map(|key| {
                let url = reqwest::Url::parse(row[*key].as_str()?).ok()?;
                if url_origin(&url) != origin {
                    return None;
                }
                url.query_pairs()
                    .find(|(name, value)| {
                        name.eq_ignore_ascii_case("apikey") && !is_masked_secret(value)
                    })
                    .map(|(_, value)| value.into_owned())
            })
    })
}
async fn local_prowlarr_api_key(origin: &str) -> Option<String> {
    // Sonarr masks indexer keys. A local Windows Prowlarr installation can
    // supply its own key even when Sonarr's release search is unavailable.
    // Never send this local credential to a remote or differently configured port.
    let url = reqwest::Url::parse(origin).ok()?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")) {
        return None;
    }
    let root = std::env::var_os("PROGRAMDATA")?;
    let config = tokio::fs::read_to_string(PathBuf::from(root).join("Prowlarr/config.xml")).await.ok()?;
    let value = |tag: &str| -> Option<String> {
        let start = format!("<{tag}>");
        let end = format!("</{tag}>");
        Some(config.split_once(&start)?.1.split_once(&end)?.0.trim().to_owned())
    };
    let port = value("Port")?.parse::<u16>().ok()?;
    if url.port_or_known_default() != Some(port) { return None; }
    value("ApiKey").filter(|key| !is_masked_secret(key))
}
fn release_magnet(release: &Value) -> Option<String> {
    for key in ["guid", "magnetUrl", "downloadUrl"] {
        if let Some(value) = release[key].as_str() {
            let trimmed = value.trim();
            if trimmed.to_ascii_lowercase().starts_with("magnet:") {
                return Some(trimmed.to_owned());
            }
        }
    }
    let hash = release["infoHash"].as_str()?.trim();
    if hash.len() != 40 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let title = release["title"].as_str().unwrap_or("");
    Some(format!(
        "magnet:?xt=urn:btih:{}&dn={}",
        hash.to_ascii_uppercase(),
        urlencoding::encode(title)
    ))
}
async fn fetch_prowlarr_season_releases(
    s: &Service,
    r: &Request,
    budget: u64,
    sonarr_rows: &[Value],
) -> Vec<Value> {
    if r.kind != "tv" {
        return vec![];
    }
    let Some(season) = r.season else {
        return vec![];
    };
    let Ok(indexers) = get(s, "indexer").await else {
        tracing::warn!(request_id=%r.id, "Discover could not list indexers for the Prowlarr season-pack search");
        return vec![];
    };
    let mut origin = String::new();
    let mut indexer_ids: Vec<String> = vec![];
    let mut configured_key: Option<String> = None;
    for indexer in indexers.as_array().into_iter().flatten() {
        let Some((candidate, id)) =
            indexer_field(indexer, "baseUrl").and_then(prowlarr_indexer_route)
        else {
            continue;
        };
        if origin.is_empty() {
            origin = candidate.clone();
        }
        if candidate != origin {
            continue;
        }
        if !indexer_ids.contains(&id) {
            indexer_ids.push(id);
        }
        if configured_key.is_none() {
            configured_key = indexer_field(indexer, "apiKey")
                .filter(|key| !is_masked_secret(key))
                .map(str::to_owned);
        }
    }
    if origin.is_empty() || indexer_ids.is_empty() {
        tracing::warn!(request_id=%r.id, "Discover found no Prowlarr-backed indexers for the season-pack search");
        return vec![];
    }
    // Sonarr redacts indexer secrets as asterisks, so recover the Prowlarr key
    // from the download links it already handed back for the same host.
    let Some(api_key) = configured_key.or_else(|| prowlarr_api_key_from_rows(sonarr_rows, &origin))
        .or(local_prowlarr_api_key(&origin).await)
    else {
        tracing::warn!(request_id=%r.id, %origin, "Discover has no usable Prowlarr API key for the season-pack search");
        return vec![];
    };
    let Ok(endpoint) = reqwest::Url::parse(&format!("{origin}/api/v1/search")) else {
        return vec![];
    };
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // The picker also reads the Arr release feed and Nyaa where relevant.
        // Do not let one optional season-pack lookup consume the whole
        // request's gateway budget.
        .timeout(Duration::from_secs(60))
        .build()
    {
        Ok(client) => client,
        Err(_) => return vec![],
    };
    let mut query: Vec<(&str, String)> = vec![("query", title_tokens(&r.title).join(" "))];
    for id in &indexer_ids {
        query.push(("indexerIds", id.clone()));
    }
    let response = match client
        .get(endpoint)
        .header("X-Api-Key", &api_key)
        .query(&query)
        .send()
        .await
    {
        Ok(response) => response,
        Err(problem) => {
            tracing::warn!(request_id=%r.id, %origin, error=%problem, "Discover Prowlarr season-pack search failed");
            return vec![];
        }
    };
    let status = response.status();
    if !status.is_success() {
        tracing::warn!(request_id=%r.id, %origin, status=%status, "Discover Prowlarr season-pack search was rejected");
        return vec![];
    }
    let Ok(releases) = response.json::<Vec<Value>>().await else {
        tracing::warn!(request_id=%r.id, %origin, "Discover could not parse the Prowlarr season-pack search response");
        return vec![];
    };
    let mut named_show = 0usize;
    let mut season_matches = 0usize;
    let mut within_budget = 0usize;
    let mut packs = vec![];
    for release in &releases {
        let Some(title) = release["title"].as_str().map(str::trim) else {
            continue;
        };
        if release["protocol"]
            .as_str()
            .is_some_and(|protocol| protocol != "torrent")
        {
            continue;
        }
        if !release_names_show(title, r) {
            continue;
        }
        named_show += 1;
        if !release_matches_season(title, season) {
            continue;
        }
        season_matches += 1;
        let size = release_size(release);
        if size == 0 || size > budget {
            continue;
        }
        within_budget += 1;
        if !release_has_hd_resolution(title) {
            continue;
        }
        let Some(magnet) = release_magnet(release) else {
            continue;
        };
        packs.push(json!({
            "guid":magnet.clone(),"indexerId":release["indexerId"],"protocol":"torrent","title":title,
            "indexer":release["indexer"].as_str().unwrap_or("Prowlarr"),"size":size,
            "seeders":release_seeders(release),"leechers":release["leechers"],"publishDate":release["publishDate"],
            "approved":true,"downloadUrl":"","magnetUrl":magnet,
            "fullSeason":release_is_season_pack(title, season),"seasonNumber":season,
            "quality":{"quality":{"name":detect_anime_quality(title)}}
        }));
    }
    tracing::info!(
        request_id=%r.id, season, indexers=indexer_ids.len(), returned=releases.len(),
        named_show, season_matches, within_budget, usable=packs.len(),
        "Discover Prowlarr season release search response"
    );
    packs
}
async fn fetch_release_rows(
    state: &AppState,
    s: &Service,
    r: &Request,
) -> Result<Vec<Value>, (StatusCode, Json<Value>)> {
    let id = r.service_id.ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "Media is not registered with the download service yet. Wait a moment and refresh.",
        )
    })?;
    // Sonarr's unscoped series release feed also includes stale, unrelated RSS
    // entries.  The season-specific feed includes matching season and complete
    // series packs without exposing those unrelated magnets.
    let paths = if r.kind == "movie" {
        vec![format!("release?movieId={id}")]
    } else {
        let season = r.season.ok_or_else(|| {
            error(
                StatusCode::CONFLICT,
                "Season is required for series searches.",
            )
        })?;
        vec![format!("release?seriesId={id}&seasonNumber={season}")]
    };
    let budget = u64::from(s.budget_gb) * 1024 * 1024 * 1024;
    let (is_anime, anime_titles) = is_anime_request(state, r).await;
    let english = needs_english_audio(state, r).await.unwrap_or(false);
    // Usable means seeded and, for foreign titles, carrying English audio.
    let usable = |rows: &[Value]| rows.iter().any(|row| release_seeders(row) >= MIN_SEEDERS
        && (!english || release_has_english_audio(row)));
    let mut nyaa_releases = if is_anime { fetch_nyaa_releases(state, r, &anime_titles, budget).await } else { vec![] };
    if is_anime && english && !nyaa_releases.iter().any(release_has_english_audio) {
        // The plain title search stops at its first page of results, which
        // can be all subtitled releases. Ask for dual audio explicitly.
        let dual_titles: Vec<String> = anime_titles.iter().map(|title| format!("{title} dual audio")).collect();
        for release in fetch_nyaa_releases(state, r, &dual_titles, budget).await {
            if !nyaa_releases.iter().any(|existing| existing["guid"] == release["guid"]) {
                nyaa_releases.push(release);
            }
        }
    }
    // Anime has a direct source; do not queue it behind general Arr searches
    // unless Nyaa lacks the English audio this title needs.
    if !nyaa_releases.is_empty() && (!english || usable(&nyaa_releases)) {
        let mut rows = nyaa_releases;
        rows.sort_by(|a, b| english_audio_first(english, a, b)
            .then_with(|| release_sort_rank(b).cmp(&release_sort_rank(a)))
            .then_with(|| release_preferred(a, b)));
        tracing::info!(request_id=%r.id, releases=rows.len(), "Discover direct Nyaa search resolved");
        return Ok(rows);
    }
    let _slot = RELEASE_SEARCH_SLOTS.acquire().await.map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "Release search unavailable."))?;
    // Search Prowlarr directly first: Sonarr's season feed can miss individual
    // episodes and stall on multi-season packs that have usable magnets.
    let mut rows = fetch_prowlarr_season_releases(s, r, budget, &[]).await;
    for release in nyaa_releases {
        let hash = release["guid"].as_str().and_then(release_hash);
        if !rows.iter().any(|existing| existing["guid"].as_str().and_then(release_hash) == hash) {
            rows.push(release);
        }
    }
    let paths = if usable(&rows) { vec![] } else { paths };
    let mut source_rows = vec![];
    let mut seen = BTreeSet::new();
    for path in paths {
        let releases = match call_timed(
            s,
            reqwest::Method::GET,
            &path,
            None,
            // Arr performs an indexer search here. This runs behind the
            // background cache, so slow trackers cannot hold the UI request.
            Duration::from_secs(60),
        )
        .await {
            Ok(releases) => releases,
            Err(problem) => {
                // A stalled Arr release cache must not suppress direct
                // Prowlarr and Nyaa candidates. Those sources are especially
                // important for anime such as Sonny Boy.
                tracing::warn!(request_id=%r.id, path=%path, message=?problem.1["message"], "Discover Arr release feed unavailable; using fallback sources");
                continue;
            }
        };
        for release in releases.as_array().into_iter().flatten() {
            source_rows.push(release.clone());
            let is_mismatch = release["rejections"].as_array().is_some_and(|rejs| {
                rejs.iter().any(|rej| {
                    let text = rej.as_str().unwrap_or("");
                    text.contains("Unknown Movie")
                        || text.contains("Unknown Series")
                        || text.contains("Unable to match to correct movie")
                        || text.contains("Unable to match to correct series")
                        || text.contains("Wrong season")
                })
            });
            let guid = release["guid"].as_str().unwrap_or("");
            let magnet = release_magnet(release);
            if !is_mismatch
                && magnet.is_some()
                && release["protocol"] == "torrent"
                && release_size(release) > 0
                && release_size(release) <= budget
                && seen.insert(guid.to_owned())
            {
                let mut usable = release.clone();
                usable["magnetUrl"] = json!(magnet);
                rows.push(usable);
            }
        }
    }
    // Ask Prowlarr for the show by name as well, preserving matching episodes
    // and packs that Sonarr's TVDB-driven season search never returns.
    let prowlarr_packs = if source_rows.is_empty() { vec![] } else {
        fetch_prowlarr_season_releases(s, r, budget, &source_rows).await
    };
    for release in prowlarr_packs {
        let Some(guid) = release["guid"].as_str().map(str::to_owned) else {
            continue;
        };
        let hash = release_hash(&guid);
        let duplicate = hash.is_some()
            && rows
                .iter()
                .any(|existing| existing["guid"].as_str().and_then(release_hash) == hash);
        if !duplicate && seen.insert(guid) {
            rows.push(release);
        }
    }
    rows.sort_by(|a, b| {
        // Foreign titles list English-audio releases ahead of subtitled ones.
        match english_audio_first(english, a, b) {
            std::cmp::Ordering::Equal => {}
            other => return other,
        }
        // Season/series packs still win for TV requests. Movies skip that boost
        // so a "collection" title cannot bury the actual film release.
        if r.kind == "tv" {
            match release_sort_rank(b).cmp(&release_sort_rank(a)) {
                std::cmp::Ordering::Equal => {}
                other => return other,
            }
        }
        // Grab goes straight to Server Download via magnet, so Radarr's
        // approved/blocklist flag is only a soft tie-break — never a hard gate
        // that hides a 385-seeder YIFY behind dead "approved" remuxes.
        release_preferred(a, b)
    });
    Ok(rows)
}
fn release_sort_rank(release: &Value) -> u8 {
    // Whole-season packs are what a season request actually needs, so they
    // outrank single episodes even when an episode has more seeders.
    match series_pack_score(release) {
        0 if release["fullSeason"] == true => 1,
        0 => 0,
        score => score + 1,
    }
}
fn series_pack_score(release: &Value) -> u8 {
    let title = release["title"].as_str().unwrap_or("").to_ascii_lowercase();
    if title.contains("complete series")
        || title.contains("complete seasons")
        || title.contains("all seasons")
        || title.split(|c: char| !c.is_ascii_alphanumeric()).any(|word| word == "collection")
    {
        2
    } else if release_seasons(&title).iter().filter(|season| **season > 0).count() > 1 {
        1
    } else {
        0
    }
}
fn release_option(release: &Value, option: usize, recommended: bool) -> Value {
    let size = release_size(release);
    json!({
        "option": option,
        "recommended": recommended,
        "guid": release["guid"],
        "indexer_id": release["indexerId"],
        "title": release["title"].as_str().unwrap_or("Untitled"),
        "quality": quality_label(release),
        "size": size,
        "size_label": format_size(size),
        "seeders": release_seeders(release),
        "leechers": release["leechers"].as_u64().or_else(||release["leechers"].as_i64().and_then(|n|u64::try_from(n).ok())).unwrap_or(0),
        "indexer": release["indexer"].as_str().unwrap_or(""),
        "published": release["publishDate"].as_str().unwrap_or("").chars().take(10).collect::<String>(),
        "approved": release["approved"]==true,
        "series_pack": series_pack_score(release)>0,
        "season_pack": release_sort_rank(release)==1,
        "covered_seasons": release_seasons(release["title"].as_str().unwrap_or("")),
        "english_audio": release_has_english_audio(release),
    })
}
pub async fn list_releases(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<BTreeMap<String, String>>,
) -> ApiResult<Value> {
    let caller = user(&state, &headers).await?;
    if !caller.is_admin {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Only full administrators can view request releases.",
        ));
    }
    let queue: Queue = load(&state, "discovery-requests.json").await?;
    let r = queue
        .requests
        .iter()
        .find(|r| r.id == id)
        .cloned()
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Request not found."))?;
    tracing::info!(request_id=%id, title=%r.title, status=%r.status, torrent_hash=?r.torrent_hash, "Discover list_releases start");
    if !visible(&caller, &read_libraries(&state).await, &r.library) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "You cannot manage this request.",
        ));
    }
    if !can_search_releases(&r)
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Releases can only be chosen while this request is waiting for a torrent.",
        ));
    }
    let s = service_for_request(&state, &r).await?;
    if r.service_id.is_none() {
        return Ok(Json(json!({"budget_gb":s.budget_gb,"searching":true,"releases":[]})));
    }
    // The Arr release endpoint performs the search itself. Starting a second
    // SeasonSearch command here duplicates every indexer query and stalls
    // automatic loading when multiple requested seasons appear together.
    let force = query.get("refresh").is_some_and(|value| value == "1");
    let saved = match saved_releases(&state, &id).await {
        Ok(saved) => saved,
        Err(_) if force => cached_releases(&id),
        Err(problem) => return Err(problem),
    };
    let (rows, start_search, searching, search_error) = {
        let mut searches = RELEASE_SEARCHES.lock().map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Release search cache unavailable"))?;
        let existing = searches.get(&id);
        if existing.is_some_and(|search| search.running) {
            (existing.and_then(|search| search.rows.clone()), false, true, None)
        } else if saved.is_some() && !force {
            (saved.clone(), false, false, existing.and_then(|search| search.error.clone()))
        } else {
            searches.insert(id.clone(), ReleaseSearch { rows: saved.clone(), running: true, error: None });
            (saved, true, true, None)
        }
    };
    if start_search { start_release_search(&state, &s, &r); }
    let Some(rows) = rows else {
        return Ok(Json(json!({"budget_gb":s.budget_gb,"searching":true,"releases":[]})));
    };
    tracing::info!(request_id=%id, release_count=rows.len(), "Discover list_releases fetched");
    for (i, release) in rows.iter().take(10).enumerate() {
        tracing::info!(
            request_id=%id,
            option=i+1,
            title=?release["title"].as_str(),
            info_hash=?release["guid"].as_str().and_then(release_hash),
            guid_prefix=?release["guid"].as_str().map(|g|g.chars().take(96).collect::<String>()),
            seeders=release_seeders(release),
            size=release_size(release),
            indexer=?release["indexer"].as_str(),
            "Discover list_releases option"
        );
    }
    let recommended_guid = rows
        .iter()
        .filter(|release| release_seeders(release) >= MIN_SEEDERS)
        .next()
        .and_then(|release| release["guid"].as_str())
        .map(str::to_owned);
    let options: Vec<_> = rows
        .into_iter()
        .take(40)
        .enumerate()
        .map(|(i, release)| {
            let recommended = recommended_guid.as_deref() == release["guid"].as_str();
            release_option(&release, i + 1, recommended)
        })
        .collect();
    Ok(Json(
        json!({"budget_gb":s.budget_gb,"min_seeders":MIN_SEEDERS,"releases":options,"searching":searching,"error":search_error}),
    ))
}
fn can_search_releases(r: &Request) -> bool {
    r.hash.is_none() && r.subscription_id.is_none() && matches!(r.status.as_str(), "pending" | "queued" | "pick" | "failed" | "searching")
}
fn clear_preselection_quota_failure(r: &mut Request) -> bool {
    if r.status != "failed" || r.hash.is_some() || r.torrent_hash.is_some()
        || r.search_started || r.expected_bytes.is_some()
        || r.error.as_deref() != Some("The request budget exceeds the requesting user's available storage quota.") {
        return false;
    }
    r.status = if r.approved_by.is_some() { "queued" } else { "pending" }.into();
    r.error = None;
    true
}

// Register an unmonitored title and query indexers independently of approval
// and storage reservations. This never starts a payload download.
async fn prepare_release_search(state: &AppState, r: &mut Request) -> Result<(), (StatusCode, Json<Value>)> {
    let s = service_for_request(state, r).await?;
    if r.service_id.is_none() {
        validate_service(state, &s).await?;
        r.service_snapshot = Some(serde_json::to_value(&s).unwrap());
        ensure_media(state, &s, r).await?;
    }
    if let Some(rows) = saved_releases(state, &r.id).await? {
        // Preserve useful results, but an empty search is not permanent proof
        // that a title has no releases. Recheck it as new episodes appear.
        let recent = tokio::fs::metadata(release_snapshot_path(state, &r.id)).await.ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age < Duration::from_secs(300));
        if !rows.is_empty() || recent { return Ok(()); }
    }
    let start = {
        let mut searches = RELEASE_SEARCHES.lock().map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Release search cache unavailable"))?;
        if searches.get(&r.id).is_some_and(|search| search.running) { false }
        else { searches.insert(r.id.clone(), ReleaseSearch { rows: None, running: true, error: None }); true }
    };
    if start { start_release_search(state, &s, r); }
    Ok(())
}

// Drop saved results so the next auto pick searches again and sees episodes
// released since the last search. A search already running stays.
pub(super) async fn forget_releases(state: &AppState, id: &str) {
    if let Ok(mut searches) = RELEASE_SEARCHES.lock() {
        if searches.get(id).is_some_and(|search| search.running) { return; }
        searches.remove(id);
    }
    if let Err(problem) = tokio::fs::remove_file(release_snapshot_path(state, id)).await {
        if problem.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(request_id=%id, error=%problem, "Could not clear saved Discover release results");
        }
    }
}
fn start_release_search(state: &AppState, s: &Service, r: &Request) {
        let search_state = state.clone();
        let search_service = s.clone();
        let search_request = r.clone();
        tokio::spawn(async move {
            let worker_state = search_state.clone();
            let worker_request = search_request.clone();
            let result = tokio::spawn(async move {
                validate_service(&worker_state, &search_service).await?;
                fetch_release_rows(&worker_state, &search_service, &worker_request).await
            }).await;
            let result = match result {
                Ok(result) => result,
                Err(problem) => {
                    tracing::warn!(request_id=%search_request.id, error=%problem, "Discover release search worker failed");
                    Err(error(StatusCode::BAD_GATEWAY, "Torrent search failed. Use Refresh info to try again."))
                }
            };
            let result = match result {
                Ok(rows) => write_persisted_json(&release_snapshot_path(&search_state, &search_request.id), &rows)
                    .await.map(|_| rows).map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Torrent results could not be saved. Use Refresh info to try again.")),
                Err(problem) => Err(problem),
            };
            if let Ok(mut searches) = RELEASE_SEARCHES.lock() {
                if let Some(search) = searches.get_mut(&search_request.id) {
                    search.running = false;
                    match result {
                        Ok(rows) => { search.rows = Some(rows); search.error = None; }
                        Err((_, Json(problem))) => {
                            search.rows.get_or_insert_with(Vec::new);
                            search.error = problem["message"].as_str().map(str::to_owned);
                        }
                    }
                }
            }
        });
}

fn automatic_release_seasons(r: &Request, release: &Value) -> BTreeSet<u16> {
    let mut seasons = release_seasons(release["title"].as_str().unwrap_or(""));
    if seasons.is_empty() && series_pack_score(release) > 0 && r.auto_download_complete_series {
        seasons = r.auto_download_seasons.clone();
    } else if seasons.is_empty() && release["fullSeason"] == true && series_pack_score(release) == 0
        && release["seasonNumber"].as_u64() == r.season.map(u64::from) {
        if let Some(season) = r.season { seasons.insert(season); }
    }
    seasons
}
fn join_numbers(numbers: &BTreeSet<u16>) -> String {
    numbers.iter().map(u16::to_string).collect::<Vec<_>>().join(", ")
}
fn release_basic_rejection(release: &Value, budget: u64) -> Option<String> {
    let size = release_size(release);
    let seeds = release_seeders(release);
    if size == 0 {
        Some("size unknown".into())
    } else if size > budget {
        Some(format!("{} exceeds the {} budget", format_size(size), format_size(budget)))
    } else if seeds < MIN_SEEDERS {
        Some(format!("only {seeds} seeders (needs {MIN_SEEDERS})"))
    } else if release_magnet(release).is_none() {
        Some("no magnet link".into())
    } else if release["guid"].as_str().is_none() || release["indexerId"].as_u64().is_none() {
        Some("missing release identifiers".into())
    } else {
        None
    }
}
// Why a release cannot be the single automatic download for this request:
// a movie, or a complete season/series pack covering only finished requested
// seasons. `None` means it is eligible.
fn automatic_rejection(r: &Request, release: &Value, english: bool) -> Option<String> {
    if let Some(problem) = release_basic_rejection(release, REQUEST_BUDGET_BYTES) {
        return Some(problem);
    }
    if english && !release_has_english_audio(release) {
        return Some("no English audio (needs dual audio or an English dub)".into());
    }
    if r.kind == "movie" {
        let quality = release["quality"]["quality"]["name"].as_str().unwrap_or("").to_ascii_lowercase();
        let title = release["title"].as_str().unwrap_or("").to_ascii_lowercase();
        let camera = ["cam", "telesync", "telecine", "hdts", "hdcam"].iter().any(|bad| quality.contains(bad) || title_tokens(&title).iter().any(|word| word == bad))
            || matches!(quality.as_str(), "ts" | "tc");
        return camera.then(|| "camera or telesync quality".into());
    }
    let Some(season) = r.season else { return Some("request has no season".into()) };
    let seasons = automatic_release_seasons(r, release);
    if !seasons.contains(&season) {
        return Some(if release_episode_set(release, season).is_empty() {
            format!("not a complete Season {season} release")
        } else {
            "episode release; used only when no complete season qualifies".into()
        });
    }
    if !r.auto_download_seasons.contains(&season) {
        return Some(format!("Season {season} has not finished airing, so a season release cannot be complete"));
    }
    let extra: BTreeSet<u16> = seasons.difference(&r.auto_download_seasons).copied().collect();
    (!extra.is_empty()).then(|| format!("also includes season(s) {} that are not requested or still airing", join_numbers(&extra)))
}
#[cfg(test)]
fn automatic_candidate(r: &Request, release: &Value) -> bool {
    automatic_rejection(r, release, false).is_none()
}
// Mirrors `release_sort_rank` and `release_preferred`, so the log explains
// where a release sits in the ranking without re-deriving the sort.
fn release_rank_reason(r: &Request, release: &Value) -> String {
    let seeds = release_seeders(release);
    let shape = if r.kind == "movie" {
        "movie release".to_owned()
    } else {
        match series_pack_score(release) {
            2 => "complete-series pack".to_owned(),
            1 => "multi-season pack".to_owned(),
            _ if release_sort_rank(release) == 1 => "complete season".to_owned(),
            _ => match r.season.map(|season| release_episode_set(release, season)) {
                Some(episodes) if !episodes.is_empty() => format!("episode(s) {}", join_numbers(&episodes)),
                _ => "unrecognized release".to_owned(),
            },
        }
    };
    let swarm = if seeds >= 25 { "healthy swarm" } else { "small swarm" };
    format!("{shape}, {seeds} seeders ({swarm}), {}, {}", quality_label(release), format_size(release_size(release)))
}
const RANKING_RULE: &str = "foreign titles require English audio (dual audio or a dub); whole seasons and packs outrank episodes; then healthy swarms (25+ seeders) first, preferring 1080p over 2160p over 720p, then more seeders, then the smaller download";

struct EpisodePlan {
    picks: Vec<(usize, BTreeSet<u16>)>,
    missing: BTreeSet<u16>,
    // Every row carrying episodes of the season: index, episodes, outcome.
    outcomes: Vec<(usize, BTreeSet<u16>, String)>,
}
// Rows arrive ranked best-first, so each needed episode takes the first
// eligible release that only carries still-needed episodes and keeps the
// total within the request budget.
fn plan_episode_releases(rows: &[Value], season: u16, needed: &BTreeSet<u16>, budget: u64, english: bool) -> EpisodePlan {
    let candidates: Vec<(usize, BTreeSet<u16>, Option<String>)> = rows.iter().enumerate().filter_map(|(i, release)| {
        if release_sort_rank(release) > 0 { return None; }
        let episodes = release_episode_set(release, season);
        if episodes.is_empty() { return None; }
        let rejection = release_basic_rejection(release, budget)
            .or_else(|| (english && !release_has_english_audio(release))
                .then(|| "no English audio (needs dual audio or an English dub)".into()))
            .or_else(|| (!episodes.is_subset(needed))
            .then(|| "includes episodes that are already in the library or not aired yet".into()));
        Some((i, episodes, rejection))
    }).collect();
    let mut remaining = needed.clone();
    let mut total = 0u64;
    let mut picks: Vec<(usize, BTreeSet<u16>)> = vec![];
    let mut over_budget = BTreeSet::new();
    for episode in needed {
        if !remaining.contains(episode) { continue; }
        let mut choice = None;
        for (i, episodes, rejection) in &candidates {
            if rejection.is_some() || !episodes.contains(episode) || !episodes.is_subset(&remaining) { continue; }
            if total.saturating_add(release_size(&rows[*i])) > budget {
                over_budget.insert(*i);
                continue;
            }
            choice = Some((*i, episodes.clone()));
            break;
        }
        if let Some((i, episodes)) = choice {
            total += release_size(&rows[i]);
            remaining.retain(|e| !episodes.contains(e));
            picks.push((i, episodes));
        }
    }
    let outcomes = candidates.into_iter().map(|(i, episodes, rejection)| {
        let outcome = if picks.iter().any(|(picked, _)| *picked == i) {
            "won: best-ranked eligible release for these episodes".to_owned()
        } else if let Some(rejection) = rejection {
            format!("rejected: {rejection}")
        } else if over_budget.contains(&i) {
            "rejected: would push the selected episodes past the budget".to_owned()
        } else {
            "lost: a better-ranked release already covers these episodes".to_owned()
        };
        (i, episodes, outcome)
    }).collect();
    EpisodePlan { picks, missing: remaining, outcomes }
}
fn aired_before(episode: &Value, today: &str, cutoff: Option<&str>) -> bool {
    episode["air_date"].as_str().filter(|d| d.len() >= 10).is_some_and(|d| {
        let date = &d[..10];
        date <= today && cutoff.is_none_or(|cutoff| date < cutoff)
    })
}
async fn library_episodes(state: &AppState, r: &Request, files: &[(String, u64)]) -> Result<BTreeSet<u16>, (StatusCode, Json<Value>)> {
    let Some(season) = r.season else { return Ok(BTreeSet::new()) };
    let matches: Matches = load(state, "discovery-matches.json").await?;
    let paths: Vec<String> = matches.titles.into_iter()
        .filter(|m| m.kind == "tv" && m.tmdb_id == r.tmdb_id && (m.path == r.library || m.path.starts_with(&format!("{}/", r.library))))
        .map(|m| m.path)
        .collect();
    let scan_state = state.clone();
    let mut all: Vec<(String, u64)> = tokio::task::spawn_blocking(move || paths.iter().flat_map(|path| local_files(&scan_state, path)).collect())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Could not read title inventory."))?;
    all.extend_from_slice(files);
    Ok(inventory(&all).remove(&season).unwrap_or_default())
}
// Leave a request for an administrator after auto pick could not finish it.
fn hand_back_to_admin(r: &mut Request, note: String) {
    tracing::info!(request_id=%r.id, title=%r.title, season=?r.season, note=%note, "Discover auto pick handed request back to an administrator");
    r.status = "pick".into();
    r.auto_download = false;
    r.auto_pick_note = Some(note);
}

async fn try_automatic_download(state: &AppState, s: &Service, r: &mut Request, files: &[(String, u64)]) -> Result<(), (StatusCode, Json<Value>)> {
    let today = time::OffsetDateTime::now_utc().date().to_string();
    // Before a digital release the only torrents are camera copies and fakes.
    if r.kind == "movie" {
        let dates = tmdb(state, &format!("movie/{}/release_dates", r.tmdb_id), &[]).await?;
        if !eligibility::digital_movie(&dates, &today) {
            r.auto_pick_note = Some("Waiting for a digital release before auto pick searches.".into());
            return Ok(());
        }
    }
    r.auto_pick_note = None;
    // Read the same durable search results as the administrator picker.
    // A search runs outside the request lock and a subsequent tick grabs it.
    let Some(rows) = saved_releases(state, &r.id).await? else {
        let start = {
            let mut searches = RELEASE_SEARCHES.lock().map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Release search cache unavailable"))?;
            if searches.get(&r.id).is_some_and(|search| search.running) { false } else {
                searches.insert(r.id.clone(), ReleaseSearch { rows: None, running: true, error: None });
                true
            }
        };
        if start { start_release_search(state, s, r); }
        r.status = "searching".into();
        return Ok(());
    };
    let season_detail =if let Some(season) = r.season.filter(|_| r.kind == "tv") {
        let detail = tmdb(state, &format!("tv/{}", r.tmdb_id), &[]).await?;
        let season_detail = tmdb(state, &format!("tv/{}/season/{season}", r.tmdb_id), &[]).await?;
        // A season that finished airing after the request was made can now
        // be satisfied by a complete season release.
        if eligibility::completed_season(&detail, &season_detail, &today) {
            r.auto_download_seasons.insert(season);
        }
        Some((season, season_detail))
    } else {
        None
    };
    let english = needs_english_audio(state, r).await?;
    tracing::info!(request_id=%r.id, title=%r.title, season=?r.season, options=rows.len(), finished_seasons=?r.auto_download_seasons, english_audio_required=english, "Discover auto pick evaluating options");
    let winner = rows.iter().position(|release| automatic_rejection(r, release, english).is_none());
    for (i, release) in rows.iter().enumerate() {
        let outcome = match automatic_rejection(r, release, english) {
            _ if winner == Some(i) => "won".to_owned(),
            Some(reason) => format!("rejected: {reason}"),
            None => "lost: eligible but ranked below the winner".to_owned(),
        };
        tracing::info!(request_id=%r.id, option=i+1, title=?release["title"].as_str(), indexer=?release["indexer"].as_str(), rank=%release_rank_reason(r, release), outcome=%outcome, "Discover auto pick option");
    }
    if let Some(i) = winner {
        let release = &rows[i];
        tracing::info!(request_id=%r.id, option=i+1, title=?release["title"].as_str(),
            reason=%format!("highest-ranked eligible option ({}); ranking: {RANKING_RULE}", release_rank_reason(r, release)),
            "Discover auto pick winner");
        let guid = release["guid"].as_str().unwrap().to_owned();
        let indexer = release["indexerId"].as_u64().unwrap();
        let seasons = automatic_release_seasons(r, release);
        grab_selected_release(state, r, &guid, indexer, false).await?;
        requests::finish_download_handoff(state, r, &seasons).await?;
        tracing::info!(request_id=%r.id, title=%r.title, "Eligible request automatically handed to Server Download");
        return Ok(());
    }
    let Some((season, season_detail)) = season_detail else {
        let audio = if english { " with English audio" } else { "" };
        hand_back_to_admin(r, format!("Auto pick found no release{audio} with at least {MIN_SEEDERS} seeders that fits the 50 GiB budget. Choose a torrent below."));
        return Ok(());
    };
    // No complete season qualifies: download each aired episode instead.
    // Episodes from the day a subscription began are Sonarr's to grab.
    let cutoff = subscriptions::monitor_cutoff(state, r.tmdb_id, &r.library).await?;
    let all: BTreeSet<u16> = season_detail["episodes"].as_array().into_iter().flatten()
        .filter_map(|e| e["episode_number"].as_u64().and_then(|n| u16::try_from(n).ok()))
        .collect();
    let aired: BTreeSet<u16> = season_detail["episodes"].as_array().into_iter().flatten()
        .filter(|e| aired_before(e, &today, cutoff.as_deref()))
        .filter_map(|e| e["episode_number"].as_u64().and_then(|n| u16::try_from(n).ok()))
        .collect();
    let later: BTreeSet<u16> = all.difference(&aired).copied().collect();
    let have = library_episodes(state, r, files).await?;
    let needed: BTreeSet<u16> = aired.difference(&have).copied().collect();
    tracing::info!(request_id=%r.id, season, aired=%join_numbers(&aired), in_library=%join_numbers(&have), needed=%join_numbers(&needed),
        left_for_subscription=%join_numbers(&later), subscription_from=?cutoff, "Discover auto pick found no complete season; picking individual episodes");
    let followed = cutoff.is_some() || later.is_empty();
    if needed.is_empty() {
        if !followed {
            hand_back_to_admin(r, format!("No episodes of Season {season} have aired yet and no subscription is following this show."));
            return Ok(());
        }
        tracing::info!(request_id=%r.id, season, "Discover auto pick has nothing aired to download; the subscription follows new episodes");
        requests::finish_download_handoff(state, r, &BTreeSet::new()).await?;
        return Ok(());
    }
    let plan = plan_episode_releases(&rows, season, &needed, REQUEST_BUDGET_BYTES, english);
    for (i, episodes, outcome) in &plan.outcomes {
        tracing::info!(request_id=%r.id, option=i+1, episodes=%join_numbers(episodes), title=?rows[*i]["title"].as_str(), rank=%release_rank_reason(r, &rows[*i]), outcome=%outcome, "Discover auto pick episode option");
    }
    for (i, episodes) in &plan.picks {
        tracing::info!(request_id=%r.id, option=i+1, episodes=%join_numbers(episodes), title=?rows[*i]["title"].as_str(),
            reason=%format!("best-ranked eligible release for episode(s) {} ({}); ranking: {RANKING_RULE}", join_numbers(episodes), release_rank_reason(r, &rows[*i])),
            "Discover auto pick episode winner");
    }
    if !plan.missing.is_empty() {
        tracing::info!(request_id=%r.id, season, episodes=%join_numbers(&plan.missing), "Discover auto pick found no eligible release for some episodes");
    }
    if plan.picks.is_empty() {
        let audio = if english { " with English audio" } else { "" };
        hand_back_to_admin(r, format!("Auto pick found no complete Season {season} release or episode release{audio} with at least {MIN_SEEDERS} seeders within the 50 GiB budget. Choose a torrent below."));
        return Ok(());
    }
    let mut queued = BTreeSet::new();
    let mut failures = vec![];
    for (i, episodes) in &plan.picks {
        match queue_release(state, s, r, &rows[*i], false).await {
            Ok((_, hash, _)) => {
                tracing::info!(request_id=%r.id, hash=%hash, episodes=%join_numbers(episodes), "Discover auto pick queued episode release");
                queued.extend(episodes.iter().copied());
            }
            // Nothing is queued yet, so retry the whole pick on a later tick.
            Err(problem) if queued.is_empty() && failures.is_empty() && problem.0 != StatusCode::CONFLICT => return Err(problem),
            Err((_, Json(problem))) => {
                let message = problem["message"].as_str().unwrap_or("it could not be queued").to_owned();
                tracing::warn!(request_id=%r.id, episodes=%join_numbers(episodes), message=%message, "Discover auto pick could not queue episode release");
                failures.push(format!("episode(s) {}: {message}", join_numbers(episodes)));
            }
        }
    }
    let unqueued: BTreeSet<u16> = needed.difference(&queued).copied().collect();
    if unqueued.is_empty() && followed {
        requests::finish_download_handoff(state, r, &BTreeSet::new()).await?;
        tracing::info!(request_id=%r.id, title=%r.title, season, episodes=%join_numbers(&queued), "Aired episodes automatically handed to Server Download");
        return Ok(());
    }
    let mut note = vec![];
    if !queued.is_empty() { note.push(format!("Auto pick queued episode(s) {}.", join_numbers(&queued))); }
    if !plan.missing.is_empty() { note.push(format!("No eligible release for episode(s) {}.", join_numbers(&plan.missing))); }
    for failure in failures { note.push(format!("Could not queue {failure}.")); }
    note.push(if unqueued.is_empty() {
        format!("Episode(s) {} have not aired and no subscription is following this show.", join_numbers(&later))
    } else {
        "Choose a torrent below for the rest.".to_owned()
    });
    hand_back_to_admin(r, note.join(" "));
    Ok(())
}

fn release_hash(guid: &str) -> Option<String> {
    magnet_info_hash(guid).or_else(|| {
        let trimmed = guid.trim();
        (trimmed.len() == 40 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| trimmed.to_ascii_lowercase())
    })
}
fn qbit_has_hash(torrents: &[QbittorrentTorrent], category: &str, hash: &str) -> bool {
    torrents
        .iter()
        .any(|t| t.category == category && t.hash.eq_ignore_ascii_case(hash))
}
pub async fn grab_selected_release(
    state: &AppState,
    r: &mut Request,
    guid: &str,
    indexer_id: u64,
    queued_by_full_admin: bool,
) -> Result<BTreeSet<u16>, (StatusCode, Json<Value>)> {
    tracing::info!(request_id=%r.id, title=%r.title, service_id=?r.service_id, indexer_id, guid=%guid, info_hash=?release_hash(guid), "Discover grab_selected_release start");
    let s = service_for_request(state, r).await?;
    tracing::info!(request_id=%r.id, service_url=%s.url, category=%s.category, budget_gb=s.budget_gb, "Discover grab using service snapshot");
    validate_service(state, &s).await?;
    if r.service_id.is_none() {
        tracing::info!(request_id=%r.id, "Discover grab registering media with service");
        ensure_media(state, &s, r).await?;
        tracing::info!(request_id=%r.id, service_id=?r.service_id, "Discover grab media registered");
    }
    let releases = saved_releases(state, &r.id).await?.ok_or_else(|| error(StatusCode::CONFLICT, "No saved torrent results. Use Refresh info before choosing a torrent."))?;
    tracing::info!(request_id=%r.id, release_count=releases.len(), "Discover grab fetched release rows");
    let release=releases.iter().find(|row|row["guid"].as_str()==Some(guid)&&row["indexerId"].as_u64()==Some(indexer_id))
        .ok_or_else(||{
            tracing::warn!(request_id=%r.id, indexer_id, guid=%guid, "Discover grab selected release missing from refreshed list");
            error(StatusCode::CONFLICT,"That release is no longer available. Refresh the list and pick again.")
        })?;
    let (magnet, hash, size) = queue_release(state, &s, r, release, queued_by_full_admin).await?;
    // `hash` puts this request under the established Server Download watcher.
    // The Arr worker intentionally skips it, so it cannot create a second
    // qBittorrent entry in the separate tms-radarr/tms-sonarr categories.
    r.hash = Some(hash.clone());
    r.expected_bytes = Some(size);
    r.grab_guid = Some(magnet);
    r.torrent_hash = Some(hash);
    r.search_started = true;
    r.submitted = true;
    r.status = "downloading".into();
    r.error = None;
    tracing::info!(request_id=%r.id, torrent_hash=?r.torrent_hash, expected_bytes=?r.expected_bytes, status=%r.status, "Discover grab_selected_release complete");
    Ok(release_seasons(release["title"].as_str().unwrap_or("")))
}
// Hand one saved release to Server Download for the request's download user.
// Returns the magnet, its info hash and the release size.
async fn queue_release(
    state: &AppState,
    s: &Service,
    r: &Request,
    release: &Value,
    queued_by_full_admin: bool,
) -> Result<(String, String, u64), (StatusCode, Json<Value>)> {
    let guid = release["guid"].as_str().unwrap_or("");
    let title = release["title"].as_str().unwrap_or("");
    let download_url = release["downloadUrl"].as_str().unwrap_or("");
    let magnet_url = release["magnetUrl"].as_str().unwrap_or("");
    let size = release_size(release);
    let seeds = release_seeders(release);
    let info_hash = release_hash(guid);
    tracing::info!(
        request_id=%r.id,
        title=%title,
        size,
        seeds,
        approved=release["approved"]==true,
        protocol=?release["protocol"].as_str(),
        indexer=?release["indexer"].as_str(),
        info_hash=?info_hash,
        guid=%guid,
        download_url=%download_url,
        magnet_url=%magnet_url,
        "Discover grab selected release details"
    );
    let budget = u64::from(s.budget_gb) * 1024 * 1024 * 1024;
    if size == 0 || size > budget {
        tracing::warn!(request_id=%r.id, size, budget, "Discover grab rejected by budget");
        return Err(error(
            StatusCode::CONFLICT,
            format!(
                "That release does not fit the {} GiB request budget.",
                s.budget_gb
            ),
        ));
    }
    let magnet = [guid, magnet_url, download_url]
        .into_iter()
        .find(|value| {
            value
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("magnet:")
        })
        .ok_or_else(|| {
            error(
                StatusCode::CONFLICT,
                "This release did not provide a magnet link for Server Download.",
            )
        })?;
    let hash = magnet_info_hash(magnet).ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "This release returned an invalid magnet link.",
        )
    })?;
    let owner = read_users(&state.users_path)
        .await
        .into_iter()
        .find(|user| user.id == r.download_user_id())
        .ok_or_else(|| error(StatusCode::CONFLICT, "Request owner no longer exists."))?;
    let destination = requests::destination(state, &owner, &r.library).await?;
    tracing::info!(
        request_id=%r.id,
        hash=%hash,
        destination=%r.library,
        "Discover handing selected magnet to the Server Download pipeline"
    );
    let (status, response) = queue_magnet_for_user(
        state.clone(),
        owner,
        MagnetDownloadRequest {
            magnet: magnet.to_owned(),
            destination_path: r.library.clone(),
        },
        Some(destination),
        // The service budget is a release-size ceiling, not storage consumed by
        // every selected release. Reserve the known size; metadata rechecks it.
        Some((format!("discover:{}", r.id), size, budget)),
        queued_by_full_admin,
        r.quota_override_by.is_some(),
    )
    .await;
    if !status.is_success() {
        return Err(error(status, response.0.message));
    }
    Ok((magnet.to_owned(), hash, size))
}
async fn abandon_dead_grabs(
    state: &AppState,
    s: &Service,
    r: &mut Request,
    rows: &[Value],
    owned: &[&QbittorrentTorrent],
) -> Result<bool, (StatusCode, Json<Value>)> {
    let now = unix_now();
    for t in owned {
        tracing::info!(request_id=%r.id, hash=%t.hash, state=%t.state, size=t.size, seeds=t.num_seeds, added_on=t.added_on, age_secs=now.saturating_sub(t.added_on), "Discover abandon_dead_grabs inspect");
    }
    let dead = owned.iter().any(|t| {
        t.size == 0
            && t.num_seeds == 0
            && t.added_on > 0
            && now.saturating_sub(t.added_on) >= 180
            && matches!(
                t.state.to_ascii_lowercase().as_str(),
                "stoppeddl" | "pauseddl" | "stoppedup" | "pausedup"
            )
    });
    if !dead {
        return Ok(false);
    }
    tracing::warn!(request_id=%r.id, owned=owned.len(), rows=rows.len(), "Discover abandoning dead grabs");
    for row in rows {
        let Some(id) = row["id"].as_u64() else {
            continue;
        };
        tracing::info!(request_id=%r.id, queue_id=id, "Discover deleting dead queue row");
        call(
            s,
            reqwest::Method::DELETE,
            &format!("queue/{id}?removeFromClient=true&blocklist=true"),
            None,
        )
        .await?;
    }
    if let Some(hash) = r.torrent_hash.clone() {
        if let Ok(session) = connect_qbittorrent(state).await {
            let _ = qbit_request(state, &session, reqwest::Method::POST, "torrents/delete")
                .form(&[("hashes", hash.as_str()), ("deleteFiles", "true")])
                .send()
                .await;
            tracing::info!(request_id=%r.id, hash=%hash, "Discover deleted dead client torrent");
        }
    }
    if r.subscription_id.is_some() {
        // Sonarr blocklisted the release above and searches for another.
        r.status = "monitoring".into();
        r.error = None;
        return Ok(true);
    }
    r.search_started = false;
    r.status = "pick".into();
    r.grab_guid = None;
    r.torrent_hash = None;
    r.error = Some("Previous release had no working seeders. Pick another torrent.".into());
    Ok(true)
}
async fn imported_files(
    state: &AppState,
    s: &Service,
    r: &Request,
    media: &Value,
) -> Result<Vec<(String, u64)>, (StatusCode, Json<Value>)> {
    let files = if r.kind == "movie" {
        get(s, &format!("moviefile?movieId={}", r.service_id.unwrap())).await?
    } else {
        get(
            s,
            &format!("episodefile?seriesId={}", r.service_id.unwrap()),
        )
        .await?
    };
    let base = media["path"].as_str().unwrap_or("");
    let mut result = vec![];
    for file in files.as_array().into_iter().flatten() {
        if r.kind == "tv" && file["seasonNumber"].as_u64() != r.season.map(u64::from) {
            continue;
        }
        let path = if let Some(path) = file["path"].as_str() {
            PathBuf::from(path)
        } else {
            PathBuf::from(base).join(file["relativePath"].as_str().unwrap_or(""))
        };
        let Ok(canonical) = tokio::fs::canonicalize(&path).await else {
            continue;
        };
        let root = tokio::fs::canonicalize(&s.root_folder)
            .await
            .map_err(|_| error(StatusCode::CONFLICT, "Import root is unavailable."))?;
        let Ok(relative) = canonical.strip_prefix(root) else {
            continue;
        };
        let logical = format!(
            "{}/{}",
            r.library,
            relative.to_string_lossy().replace('\\', "/")
        );
        if !safe_relative_path(&logical) || !is_video_file(&canonical) {
            continue;
        }
        if let Ok(meta) = tokio::fs::metadata(state.library_root.join(&logical)).await {
            if meta.is_file() && meta.len() > 0 {
                result.push((logical, meta.len()));
            }
        }
    }
    Ok(result)
}
async fn account(
    state: &AppState,
    r: &Request,
    files: &[(String, u64)],
    complete: bool,
) -> Result<(), (StatusCode, Json<Value>)> {
    let _guard = state.persistence_lock.lock().await;
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    let mut matches: Matches = load(state, "discovery-matches.json").await?;
    for (path, bytes) in files {
        if !ledger
            .allocations
            .iter()
            .any(|a| a.path == *path && a.trash_id.is_none())
        {
            ledger.allocations.push(StorageAllocation {
                id: uuid::Uuid::new_v4().to_string(),
                user_id: r.download_user_id(),
                source: "discover".into(),
                path: path.clone(),
                bytes: *bytes,
                created_at: unix_now(),
                trash_id: None,
                job_id: Some(r.id.clone()),
            });
        }
        if !matches.titles.iter().any(|m| m.path == *path) {
            matches.titles.push(TitleMatch {
                kind: r.kind.clone(),
                tmdb_id: r.tmdb_id,
                path: path.clone(),
            });
        }
    }
    if complete && !r.monitor_future {
        release_storage_reservation(&mut ledger, &format!("discover:{}", r.id));
    }
    write_storage_ledger(&state.storage_path, &ledger)
        .await
        .map_err(internal)?;
    write_persisted_json(&data_path(state, "discovery-matches.json"), &matches)
        .await
        .map_err(internal)
}
pub(super) async fn release_request_reservation(
    state: &AppState,
    r: &Request,
) -> Result<(), (StatusCode, Json<Value>)> {
    let _guard = state.persistence_lock.lock().await;
    let mut ledger = read_storage_ledger(&state.storage_path).await;
    release_storage_reservation(&mut ledger, &format!("discover:{}", r.id));
    write_storage_ledger(&state.storage_path, &ledger)
        .await
        .map_err(internal)
}
async fn remove_request_from_download_clients(
    state: &AppState,
    s: &Service,
    r: &Request,
    rows: &[Value],
    delete_files: bool,
) -> Result<(), (StatusCode, Json<Value>)> {
    let mut hashes: BTreeSet<String> = rows
        .iter()
        .filter_map(|row| row["downloadId"].as_str().map(str::to_lowercase))
        .collect();
    if let Some(hash) = r.torrent_hash.as_ref() {
        hashes.insert(hash.to_lowercase());
    }
    let session = connect_qbittorrent(state).await.map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "Could not connect to qBittorrent to clean up the request.",
        )
    })?;
    let torrents = qbittorrent_all_torrents(state, &session)
        .await
        .map_err(|_| {
            error(
                StatusCode::BAD_GATEWAY,
                "Could not read qBittorrent while cleaning up the request.",
            )
        })?;
    for hash in hashes.iter().filter(|hash| {
        torrents.iter().any(|torrent| {
            torrent.category == s.category && torrent.hash.eq_ignore_ascii_case(hash)
        })
    }) {
        let response = qbit_request(state, &session, reqwest::Method::POST, "torrents/delete")
            .form(&[
                ("hashes", hash.as_str()),
                ("deleteFiles", if delete_files { "true" } else { "false" }),
            ])
            .send()
            .await
            .map_err(|_| {
                error(
                    StatusCode::BAD_GATEWAY,
                    "Could not remove the finished request from qBittorrent.",
                )
            })?;
        if !response.status().is_success() {
            return Err(error(
                StatusCode::BAD_GATEWAY,
                "Could not remove the finished request from qBittorrent.",
            ));
        }
        tracing::info!(request_id=%r.id, hash=%hash, delete_files, "Discover removed request torrent from qBittorrent");
    }
    for row in rows {
        let Some(id) = row["id"].as_u64() else {
            continue;
        };
        // Clearing the service queue prevents Radarr/Sonarr from restoring a
        // torrent that the user deliberately removed from qBittorrent.
        call(
            s,
            reqwest::Method::DELETE,
            &format!("queue/{id}?removeFromClient=true&blocklist=false"),
            None,
        )
        .await?;
    }
    Ok(())
}
fn qbit_request(
    state: &AppState,
    session: &QbittorrentSession,
    method: reqwest::Method,
    path: &str,
) -> reqwest::RequestBuilder {
    let request = state
        .qbittorrent_http
        .request(method, format!("{}/api/v2/{path}", session.base_url))
        .header(reqwest::header::REFERER, &session.base_url);
    if let Some(cookie) = &session.cookie {
        request.header(reqwest::header::COOKIE, cookie)
    } else {
        request
    }
}
fn metadata_handoff_allowed(value: &Value, s: &Service) -> bool {
    value["category"] == s.category
        && value["size"]
            .as_u64()
            .or_else(|| value["size"].as_i64().and_then(|n| u64::try_from(n).ok()))
            .unwrap_or(0)
            == 0
        && value["completed"]
            .as_u64()
            .or_else(|| {
                value["completed"]
                    .as_i64()
                    .and_then(|n| u64::try_from(n).ok())
            })
            .unwrap_or(0)
            == 0
        && matches!(
            value["state"].as_str(),
            Some("stoppedDL" | "pausedDL" | "stoppedUP" | "pausedUP")
        )
        && value["magnet_uri"].as_str().is_some_and(|m| !m.is_empty())
        && value["magnet_uri"]
            .as_str()
            .and_then(magnet_info_hash)
            .is_some_and(|h| {
                value["hash"]
                    .as_str()
                    .is_some_and(|x| x.eq_ignore_ascii_case(&h))
            })
}
async fn fetch_metadata(
    state: &AppState,
    s: &Service,
    r: &mut Request,
    session: &QbittorrentSession,
    hashes: &BTreeSet<String>,
) -> Result<(), (StatusCode, Json<Value>)> {
    let raw: Value = qbit_request(state, session, reqwest::Method::GET, "torrents/info")
        .send()
        .await
        .map_err(|_| {
            error(
                StatusCode::BAD_GATEWAY,
                "Could not inspect pending torrent metadata.",
            )
        })?
        .error_for_status()
        .map_err(|_| {
            error(
                StatusCode::BAD_GATEWAY,
                "qBittorrent rejected metadata inspection.",
            )
        })?
        .json()
        .await
        .map_err(|_| {
            error(
                StatusCode::BAD_GATEWAY,
                "Invalid torrent metadata response.",
            )
        })?;
    for value in raw.as_array().into_iter().flatten() {
        let Some(hash) = value["hash"].as_str() else {
            continue;
        };
        if hashes.contains(&hash.to_lowercase())
            && metadata_handoff_allowed(value, s)
            && !r.metadata_handoffs.contains_key(hash)
        {
            r.metadata_handoffs.insert(
                hash.into(),
                json!({"magnet":value["magnet_uri"],"save_path":s.staging_folder}),
            );
        }
    }
    if r.metadata_handoffs.is_empty() {
        return Ok(());
    }
    persist_row(state, r).await?;
    for (hash, data) in r.metadata_handoffs.clone() {
        let existing = raw.as_array().and_then(|rows| {
            rows.iter().find(|v| {
                v["hash"]
                    .as_str()
                    .is_some_and(|h| h.eq_ignore_ascii_case(&hash))
            })
        });
        if let Some(value) = existing {
            if !metadata_handoff_allowed(value, s) {
                if value["category"] == s.category {
                    r.metadata_handoffs.remove(&hash);
                    persist_row(state, r).await?;
                    continue;
                }
                return Err(error(
                    StatusCode::CONFLICT,
                    "Pending torrent ownership changed. Review this request before retrying.",
                ));
            }
            let response = qbit_request(state, session, reqwest::Method::POST, "torrents/delete")
                .form(&[("hashes", hash.as_str()), ("deleteFiles", "false")])
                .send()
                .await
                .map_err(|_| {
                    error(
                        StatusCode::BAD_GATEWAY,
                        "Could not prepare metadata-only download.",
                    )
                })?;
            if !response.status().is_success() {
                return Err(error(
                    StatusCode::BAD_GATEWAY,
                    "qBittorrent could not prepare the empty magnet.",
                ));
            }
        }
        let form = reqwest::multipart::Form::new()
            .text("urls", data["magnet"].as_str().unwrap_or("").to_owned())
            .text("savepath", s.staging_folder.clone())
            .text("category", s.category.clone())
            .text("autoTMM", "false")
            .text("paused", "false")
            .text("stopped", "false")
            .text("stopCondition", "MetadataReceived");
        let response = qbit_request(state, session, reqwest::Method::POST, "torrents/add")
            .multipart(form)
            .send()
            .await
            .map_err(|_| {
                error(
                    StatusCode::BAD_GATEWAY,
                    "Metadata submission interrupted; TMS will reconcile the saved magnet.",
                )
            })?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() || !body.trim().is_empty() && body.trim() != "Ok." {
            return Err(error(
                StatusCode::BAD_GATEWAY,
                "qBittorrent rejected the metadata-only magnet.",
            ));
        }
        r.metadata_handoffs.remove(&hash);
        persist_row(state, r).await?;
    }
    Ok(())
}
async fn process(
    state: &AppState,
    r: &mut Request,
    config: &Services,
) -> Result<(), (StatusCode, Json<Value>)> {
    tracing::info!(request_id=%r.id, title=%r.title, status=%r.status, search_started=r.search_started, torrent_hash=?r.torrent_hash, grab_guid=?r.grab_guid.as_ref().map(|g|g.chars().take(120).collect::<String>()), expected_bytes=?r.expected_bytes, "Discover process tick start");
    let owner = read_users(&state.users_path)
        .await
        .into_iter()
        .find(|u| u.id == r.download_user_id())
        .ok_or_else(|| error(StatusCode::CONFLICT, "Request owner no longer exists."))?;
    requests::destination(state, &owner, &r.library).await?;
    let mut s = if let Some(snapshot) = &r.service_snapshot {
        serde_json::from_value::<Service>(snapshot.clone()).map_err(|_| {
            error(
                StatusCode::CONFLICT,
                "Saved service configuration is invalid.",
            )
        })?
    } else {
        let Some(s) = config
            .services
            .iter()
            .find(|s| s.enabled && s.kind == r.kind && s.library == r.library)
            .cloned()
        else {
            r.error=Some("Connect and enable Radarr/Sonarr for this library in Discover settings, or attach a magnet.".into());
            return Ok(());
        };
        validate_service(state, &s).await?;
        r.service_snapshot = Some(serde_json::to_value(&s).unwrap());
        persist_row(state, r).await?;
        s
    };
    if r.auto_download && s.budget_gb != 50 {
        s.budget_gb = 50;
        r.service_snapshot = Some(serde_json::to_value(&s).unwrap());
        persist_row(state, r).await?;
    }
    if r.status == "cancelling" {
        tracing::info!(request_id=%r.id, "Discover process cancelling");
        if r.service_id.is_none() && r.submitted {
            ensure_media(state, &s, r).await?;
        }
        set_monitor(&s, r, false).await?;
        if r.service_id.is_some() {
            let rows = queue_rows(&s, r).await?;
            if !rows.is_empty() {
                let session = connect_qbittorrent(state).await.map_err(|_| {
                    error(
                        StatusCode::BAD_GATEWAY,
                        "Cannot pause downloads until qBittorrent is reachable.",
                    )
                })?;
                let torrents = qbittorrent_all_torrents(state, &session)
                    .await
                    .map_err(|_| {
                        error(StatusCode::BAD_GATEWAY, "Cannot read qBittorrent queue.")
                    })?;
                for row in rows {
                    if let Some(hash) = row["downloadId"].as_str() {
                        if torrents
                            .iter()
                            .any(|t| t.hash.eq_ignore_ascii_case(hash) && t.category == s.category)
                            && !stop_qbittorrent_torrent(state, &session, hash).await
                        {
                            return Err(error(
                                StatusCode::BAD_GATEWAY,
                                "Could not pause request download.",
                            ));
                        }
                    }
                }
            }
        }
        if let Some(hash) = r.torrent_hash.as_deref() {
            if let Ok(session) = connect_qbittorrent(state).await {
                let _ = stop_qbittorrent_torrent(state, &session, hash).await;
            }
        }
        if r.subscription_id.is_some() {
            release_request_reservation(state, r).await?;
        }
        r.status = "cancelled".into();
        r.error = None;
        return Ok(());
    }
    reserve(state, r, &owner, r.expected_bytes.unwrap_or(0)).await?;
    let media = ensure_media(state, &s, r).await?;
    let files = imported_files(state, &s, r, &media).await?;
    tracing::info!(request_id=%r.id, imported_files=files.len(), "Discover process imported file scan");
    if r.monitor_future && r.kind == "tv" {
        let now = unix_now();
        if now.saturating_sub(r.monitor_applied_at) > MONITOR_REAPPLY_SECS {
            let season = tmdb(
                state,
                &format!("tv/{}/season/{}", r.tmdb_id, r.season.unwrap()),
                &[],
            )
            .await?;
            r.expected_episodes.extend(subscriptions::expected_episodes(&season, r.monitor_from));
            set_monitor(&s, r, true).await?;
            catch_up_search(&s, r, now).await?;
            r.monitor_applied_at = now;
            persist_row(state, r).await?;
        }
    }
    let mut complete = requests::covered(r, &files);
    let mut idle_rows = None;
    if complete && r.monitor_future {
        // A new episode can be grabbed before the expected list learns of it;
        // never delete an in-flight download as if it were finished.
        let rows = queue_rows(&s, r).await?;
        if rows.is_empty() { idle_rows = Some(rows); } else { complete = false; }
    }
    account(state, r, &files, complete).await?;
    if complete {
        tracing::info!(request_id=%r.id, "Discover process complete");
        if !r.monitor_future {
            set_monitor(&s, r, false).await?;
        }
        let rows = match idle_rows { Some(rows) => rows, None => queue_rows(&s, r).await? };
        // The imported library files are authoritative now. Remove both the
        // qBittorrent registration and its staging payload so a completed
        // request cannot linger or be restored later.
        remove_request_from_download_clients(state, &s, r, &rows, true).await?;
        r.status = "ready".into();
        r.progress = 1.0;
        r.error = None;
        r.grab_guid = None;
        r.torrent_hash = None;
        return Ok(());
    }
    if !r.search_started && r.subscription_id.is_none() {
        tracing::info!(request_id=%r.id, "Discover process waiting for torrent pick");
        r.status = "pick".into();
        r.error = None;
        r.progress = 0.0;
        if r.auto_download { try_automatic_download(state, &s, r, &files).await?; }
        return Ok(());
    }
    let rows = queue_rows(&s, r).await?;
    tracing::info!(request_id=%r.id, queue_rows=rows.len(), queue_download_ids=?rows.iter().filter_map(|v|v["downloadId"].as_str()).collect::<Vec<_>>(), "Discover process service queue");
    // An unreachable qBittorrent is recoverable: the qBit watchers relaunch
    // it (including their own zero-progress restarts). Wait for the next tick
    // instead of surfacing an error the user can do nothing about.
    let session = match connect_qbittorrent(state).await {
        Ok(session) => session,
        Err(e) => {
            tracing::warn!(request_id=%r.id, error=%e, "Discover process waiting for qBittorrent to come back");
            if r.error.as_deref() == Some(QBIT_UNAVAILABLE) { r.error = None; }
            return Ok(());
        }
    };
    if let Some(binding) = vpn_binding_error(state, &session.bound_interface) {
        tracing::warn!(request_id=%r.id, binding=%binding, bound=%session.bound_interface, "Discover process VPN binding unhealthy");
        return Err(error(
            StatusCode::BAD_GATEWAY,
            "Waiting for the VPN interface and qBittorrent binding to become healthy.",
        ));
    }
    if !match state.vpn_interface.as_deref() {
        Some(i) => vpn_interface_is_up(i).await,
        None => false,
    } {
        tracing::warn!(request_id=%r.id, vpn=?state.vpn_interface, "Discover process VPN interface down");
        return Err(error(
            StatusCode::BAD_GATEWAY,
            "Waiting for the VPN interface and qBittorrent binding to become healthy.",
        ));
    }
    let torrents = qbittorrent_all_torrents(state, &session)
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "Cannot read download queue."))?;
    tracing::info!(request_id=%r.id, qbit_total=torrents.len(), category_matches=torrents.iter().filter(|t|t.category==s.category).count(), "Discover process qBittorrent inventory");
    for t in torrents.iter().filter(|t| t.category == s.category) {
        tracing::info!(request_id=%r.id, hash=%t.hash, name=%t.name, state=%t.state, size=t.size, seeds=t.num_seeds, dlspeed=t.dlspeed, progress=t.progress, "Discover process category torrent");
    }
    if let Some(hash) = r.torrent_hash.clone() {
        if !qbit_has_hash(&torrents, &s.category, &hash) {
            tracing::info!(request_id=%r.id, hash=%hash, "Discover tracked torrent was removed from qBittorrent; cancelling request instead of restoring it");
            set_monitor(&s, r, false).await?;
            remove_request_from_download_clients(state, &s, r, &rows, false).await?;
            release_request_reservation(state, r).await?;
            r.status = "cancelled".into();
            r.error = None;
            return Ok(());
        }
    }
    let mut hashes: BTreeSet<_> = rows
        .iter()
        .filter_map(|v| v["downloadId"].as_str().map(str::to_lowercase))
        .collect();
    if let Some(hash) = r.torrent_hash.as_ref() {
        hashes.insert(hash.to_lowercase());
    }
    let owned: Vec<_> = torrents
        .iter()
        .filter(|t| t.category == s.category && hashes.contains(&t.hash.to_lowercase()))
        .collect();
    tracing::info!(request_id=%r.id, tracked_hashes=?hashes, owned=owned.len(), owned_hashes=?owned.iter().map(|t|&t.hash).collect::<Vec<_>>(), "Discover process owned torrent match");
    if abandon_dead_grabs(state, &s, r, &rows, &owned).await? {
        persist_row(state, r).await?;
        return Ok(());
    }
    let rows = queue_rows(&s, r).await?;
    let mut hashes: BTreeSet<_> = rows
        .iter()
        .filter_map(|v| v["downloadId"].as_str().map(str::to_lowercase))
        .collect();
    if let Some(hash) = r.torrent_hash.as_ref() {
        hashes.insert(hash.to_lowercase());
    }
    let torrents = qbittorrent_all_torrents(state, &session)
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "Cannot read download queue."))?;
    let owned: Vec<_> = torrents
        .iter()
        .filter(|t| t.category == s.category && hashes.contains(&t.hash.to_lowercase()))
        .collect();
    let known_size = owned
        .iter()
        .map(|t| t.size)
        .sum::<u64>()
        .max(r.expected_bytes.unwrap_or(0));
    let total = known_size.saturating_add(files.iter().map(|(_, b)| *b).sum());
    tracing::info!(request_id=%r.id, known_size, expected_bytes=?r.expected_bytes, total, budget_gb=s.budget_gb, "Discover process size check");
    if known_size > 0 && total > u64::from(s.budget_gb) * 1024 * 1024 * 1024 {
        set_monitor(&s, r, false).await?;
        for torrent in &owned {
            stop_qbittorrent_torrent(state, &session, &torrent.hash).await;
        }
        return Err(error(
            StatusCode::CONFLICT,
            "Download exceeds the reserved request budget. Monitoring was stopped; review the paused download in the service.",
        ));
    }
    if let Err(problem) = reserve(state, r, &owner, known_size).await {
        for torrent in &owned {
            stop_qbittorrent_torrent(state, &session, &torrent.hash).await;
        }
        return Err(problem);
    }
    if r.expected_bytes.is_none() {
        fetch_metadata(state, &s, r, &session, &hashes).await?;
    }
    for torrent in &owned {
        let ready = torrent.size > 0 || r.expected_bytes.is_some_and(|n| n > 0);
        let stopped = qbittorrent_torrent_is_stopped(torrent);
        let complete = qbittorrent_torrent_is_complete(torrent);
        tracing::info!(request_id=%r.id, hash=%torrent.hash, ready, stopped, complete, state=%torrent.state, size=torrent.size, "Discover process resume decision");
        if ready && stopped && !complete {
            let resumed = resume_qbittorrent_torrent(state, &session, &torrent.hash).await;
            tracing::info!(request_id=%r.id, hash=%torrent.hash, resumed, "Discover process resume attempt");
            if !resumed {
                return Err(error(
                    StatusCode::BAD_GATEWAY,
                    "The download is reserved but qBittorrent did not resume it. Retrying shortly.",
                ));
            }
        }
    }
    let client_progress = if !owned.is_empty() {
        let size: f64 = owned.iter().map(|t| t.size as f64).sum();
        let done: f64 = owned.iter().map(|t| t.completed as f64).sum();
        if size > 0.0 {
            (done / size).clamp(0.0, 1.0)
        } else {
            0.0
        }
    } else {
        0.0
    };
    r.progress = if !rows.is_empty() {
        let size: f64 = rows.iter().filter_map(|v| v["size"].as_f64()).sum();
        let left: f64 = rows.iter().filter_map(|v| v["sizeleft"].as_f64()).sum();
        if size > 0.0 {
            (1.0 - left / size).clamp(0.0, 1.0)
        } else {
            client_progress
        }
    } else {
        client_progress
    };
    r.status = if rows
        .iter()
        .any(|v| v["status"] == "completed" || v["trackedDownloadState"] == "importPending")
    {
        "importing"
    } else if !rows.is_empty() || !owned.is_empty() {
        "downloading"
    } else if r.monitor_future {
        "monitoring"
    } else if !files.is_empty() {
        "partial"
    } else {
        "searching"
    }
    .into();
    r.error = if owned.iter().any(|t| {
        t.size == 0
            && matches!(
                t.state.to_ascii_lowercase().as_str(),
                "metadl" | "forcedmetadl" | "unmetadl"
            )
    }) {
        Some(
            "Waiting for torrent metadata from peers. If this stalls, pick another release.".into(),
        )
    } else if owned
        .iter()
        .any(|t| t.size == 0 && r.expected_bytes.is_none())
    {
        Some("Fetching torrent metadata before checking the storage budget.".into())
    } else if owned.is_empty() && r.torrent_hash.is_some() {
        Some("Tracked torrent is missing from qBittorrent; TMS is trying to restore it.".into())
    } else {
        rows.iter().find_map(|v| {
            v["errorMessage"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
    };
    tracing::info!(request_id=%r.id, status=%r.status, progress=r.progress, error=?r.error, owned=owned.len(), rows=rows.len(), "Discover process tick complete");
    Ok(())
}
pub async fn tick(state: &AppState) -> Result<(), (StatusCode, Json<Value>)> {
    let config: Services = load(state, "discovery-services.json").await?;
    let queue: Queue = load(state, "discovery-requests.json").await?;
    tracing::info!(requests = queue.requests.len(), "Discover tick begin");
    for mut r in queue.requests.into_iter().filter(|r| {
        r.hash.is_none()
            && requests::active(r)
            && (r.status != "ready" || r.monitor_future)
    }) {
        let latest: Queue = load(state, "discovery-requests.json").await?;
        if !latest.requests.iter().any(|row| row.id == r.id) { continue; }
        // Older versions rejected the entire service ceiling before choosing
        // a torrent. Recover those waiting requests without changing approval.
        if clear_preselection_quota_failure(&mut r) {
            release_request_reservation(state, &r).await?;
        }
        tracing::info!(request_id=%r.id, title=%r.title, status=%r.status, "Discover tick processing request");
        if can_search_releases(&r) {
            if let Err((_, Json(value))) = prepare_release_search(state, &mut r).await {
                tracing::warn!(request_id=%r.id, message=?value.get("message"), "Discover early release search unavailable");
                if r.error.is_none() { r.error = value["message"].as_str().map(str::to_owned); }
            }
            if matches!(r.status.as_str(), "pending" | "failed") {
                persist_row(state, &r).await?;
                continue;
            }
        }
        if let Err((status, Json(value))) = process(state, &mut r, &config).await {
            tracing::warn!(request_id=%r.id, status=%status.as_u16(), message=?value.get("message"), "Discover tick process error");
            r.error = value["message"].as_str().map(str::to_owned);
            // A subscription keeps watching through errors; only the error
            // is surfaced, never a failed state that offers a manual retry.
            if r.subscription_id.is_some() {
                if r.status == "failed" { r.status = "monitoring".into(); }
            } else if status != StatusCode::BAD_GATEWAY && r.status != "cancelling" {
                r.status = "failed".into();
            }
        }
        r.updated_at = unix_now();
        persist_row(state, &r).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn episode_releases_are_visible_without_becoming_complete_season_packs() {
        for title in [
            "Avatar Seven Havens S01E09 1080p WEB h264-GRACE",
            "Avatar.Seven.Havens.S01E08.1080p.WEBRip.AV1.AAC2.0-Rapta",
            "Avatar Seven Havens S01 E01 720p HEVC",
        ] {
            assert!(super::release_matches_season(title, 1), "{title}");
            assert!(!super::release_matches_season(title, 2), "{title}");
            assert!(!super::release_is_season_pack(title, 1), "{title}");
        }
        assert!(super::release_matches_season("Avatar Seven Havens S01 Complete 1080p", 1));
        assert!(!super::release_matches_season("Avatar Seven Havens S01E01 S02E01 1080p", 1));
        assert!(!super::release_matches_season("Avatar Seven Havens 1080p", 1));
    }

    #[test]
    fn unknown_size_quota_failures_recover_without_approving_pending_requests() {
        let mut request = subscription_row();
        request.subscription_id = None;
        request.search_started = false;
        request.status = "failed".into();
        request.error = Some("The request budget exceeds the requesting user's available storage quota.".into());
        assert!(super::clear_preselection_quota_failure(&mut request));
        assert_eq!(request.status, "pending");
        assert!(request.error.is_none());
        request.approved_by = Some(1);
        request.status = "failed".into();
        request.error = Some("The request budget exceeds the requesting user's available storage quota.".into());
        request.expected_bytes = Some(100);
        assert!(!super::clear_preselection_quota_failure(&mut request));
        request.expected_bytes = None;
        assert!(super::clear_preselection_quota_failure(&mut request));
        assert_eq!(request.status, "queued");
    }

    #[test]
    fn recollections_movie_is_not_a_multi_season_collection() {
        assert_eq!(super::series_pack_score(&serde_json::json!({"title":"[GST] Violet Evergarden: Recollections (2021) (Movie) [1080p]"})), 0);
        assert_eq!(super::series_pack_score(&serde_json::json!({"title":"Violet.Evergarden.Recollections.2022.1080p.NF.WEB-DL"})), 0);
        assert_eq!(super::series_pack_score(&serde_json::json!({"title":"Violet Evergarden Complete Collection"})), 2);
    }
    use super::{normalized_path, release_magnet, release_sort_rank, release_seasons, nyaa_matches_season, nyaa_title, release_preferred, read_release_snapshot};
    use serde_json::json;

    #[test]
    fn pending_and_quota_failed_requests_can_search_without_download_approval() {
        let mut request: super::Request = serde_json::from_value(json!({"id":"search-test","kind":"movie","tmdb_id":10,"title":"Example","season":null,"expected_episodes":[],"monitor_future":false,"library":"TV","owner_id":1,"subscribers":[1],"status":"pending","error":null,"created_at":1,"updated_at":1,"hash":null,"service_id":null,"progress":0})).unwrap();
        assert!(super::can_search_releases(&request));
        assert!(request.approved_by.is_none());
        request.status = "failed".into();
        request.error = Some("The request budget exceeds the requesting user's available storage quota.".into());
        assert!(super::can_search_releases(&request));
        request.hash = Some("active-download".into());
        assert!(!super::can_search_releases(&request));
        request.hash = None;
        request.status = "cancelled".into();
        assert!(!super::can_search_releases(&request));
    }

    #[test]
    fn automatic_selection_requires_complete_requested_seasons_within_budget() {
        let mut request: super::Request = serde_json::from_value(json!({"id":"auto-test","kind":"tv","tmdb_id":10,"title":"Example","season":1,"expected_episodes":[1,2],"monitor_future":false,"library":"TV","owner_id":1,"subscribers":[1],"status":"queued","error":null,"created_at":1,"updated_at":1,"hash":null,"service_id":null,"progress":0,"auto_download_seasons":[1,2]})).unwrap();
        let mut release = json!({"title":"Example S01-S02 Complete 1080p","size":super::REQUEST_BUDGET_BYTES,"seeders":5,"guid":"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567","indexerId":1});
        assert!(super::automatic_candidate(&request, &release));
        release["size"] = json!(super::REQUEST_BUDGET_BYTES + 1);
        assert!(!super::automatic_candidate(&request, &release));
        release["size"] = json!(100);
        release["title"] = json!("Example S01E01 1080p");
        assert!(!super::automatic_candidate(&request, &release));
        release["title"] = json!("Example S01-S03 Complete 1080p");
        assert!(!super::automatic_candidate(&request, &release));
        release["title"] = json!("Example S01 Complete 1080p");
        release["seeders"] = json!(4);
        assert!(!super::automatic_candidate(&request, &release));
        release["seeders"] = json!(5);
        release["title"] = json!("Example Complete Series 1080p");
        assert!(!super::automatic_candidate(&request, &release));
        request.auto_download_complete_series = true;
        assert!(super::automatic_candidate(&request, &release));
        assert_eq!(super::automatic_release_seasons(&request, &release), [1, 2].into_iter().collect());
        request.auto_download_complete_series = false;
        release["title"] = json!("Example 01-12 Batch 1080p");
        release["fullSeason"] = json!(true);
        release["seasonNumber"] = json!(1);
        assert!(super::automatic_candidate(&request, &release));
        request.kind = "movie".into();
        release["quality"] = json!({"quality":{"name":"CAM"}});
        assert!(!super::automatic_candidate(&request, &release));
        release["quality"] = json!({"quality":{"name":"WEBDL-1080p"}});
        assert!(super::automatic_candidate(&request, &release));
        request.kind = "tv".into();
        request.auto_download_seasons.clear();
        release["title"] = json!("Example S01 Complete 1080p");
        release["fullSeason"] = json!(false);
        assert!(super::automatic_rejection(&request, &release, false).is_some_and(|reason| reason.contains("not finished airing")));
    }

    #[test]
    fn foreign_titles_auto_pick_only_english_audio_releases() {
        let request: super::Request = serde_json::from_value(json!({"id":"auto-test","kind":"tv","tmdb_id":10,"title":"Example","season":1,"expected_episodes":[1,2],"monitor_future":false,"library":"TV","owner_id":1,"subscribers":[1],"status":"queued","error":null,"created_at":1,"updated_at":1,"hash":null,"service_id":null,"progress":0,"auto_download_seasons":[1]})).unwrap();
        let release = |title: &str| json!({"title":title,"size":100,"seeders":50,"guid":"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567","indexerId":1});
        for title in ["[Group] Example S01 1080p Dual-Audio", "Example S01 1080p [Dual Audio]", "Example S01 1080p English Dub", "Example S01 1080p Dubbed", "Example S01 1080p Multi-Audio"] {
            assert!(super::release_has_english_audio(&release(title)), "{title}");
            assert!(super::automatic_rejection(&request, &release(title), true).is_none(), "{title}");
        }
        for title in ["[SubsPlease] Example S01 1080p", "Example S01 1080p Multi-Subs", "Example S01 1080p ENG SUB"] {
            assert!(!super::release_has_english_audio(&release(title)), "{title}");
            assert!(super::automatic_rejection(&request, &release(title), true).is_some_and(|reason| reason.contains("English audio")), "{title}");
            assert!(super::automatic_rejection(&request, &release(title), false).is_none(), "{title}");
        }
        let mut arr = release("Example S01 1080p");
        arr["languages"] = json!([{"name":"Japanese"},{"name":"English"}]);
        assert!(super::release_has_english_audio(&arr));
    }

    #[test]
    fn episode_numbers_are_read_from_release_titles() {
        let set = |items: &[u16]| items.iter().copied().collect::<std::collections::BTreeSet<u16>>();
        assert_eq!(super::release_episodes("Example.S01E05.1080p.WEB", 1), set(&[5]));
        assert_eq!(super::release_episodes("Example S01 E05 1080p", 1), set(&[5]));
        assert_eq!(super::release_episodes("Example.S01E05E06.1080p", 1), set(&[5, 6]));
        assert_eq!(super::release_episodes("Example.S01E05-E07.1080p", 1), set(&[5, 6, 7]));
        assert_eq!(super::release_episodes("Example.S01E05-07.1080p", 1), set(&[5, 6, 7]));
        assert!(super::release_episodes("Example.S02E05.1080p", 1).is_empty());
        assert!(super::release_episodes("Example S01 Complete 1080p", 1).is_empty());
        let sonarr = json!({"title":"Example - 05 [1080p]","seasonNumber":1,"episodeNumbers":[5]});
        assert_eq!(super::release_episode_set(&sonarr, 1), set(&[5]));
    }

    #[test]
    fn episode_plan_takes_the_best_ranked_release_for_each_needed_episode() {
        let row = |title: &str, size: u64, seeders: u64, hash: char| json!({
            "title":title,"size":size,"seeders":seeders,"indexerId":1,
            "guid":format!("magnet:?xt=urn:btih:{}", hash.to_string().repeat(40)),
        });
        let rows = vec![
            row("Example S01 Complete 1080p", 10, 50, 'a'),
            row("Example S01E01 1080p", 10, 50, 'b'),
            row("Example S01E01 720p", 5, 50, 'c'),
            row("Example S01E02E03 1080p", 10, 2, 'd'),
            row("Example S01E02 1080p", 10, 30, 'e'),
            row("Example S01E03 1080p", 100, 30, 'f'),
            row("Example S01E04 1080p", 10, 30, 'g'),
        ];
        let needed: std::collections::BTreeSet<u16> = [1, 2, 3].into_iter().collect();
        let plan = super::plan_episode_releases(&rows, 1, &needed, 50, false);
        assert_eq!(plan.picks.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![1, 4]);
        assert_eq!(plan.missing, [3].into_iter().collect());
        let outcome = |i: usize| plan.outcomes.iter().find(|(row, _, _)| *row == i).map(|(_, _, outcome)| outcome.as_str()).unwrap();
        assert!(plan.outcomes.iter().all(|(row, _, _)| *row != 0));
        assert!(outcome(1).starts_with("won"));
        assert!(outcome(2).starts_with("lost"));
        assert!(outcome(3).contains("seeders"));
        assert!(outcome(5).contains("budget"));
        assert!(outcome(6).contains("already in the library or not aired"));
    }

    #[test]
    fn only_episodes_aired_before_the_subscription_are_picked_individually() {
        let aired = |date: &str, cutoff: Option<&str>| super::aired_before(&json!({"air_date":date}), "2026-10-24", cutoff);
        assert!(aired("2026-10-01", None));
        assert!(aired("2026-10-24", None));
        assert!(!aired("2026-10-25", None));
        assert!(!aired("2026-10-20", Some("2026-10-20")));
        assert!(aired("2026-10-19", Some("2026-10-20")));
        assert!(!super::aired_before(&json!({"air_date":null}), "2026-10-24", None));
    }

    #[tokio::test]
    async fn saved_release_snapshots_survive_reload_and_do_not_expire() {
        let directory = std::env::temp_dir().join(format!("tms-release-snapshot-{}", uuid::Uuid::new_v4()));
        let path = directory.join("results.json");
        assert!(read_release_snapshot(&path).await.unwrap().is_none());
        let rows = vec![json!({"title":"Saved pack","guid":"saved-release","seeders":50})];
        super::write_persisted_json(&path, &rows).await.unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH)).unwrap();
        assert_eq!(read_release_snapshot(&path).await.unwrap(), Some(rows));
        super::write_persisted_json(&path, &Vec::<serde_json::Value>::new()).await.unwrap();
        assert_eq!(read_release_snapshot(&path).await.unwrap(), Some(vec![]));
        tokio::fs::remove_file(&path).await.unwrap();
        tokio::fs::remove_dir(&directory).await.unwrap();
    }

    #[test]
    fn release_sort_is_transitive_across_seed_and_size_tradeoffs() {
        let mut releases = vec![];
        for seeds in [0, 5, 24, 25, 40, 65, 100, 203] {
            for size in [100, 200, 300] {
                releases.push(json!({"seeders":seeds,"size":size,"quality":{"quality":{"name":"1080p"}}}));
            }
        }
        for a in &releases { for b in &releases { for c in &releases {
            assert_eq!(release_preferred(a,b), release_preferred(b,a).reverse());
            if release_preferred(a,b).is_le() && release_preferred(b,c).is_le() {
                assert!(release_preferred(a,c).is_le());
            }
        } } }
        releases.sort_by(release_preferred);
    }

    #[test]
    fn nyaa_candidates_match_requested_season_and_specials() {
        assert!(nyaa_matches_season("Chainsmoker Cat S01E10 1080p", 1));
        assert!(!nyaa_matches_season("Chainsmoker Cat S01E10 1080p", 0));
        assert!(nyaa_matches_season("Yanineko Mini Anime - 21", 0));
        assert!(!nyaa_matches_season("Yanineko Mini Anime - 21", 1));
        assert!(!nyaa_matches_season("The Apothecary Diaries Season 2 (Batch)", 1));
        assert!(!nyaa_matches_season("Kusuriya no Hitorigoto 2nd Season (Batch)", 1));
        let title = nyaa_title("The Apothecary Diaries Season 1 &amp; 2 (Batch)");
        assert_eq!(release_seasons(&title), [1, 2].into_iter().collect());
        assert!(nyaa_matches_season(&title, 1));
    }

    #[test]
    fn season_pack_coverage_preserves_gaps_and_expands_ranges() {
        assert_eq!(release_seasons("Show S01-S05 Complete"), (1..=5).collect());
        assert_eq!(release_seasons("Show Seasons 2-4"), (2..=4).collect());
        assert_eq!(release_seasons("Show S01 + S03"), [1, 3].into_iter().collect());
        assert!(release_seasons("Show S01E02").is_empty());
        assert_eq!(release_seasons("Show S02-S04 + Specials"), [0, 2, 3, 4].into_iter().collect());
    }

    #[test]
    fn complete_season_does_not_outrank_complete_series() {
        let season = json!({"title":"The IT Crowd Complete Season 1", "fullSeason":true});
        let series = json!({"title":"The IT Crowd S01-S05 Complete 1080p", "fullSeason":true});
        assert!(release_sort_rank(&series) > release_sort_rank(&season));
    }

    #[test]
    fn arr_info_hash_provides_server_download_magnet() {
        let release = json!({"guid":"indexer-release-id", "title":"The IT Crowd", "infoHash":"0123456789abcdef0123456789abcdef01234567"});
        assert!(release_magnet(&release).unwrap().starts_with("magnet:?xt=urn:btih:"));
        assert!(release_magnet(&json!({"downloadUrl":"http://localhost/download.torrent"})).is_none());
    }

    fn subscription_row() -> super::Request {
        serde_json::from_value(json!({"id":"sub-test","kind":"tv","tmdb_id":10,"title":"Example","season":2,"expected_episodes":[],"monitor_future":true,"library":"TV","owner_id":1,"subscribers":[1],"status":"monitoring","error":null,"created_at":1,"updated_at":1,"hash":null,"service_id":5,"progress":0,"search_started":true,"subscription_id":"s","monitor_from":1_790_000_000u64})).unwrap()
    }

    #[test]
    fn subscription_rows_only_monitor_episodes_from_the_subscription_date() {
        let request = subscription_row();
        let before = json!({"airDateUtc":"2026-09-20T01:00:00Z"});
        let after = json!({"airDateUtc":"2026-10-01T01:00:00Z"});
        assert!(!super::episode_should_monitor(&before, &request, true));
        assert!(super::episode_should_monitor(&after, &request, true));
        assert!(super::episode_should_monitor(&json!({}), &request, true));
        assert!(super::episode_should_monitor(&json!({"airDateUtc":"not a date"}), &request, true));
        assert!(super::episode_should_monitor(&before, &request, false));
        let mut open_ended = subscription_row();
        open_ended.monitor_from = None;
        assert!(super::episode_should_monitor(&before, &open_ended, true));
        let mut ordinary = subscription_row();
        ordinary.monitor_future = false;
        ordinary.expected_episodes = [3].into_iter().collect();
        assert!(!super::episode_should_monitor(&json!({"episodeNumber":4}), &ordinary, true));
        assert!(super::episode_should_monitor(&json!({"episodeNumber":3}), &ordinary, true));
    }

    #[test]
    fn subscription_rows_never_enter_release_search_or_the_action_inbox() {
        let mut request = subscription_row();
        for status in ["pending", "queued", "pick", "failed", "searching", "monitoring"] {
            request.status = status.into();
            assert!(!super::can_search_releases(&request));
            assert!(!super::requests::needs_action(&request));
        }
    }

    #[test]
    fn catch_up_search_picks_missing_monitored_aired_episodes_in_the_season() {
        // 2026-10-10T00:00:00Z
        let from = 1_791_590_400u64;
        let now = from + 10 * 86400;
        let episodes = vec![
            json!({"id":1,"seasonNumber":2,"monitored":true,"hasFile":false,"airDateUtc":"2026-10-12T01:00:00Z"}),
            json!({"id":2,"seasonNumber":2,"monitored":true,"hasFile":true,"airDateUtc":"2026-10-12T01:00:00Z"}),
            json!({"id":3,"seasonNumber":2,"monitored":false,"hasFile":false,"airDateUtc":"2026-10-12T01:00:00Z"}),
            json!({"id":4,"seasonNumber":1,"monitored":true,"hasFile":false,"airDateUtc":"2026-10-12T01:00:00Z"}),
            json!({"id":5,"seasonNumber":2,"monitored":true,"hasFile":false,"airDateUtc":"2026-10-01T01:00:00Z"}),
            json!({"id":6,"seasonNumber":2,"monitored":true,"hasFile":false,"airDateUtc":"2026-10-30T01:00:00Z"}),
            json!({"id":7,"seasonNumber":2,"monitored":true,"hasFile":false}),
            json!({"id":8,"seasonNumber":2,"monitored":true,"hasFile":false,"airDateUtc":"2026-10-20T00:00:00Z"}),
        ];
        assert_eq!(super::catch_up_episode_ids(&episodes, 2, from, now), vec![1]);
        // An episode that aired within the last hour is left to the normal RSS grab.
        let just_aired = vec![json!({"id":9,"seasonNumber":2,"monitored":true,"hasFile":false,"airDateUtc":"2026-10-20T00:00:00Z"})];
        let aired = 1_792_454_400u64;
        assert!(super::catch_up_episode_ids(&just_aired, 2, from, aired + 1800).is_empty());
        assert_eq!(super::catch_up_episode_ids(&just_aired, 2, from, aired + 3600), vec![9]);
    }

    #[test]
    fn normalizes_equivalent_windows_separator_spellings() {
        assert_eq!(
            normalized_path(r"C:\\Users\\me\\Media\\"),
            normalized_path(r"C:\Users\me\Media")
        );
    }
}
