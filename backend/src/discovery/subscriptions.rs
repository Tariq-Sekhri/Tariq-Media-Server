use super::requests::{access, destination, same_target, Queue, Request};
use super::*;

const FILE: &str = "discovery-subscriptions.json";
const CHECK_SECS: u64 = 6 * 3600;
const RETRY_SECS: u64 = 15 * 60;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Subscription {
    pub id: String,
    pub tmdb_id: u64,
    pub title: String,
    pub library: String,
    pub owner_id: u64,
    pub subscribers: BTreeSet<u64>,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_checked: u64,
    pub error: Option<String>,
    // The subscription's own TMDB check failure. `error` also mirrors its
    // rows' current errors, so it is rebuilt from both rather than kept stale.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_error: Option<String>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Subscriptions {
    subscriptions: Vec<Subscription>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/discover/subscriptions", get(list).post(create))
        .route("/api/discover/subscriptions/{id}", axum::routing::delete(unsubscribe))
}

async fn save(state: &AppState, store: &Subscriptions) -> Result<(), (StatusCode, Json<Value>)> {
    write_persisted_json(&data_path(state, FILE), store)
        .await
        .map_err(internal)
}
fn is_manager(user: &StoredUser) -> bool {
    has_admin_capability(user, |p| p.manage_downloads)
}
fn view(sub: &Subscription, user: &StoredUser, users: &[StoredUser]) -> Value {
    let owner = users
        .iter()
        .find(|u| u.id == sub.owner_id)
        .map(|u| u.name.as_str())
        .unwrap_or("Unknown user");
    let mut value = serde_json::to_value(sub).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.insert("owner_name".into(), json!(owner));
        object.insert("following".into(), json!(sub.subscribers.contains(&user.id)));
    }
    value
}

async fn list(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    let user = user(&state, &headers).await?;
    let manager = is_manager(&user);
    let libraries = read_libraries(&state).await;
    let users = read_users(&state.users_path).await;
    let store: Subscriptions = load(&state, FILE).await?;
    let rows: Vec<_> = store
        .subscriptions
        .iter()
        .filter(|s| visible(&user, &libraries, &s.library) && (manager || s.subscribers.contains(&user.id)))
        .map(|s| view(s, &user, &users))
        .collect();
    Ok(Json(json!({"subscriptions":rows})))
}

#[derive(Deserialize)]
struct Create {
    tmdb_id: u64,
    library: String,
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Create>,
) -> ApiResult<Value> {
    let user = user(&state, &headers).await?;
    destination(&state, &user, &input.library).await?;
    let _run = state.discovery_lock.lock().await;
    let allowed = access(&state, &user)
        .await?
        .into_iter()
        .any(|p| p.library == input.library && p.can_request && (p.auto_approve_requests || user.is_admin));
    if !allowed {
        return Err(error(StatusCode::FORBIDDEN, "Ask an administrator to subscribe to this show."));
    }
    if !arr::tv_service_enabled(&state, &input.library).await? {
        return Err(error(
            StatusCode::CONFLICT,
            "Connect and enable Sonarr for this library in Discover settings before subscribing.",
        ));
    }
    let mut store: Subscriptions = load(&state, FILE).await?;
    if let Some(existing) = store
        .subscriptions
        .iter_mut()
        .find(|s| s.tmdb_id == input.tmdb_id && s.library == input.library)
    {
        existing.subscribers.insert(user.id);
        existing.updated_at = unix_now();
        let value = existing.clone();
        save(&state, &store).await?;
        return Ok(Json(json!({"subscription":view(&value, &user, &read_users(&state.users_path).await)})));
    }
    let detail = tmdb(&state, &format!("tv/{}", input.tmdb_id), &[]).await?;
    let sub = Subscription {
        id: uuid::Uuid::new_v4().to_string(),
        tmdb_id: input.tmdb_id,
        title: detail["name"].as_str().or(detail["title"].as_str()).unwrap_or("Untitled").to_owned(),
        library: input.library,
        owner_id: user.id,
        subscribers: BTreeSet::from([user.id]),
        created_at: unix_now(),
        updated_at: unix_now(),
        last_checked: 0,
        error: None,
        check_error: None,
    };
    store.subscriptions.push(sub.clone());
    save(&state, &store).await?;
    tracing::info!(subscription_id=%sub.id, title=%sub.title, user_id=user.id, "Discover subscription created");
    Ok(Json(json!({"subscription":view(&sub, &user, &read_users(&state.users_path).await)})))
}

async fn unsubscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Value> {
    let user = user(&state, &headers).await?;
    let manager = is_manager(&user);
    let _run = state.discovery_lock.lock().await;
    let mut store: Subscriptions = load(&state, FILE).await?;
    let index = store
        .subscriptions
        .iter()
        .position(|s| s.id == id && (manager || s.subscribers.contains(&user.id)))
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Subscription not found."))?;
    store.subscriptions[index].subscribers.remove(&user.id);
    let mut queue: Queue = load(&state, "discovery-requests.json").await?;
    if manager || store.subscriptions[index].subscribers.is_empty() {
        let sub = store.subscriptions.remove(index);
        for r in queue.requests.iter_mut().filter(|r| r.subscription_id.as_deref() == Some(&sub.id)) {
            if super::requests::active(r) && r.status != "cancelling" {
                r.status = "cancelling".into();
                r.updated_at = unix_now();
            }
        }
        tracing::info!(subscription_id=%sub.id, title=%sub.title, user_id=user.id, "Discover subscription removed");
    } else {
        let sub = &mut store.subscriptions[index];
        sub.updated_at = unix_now();
        sync_subscribers(&mut queue, sub);
    }
    super::requests::save(&state, &queue).await?;
    save(&state, &store).await?;
    Ok(Json(json!({"ok":true})))
}

// First air date a show's subscription follows; earlier episodes belong to
// ordinary requests.
pub(super) async fn monitor_cutoff(state: &AppState, tmdb_id: u64, library: &str) -> Result<Option<String>, (StatusCode, Json<Value>)> {
    let store: Subscriptions = load(state, FILE).await?;
    Ok(store
        .subscriptions
        .iter()
        .find(|s| s.tmdb_id == tmdb_id && s.library == library)
        .map(|s| date_of(s.created_at - s.created_at % 86400)))
}
fn airing(detail: &Value) -> bool {
    !matches!(detail["status"].as_str(), Some("Ended" | "Canceled")) || detail["next_episode_to_air"].is_object()
}
// Approved requests for a show that is still airing also follow its new
// episodes. Callers hold the discovery lock.
pub(super) async fn follow_airing(
    state: &AppState,
    tmdb_id: u64,
    library: &str,
    owner_id: u64,
    subscribers: &BTreeSet<u64>,
) -> Result<(), (StatusCode, Json<Value>)> {
    let detail = tmdb(state, &format!("tv/{tmdb_id}"), &[]).await?;
    if !airing(&detail) {
        return Ok(());
    }
    if !arr::tv_service_enabled(state, library).await? {
        tracing::info!(tmdb_id, library=%library, "Discover cannot follow the airing show's new episodes without Sonarr");
        return Ok(());
    }
    let mut store: Subscriptions = load(state, FILE).await?;
    if let Some(existing) = store.subscriptions.iter_mut().find(|s| s.tmdb_id == tmdb_id && s.library == library) {
        if subscribers.is_subset(&existing.subscribers) {
            return Ok(());
        }
        existing.subscribers.extend(subscribers.iter().copied());
        existing.updated_at = unix_now();
        return save(state, &store).await;
    }
    let sub = Subscription {
        id: uuid::Uuid::new_v4().to_string(),
        tmdb_id,
        title: detail["name"].as_str().or(detail["title"].as_str()).unwrap_or("Untitled").to_owned(),
        library: library.to_owned(),
        owner_id,
        subscribers: subscribers.iter().copied().chain([owner_id]).collect(),
        created_at: unix_now(),
        updated_at: unix_now(),
        last_checked: 0,
        error: None,
        check_error: None,
    };
    store.subscriptions.push(sub.clone());
    save(state, &store).await?;
    tracing::info!(subscription_id=%sub.id, title=%sub.title, user_id=owner_id, status=?detail["status"].as_str(), "Discover subscription created for an approved airing show");
    Ok(())
}

fn sync_subscribers(queue: &mut Queue, sub: &Subscription) -> bool {
    let mut changed = false;
    for r in queue.requests.iter_mut().filter(|r| r.subscription_id.as_deref() == Some(&sub.id)) {
        if r.subscribers != sub.subscribers {
            r.subscribers = sub.subscribers.clone();
            changed = true;
        }
    }
    changed
}

pub(super) fn date_of(ts: u64) -> String {
    time::OffsetDateTime::from_unix_timestamp(ts as i64)
        .map(|t| t.date().to_string())
        .unwrap_or_default()
}
fn season_of(episode: &Value) -> Option<u16> {
    episode["season_number"]
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .filter(|n| *n > 0)
}
// New episodes only: the season airing next, the season of the latest episode
// when it aired on/after the subscription day, and any season announced beyond
// both. Seasons that finished airing before subscribing are never targeted.
pub(super) fn target_seasons(detail: &Value, created_date: &str) -> BTreeSet<u16> {
    let next = season_of(&detail["next_episode_to_air"]);
    let last = season_of(&detail["last_episode_to_air"]);
    let mut targets: BTreeSet<u16> = next.into_iter().collect();
    if detail["last_episode_to_air"]["air_date"].as_str().is_some_and(|d| d >= created_date) {
        targets.extend(last);
    }
    let known = next.max(last).unwrap_or(0);
    targets.extend(
        detail["seasons"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(season_of)
            .filter(|n| *n > known),
    );
    targets
}
// Episodes a subscription row waits for: aired on/after the subscription day,
// or without an air date yet.
pub(super) fn expected_episodes(season: &Value, monitor_from: Option<u64>) -> BTreeSet<u16> {
    let from = monitor_from.map(date_of);
    season["episodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| match (&from, e["air_date"].as_str().filter(|d| !d.is_empty())) {
            (Some(from), Some(date)) => date >= from.as_str(),
            _ => true,
        })
        .filter_map(|e| e["episode_number"].as_u64().and_then(|n| u16::try_from(n).ok()))
        .collect()
}

async fn check(
    state: &AppState,
    queue: &mut Queue,
    sub: &Subscription,
    changed: &mut bool,
) -> Result<(), (StatusCode, Json<Value>)> {
    let detail = tmdb(state, &format!("tv/{}", sub.tmdb_id), &[]).await?;
    // Start of the subscription's UTC day, so an episode that aired earlier
    // that day is both expected and monitored.
    let from = sub.created_at - sub.created_at % 86400;
    for season in target_seasons(&detail, &date_of(from)) {
        // An ordinary request for the season only covers episodes aired
        // before the subscription, so it does not replace the monitor row.
        if queue.requests.iter().any(|r| same_target(r, "tv", sub.tmdb_id, &sub.library, Some(season))
            && (r.subscription_id.is_some() || r.monitor_future)) {
            continue;
        }
        let season_detail = tmdb(state, &format!("tv/{}/season/{season}", sub.tmdb_id), &[]).await?;
        tracing::info!(subscription_id=%sub.id, title=%sub.title, season, "Discover subscription added a season to monitor");
        queue.requests.push(Request {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "tv".into(),
            tmdb_id: sub.tmdb_id,
            title: sub.title.clone(),
            season: Some(season),
            expected_episodes: expected_episodes(&season_detail, Some(from)),
            monitor_future: true,
            library: sub.library.clone(),
            owner_id: sub.owner_id,
            download_user_id: None,
            quota_override_by: None,
            subscribers: sub.subscribers.clone(),
            status: "monitoring".into(),
            error: None,
            created_at: unix_now(),
            updated_at: unix_now(),
            hash: None,
            service_id: None,
            progress: 0.0,
            approved_by: Some(sub.owner_id),
            service_snapshot: None,
            submitted: false,
            search_started: true,
            metadata_handoffs: BTreeMap::new(),
            expected_bytes: None,
            grab_guid: None,
            torrent_hash: None,
            auto_download: false,
            auto_download_seasons: BTreeSet::new(),
            auto_download_complete_series: false,
            subscription_id: Some(sub.id.clone()),
            monitor_from: Some(from),
            monitor_applied_at: 0,
            auto_pick_note: None,
        });
        *changed = true;
    }
    Ok(())
}

pub async fn tick(state: &AppState) -> Result<(), (StatusCode, Json<Value>)> {
    let mut store: Subscriptions = load(state, FILE).await?;
    if store.subscriptions.is_empty() {
        return Ok(());
    }
    let mut queue: Queue = load(state, "discovery-requests.json").await?;
    let now = unix_now();
    let (mut queue_changed, mut store_changed) = (false, false);
    for sub in &mut store.subscriptions {
        let row_error = queue
            .requests
            .iter()
            .filter(|r| r.subscription_id.as_deref() == Some(&sub.id))
            .find_map(|r| r.error.clone());
        let interval = if sub.check_error.is_some() { RETRY_SECS } else { CHECK_SECS };
        if sub.last_checked == 0 || now.saturating_sub(sub.last_checked) >= interval {
            let outcome = check(state, &mut queue, sub, &mut queue_changed).await;
            sub.last_checked = now;
            sub.check_error = match outcome {
                Ok(()) => None,
                Err((_, Json(value))) => {
                    tracing::warn!(subscription_id=%sub.id, message=%value, "Discover subscription check failed");
                    value["message"].as_str().map(str::to_owned)
                }
            };
            store_changed = true;
        }
        let error = sub.check_error.clone().or(row_error);
        if sub.error != error {
            sub.error = error;
            store_changed = true;
        }
        queue_changed |= sync_subscribers(&mut queue, sub);
    }
    if queue_changed {
        super::requests::save(state, &queue).await?;
    }
    if store_changed {
        save(state, &store).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ongoing_season_and_next_season_are_targeted_but_finished_ones_are_not() {
        let detail = json!({
            "last_episode_to_air":{"season_number":2,"air_date":"2026-10-14"},
            "next_episode_to_air":{"season_number":2,"air_date":"2026-10-21"},
            "seasons":[{"season_number":0},{"season_number":1},{"season_number":2},{"season_number":3}]
        });
        assert_eq!(target_seasons(&detail, "2026-10-01"), BTreeSet::from([2, 3]));
    }

    #[test]
    fn last_aired_season_is_ignored_when_it_finished_before_subscribing() {
        let detail = json!({
            "last_episode_to_air":{"season_number":1,"air_date":"2026-05-01"},
            "next_episode_to_air":null,
            "seasons":[{"season_number":0},{"season_number":1}]
        });
        assert!(target_seasons(&detail, "2026-10-01").is_empty());
        let announced = json!({
            "last_episode_to_air":{"season_number":1,"air_date":"2026-05-01"},
            "next_episode_to_air":null,
            "seasons":[{"season_number":0},{"season_number":1},{"season_number":2}]
        });
        assert_eq!(target_seasons(&announced, "2026-10-01"), BTreeSet::from([2]));
    }

    #[test]
    fn season_of_a_recent_last_episode_is_targeted_without_a_next_episode() {
        let detail = json!({
            "last_episode_to_air":{"season_number":4,"air_date":"2026-10-01"},
            "seasons":[{"season_number":1},{"season_number":4}]
        });
        assert_eq!(target_seasons(&detail, "2026-10-01"), BTreeSet::from([4]));
        assert!(target_seasons(&detail, "2026-10-02").is_empty());
    }

    #[test]
    fn returning_and_scheduled_shows_count_as_airing() {
        assert!(airing(&json!({"status":"Returning Series"})));
        assert!(airing(&json!({"status":"Ended","next_episode_to_air":{"season_number":1}})));
        assert!(!airing(&json!({"status":"Ended","next_episode_to_air":null})));
        assert!(!airing(&json!({"status":"Canceled"})));
    }

    #[test]
    fn unaired_new_show_targets_every_real_season() {
        let detail = json!({"seasons":[{"season_number":0},{"season_number":1}]});
        assert_eq!(target_seasons(&detail, "2026-10-01"), BTreeSet::from([1]));
    }

    #[test]
    fn expected_episodes_skip_those_aired_before_the_subscription_day() {
        let season = json!({"episodes":[
            {"episode_number":1,"air_date":"2026-10-01"},
            {"episode_number":2,"air_date":"2026-10-08"},
            {"episode_number":3,"air_date":null},
            {"episode_number":4,"air_date":""},
            {"episode_number":5,"air_date":"2026-10-22"}
        ]});
        // 2026-10-08 00:00:00 UTC
        let from = 1_791_417_600;
        assert_eq!(date_of(from), "2026-10-08");
        assert_eq!(expected_episodes(&season, Some(from)), BTreeSet::from([2, 3, 4, 5]));
        assert_eq!(expected_episodes(&season, None), BTreeSet::from([1, 2, 3, 4, 5]));
    }
}
