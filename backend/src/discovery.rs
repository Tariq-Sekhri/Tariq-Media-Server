use super::*;
use serde_json::json;
use crate::qbit::can_view_torrent_library;

mod arr;
mod eligibility;
pub(super) mod requests;
mod subscriptions;

pub(super) type ApiResult<T> = Result<Json<T>, (StatusCode, Json<Value>)>;
pub(super) fn error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({"message": message.into()})))
}
pub(super) fn internal(_: StatusCode) -> (StatusCode, Json<Value>) {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not save discovery data.",
    )
}
pub(super) fn data_path(state: &AppState, file: &str) -> PathBuf {
    state
        .users_path
        .parent()
        .expect("data directory")
        .join(file)
}
pub(super) async fn load<T: serde::de::DeserializeOwned + Default>(
    state: &AppState,
    file: &str,
) -> Result<T, (StatusCode, Json<Value>)> {
    match tokio::fs::read(data_path(state, file)).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Discovery data is damaged; restore its backup before continuing.",
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(_) => Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Discovery data cannot be read.",
        )),
    }
}
pub(super) async fn user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<StoredUser, (StatusCode, Json<Value>)> {
    authenticated_user(state, headers)
        .await
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Sign in to use Discover."))
}
pub(super) async fn admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<StoredUser, (StatusCode, Json<Value>)> {
    let user = user(state, headers).await?;
    if !has_admin_capability(&user, |p| p.manage_downloads) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Server download management permission is required.",
        ));
    }
    Ok(user)
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct Settings {
    pub tmdb_token: String,
}

pub(super) async fn settings(state: &AppState) -> Result<Settings, (StatusCode, Json<Value>)> {
    let mut config: Settings = load(state, "discovery-settings.json").await?;
    if config.tmdb_token.is_empty() {
        config.tmdb_token = env::var("TMS_TMDB_TOKEN").unwrap_or_default();
    }
    Ok(config)
}
pub(super) fn media_kind(kind: &str) -> Result<&str, (StatusCode, Json<Value>)> {
    match kind {
        "movie" => Ok("movie"),
        "tv" | "anime" => Ok("tv"),
        _ => Err(error(
            StatusCode::BAD_REQUEST,
            "Choose movies, series, or anime.",
        )),
    }
}
pub(super) fn is_anime_catalog(kind: &str) -> bool {
    kind == "anime"
}
pub(super) async fn tmdb(
    state: &AppState,
    path: &str,
    params: &[(&str, String)],
) -> Result<Value, (StatusCode, Json<Value>)> {
    let config = settings(state).await?;
    if config.tmdb_token.is_empty() {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Discover needs a TMDB API Read Access Token. An administrator can add it in Discover settings.",
        ));
    }
    let key = format!("{path}:{params:?}");
    let cache = data_path(state, "discovery-cache")
        .join(format!("{:x}.json", Sha256::digest(key.as_bytes())));
    if tokio::fs::metadata(&cache)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < Duration::from_secs(3600))
    {
        if let Ok(bytes) = tokio::fs::read(&cache).await {
            if let Ok(value) = serde_json::from_slice(&bytes) {
                return Ok(value);
            }
        }
    }
    let response = state
        .http
        .get(format!("https://api.themoviedb.org/3/{path}"))
        .bearer_auth(config.tmdb_token)
        .query(params)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| {
            error(
                StatusCode::BAD_GATEWAY,
                "TMDB could not be reached. Try again shortly.",
            )
        })?;
    if !response.status().is_success() {
        return Err(error(
            StatusCode::BAD_GATEWAY,
            format!(
                "TMDB returned {}. Check the API token or retry shortly.",
                response.status().as_u16()
            ),
        ));
    }
    let value: Value = response.json().await.map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "TMDB returned an invalid response.",
        )
    })?;
    if let Some(parent) = cache.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Ok(bytes) = serde_json::to_vec(&value) {
        let _ = tokio::fs::write(cache, bytes).await;
    }
    Ok(value)
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct TitleMatch {
    pub kind: String,
    pub tmdb_id: u64,
    pub path: String,
}
#[derive(Default, Serialize, Deserialize)]
pub(super) struct Matches {
    pub titles: Vec<TitleMatch>,
}

pub(super) fn visible(
    user: &StoredUser,
    libraries: &BTreeMap<String, LibraryConfig>,
    path: &str,
) -> bool {
    let root = path.split('/').next().unwrap_or("");
    libraries.contains_key(root) && can_view_torrent_library(user, libraries, root)
}
pub(super) fn local_files(state: &AppState, path: &str) -> Vec<(String, u64)> {
    if !safe_relative_path(path) {
        return vec![];
    }
    let base = state.library_root.join(path);
    WalkDir::new(base)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
        .filter_map(|e| {
            Some((
                e.path()
                    .strip_prefix(&state.library_root)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/"),
                e.metadata().ok()?.len(),
            ))
        })
        .collect()
}
pub(super) fn inventory(files: &[(String, u64)]) -> BTreeMap<u16, BTreeSet<u16>> {
    let mut result: BTreeMap<u16, BTreeSet<u16>> = BTreeMap::new();
    for (path, _) in files {
        if let Some(episode) = episode_name_from_release(path.rsplit('/').next().unwrap_or(path)) {
            result
                .entry(episode.season)
                .or_default()
                .insert(episode.episode);
        }
    }
    result
}
async fn availability(
    state: &AppState,
    user: &StoredUser,
) -> Result<Vec<Value>, (StatusCode, Json<Value>)> {
    let matches: Matches = load(state, "discovery-matches.json").await?;
    let libraries = read_libraries(state).await;
    let state = state.clone();
    let titles: Vec<_> = matches
        .titles
        .into_iter()
        .filter(|m| visible(user, &libraries, &m.path))
        .collect();
    tokio::task::spawn_blocking(move || titles.into_iter().filter_map(|m| {
        let files = local_files(&state, &m.path);
        if files.is_empty() { return None; }
        Some(json!({"kind":m.kind,"tmdb_id":m.tmdb_id,"path":m.path,"episodes":inventory(&files),"file_count":files.len()}))
    }).collect()).await.map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Could not read title inventory."))
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .merge(requests::routes())
        .merge(arr::routes())
        .merge(subscriptions::routes())
        .route("/api/discover", get(browse))
        .route("/api/discover/bootstrap", get(bootstrap))
        .route("/api/discover/title/{kind}/{id}", get(detail))
        .route(
            "/api/discover/history",
            put(save_history).delete(forget_history),
        )
        .route("/api/discover/settings", put(save_settings))
        .route("/api/discover/match", put(save_match))
        .route("/api/discover/match/backfill", post(backfill))
}
async fn bootstrap(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    let user = user(&state, &headers).await?;
    let config = settings(&state).await?;
    let libraries = read_libraries(&state).await;
    let destinations: Vec<_> = libraries
        .iter()
        .filter(|(name, lib)| {
            lib.content_type == "movies_tv"
                && !lib.folder_structure_static
                && visible(&user, &libraries, name)
        })
        .map(|(name, _)| name.clone())
        .collect();
    Ok(Json(
        json!({"configured":!config.tmdb_token.is_empty(),"is_admin":user.is_admin,"can_manage":has_admin_capability(&user, |p|p.manage_downloads),"libraries":destinations,"availability":availability(&state, &user).await?,"request_access":requests::access(&state, &user).await?,"searches":recent_searches(&state, &user).await?}),
    ))
}

const HISTORY_FILE: &str = "discovery-history.json";
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct SearchHistory {
    users: BTreeMap<u64, Vec<String>>,
}
async fn recent_searches(
    state: &AppState,
    user: &StoredUser,
) -> Result<Vec<String>, (StatusCode, Json<Value>)> {
    Ok(load::<SearchHistory>(state, HISTORY_FILE)
        .await?
        .users
        .get(&user.id)
        .cloned()
        .unwrap_or_default())
}
#[derive(Deserialize)]
struct HistoryEntry {
    query: String,
}
async fn save_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(entry): Json<HistoryEntry>,
) -> ApiResult<Value> {
    let user = user(&state, &headers).await?;
    let term: String = entry.query.trim().chars().take(150).collect();
    if term.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Enter a search term to remember.",
        ));
    }
    let _guard = state.persistence_lock.lock().await;
    let mut store: SearchHistory = load(&state, HISTORY_FILE).await?;
    let terms = store.users.entry(user.id).or_default();
    let lower = term.to_lowercase();
    terms.retain(|item| {
        let existing = item.to_lowercase();
        existing != lower && !lower.starts_with(&existing)
    });
    terms.insert(0, term);
    terms.truncate(12);
    let searches = terms.clone();
    write_persisted_json(&data_path(&state, HISTORY_FILE), &store)
        .await
        .map_err(internal)?;
    Ok(Json(json!({"searches": searches})))
}
#[derive(Deserialize)]
struct HistoryFilter {
    q: Option<String>,
}
async fn forget_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(filter): Query<HistoryFilter>,
) -> ApiResult<Value> {
    let user = user(&state, &headers).await?;
    let _guard = state.persistence_lock.lock().await;
    let mut store: SearchHistory = load(&state, HISTORY_FILE).await?;
    let terms = store.users.entry(user.id).or_default();
    match filter.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        Some(term) => terms.retain(|item| !item.eq_ignore_ascii_case(term)),
        None => terms.clear(),
    }
    let searches = terms.clone();
    write_persisted_json(&data_path(&state, HISTORY_FILE), &store)
        .await
        .map_err(internal)?;
    Ok(Json(json!({"searches": searches})))
}
#[derive(Deserialize)]
struct BrowseQuery {
    kind: String,
    feed: Option<String>,
    q: Option<String>,
    page: Option<u32>,
    genre: Option<u32>,
    year: Option<u32>,
}
pub(super) fn is_unfiltered_catalog(kind: &str) -> bool {
    kind == "all"
}
fn feed_request(
    kind: &str,
    anime: bool,
    query: &BrowseQuery,
    page: u32,
) -> (String, Vec<(&'static str, String)>) {
    let mut params = vec![
        ("page", page.to_string()),
        ("include_adult", "false".to_string()),
    ];
    if anime || query.genre.is_some() || query.year.is_some() || (kind == "movie" && query.feed.as_deref() == Some("upcoming")) {
        params.push((
            if kind == "tv" { "first_air_date.lte" } else { "primary_release_date.lte" },
            time::OffsetDateTime::now_utc().date().to_string(),
        ));
        if anime {
            params.push(("with_original_language", "ja".into()));
            params.push(("with_genres", query.genre.unwrap_or(16).to_string()));
        } else if let Some(genre) = query.genre {
            params.push(("with_genres", genre.to_string()));
        }
        if let Some(year) = query.year {
            params.push((
                if kind == "tv" {
                    "first_air_date_year"
                } else {
                    "primary_release_year"
                },
                year.to_string(),
            ));
        }
        match query.feed.as_deref().unwrap_or("trending") {
            "upcoming" if kind == "tv" => params.push(("sort_by", "first_air_date.desc".into())),
            "upcoming" => params.push(("sort_by", "primary_release_date.desc".into())),
            _ => params.push(("sort_by", "popularity.desc".into())),
        }
        return (format!("discover/{kind}"), params);
    }
    let path = match query.feed.as_deref().unwrap_or("trending") {
        "popular" => format!("{kind}/popular"),
        "upcoming" => format!(
            "{kind}/{}",
            if kind == "movie" {
                "upcoming"
            } else {
                "on_the_air"
            }
        ),
        _ => format!("trending/{kind}/week"),
    };
    (path, params)
}
fn blend(movies: &Value, series: &Value) -> Value {
    let tagged = |value: &Value, media: &str| {
        value["results"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut row| {
                row["media_type"] = json!(media);
                row
            })
            .collect::<Vec<_>>()
    };
    let mut rows = tagged(movies, "movie");
    rows.extend(tagged(series, "tv"));
    rows.sort_by(|a, b| {
        b["popularity"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["popularity"].as_f64().unwrap_or(0.0))
    });
    let pages = movies["total_pages"]
        .as_u64()
        .unwrap_or(1)
        .max(series["total_pages"].as_u64().unwrap_or(1));
    json!({"page": movies["page"], "results": rows, "total_pages": pages})
}
fn has_released(title: &Value, today: &str) -> bool {
    let date = if title["media_type"] == "movie" || title.get("title").is_some() {
        title["release_date"].as_str()
    } else {
        title["first_air_date"].as_str()
    };
    date.is_none_or(|date| date.is_empty() || date <= today)
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    #[test]
    fn future_movies_and_series_are_hidden_including_anime() {
        for title in [
            json!({"media_type":"movie", "title":"Future movie", "release_date":"2026-10-10"}),
            json!({"media_type":"tv", "name":"Future anime", "first_air_date":"2026-10-10"}),
            json!({"name":"Future series", "first_air_date":"2027-01-01"}),
        ] {
            assert!(!has_released(&title, "2026-10-09"));
        }
    }

    #[test]
    fn titles_released_today_and_older_ongoing_series_remain_visible() {
        assert!(has_released(&json!({"title":"Today", "release_date":"2026-10-09"}), "2026-10-09"));
        assert!(has_released(&json!({"name":"Ongoing", "first_air_date":"2025-01-01"}), "2026-10-09"));
    }

    #[test]
    fn missing_dates_do_not_imply_a_future_release() {
        assert!(has_released(&json!({"name":"Undated", "first_air_date":""}), "2026-10-09"));
        assert!(has_released(&json!({"title":"Undated"}), "2026-10-09"));
    }
}
async fn browse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BrowseQuery>,
) -> ApiResult<Value> {
    user(&state, &headers).await?;
    let anime = is_anime_catalog(&query.kind);
    let unfiltered = is_unfiltered_catalog(&query.kind);
    let page = query.page.unwrap_or(1).clamp(1, 500);
    let search = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty());
    let mut result = if let Some(q) = search {
        let mut params = vec![
            ("page", page.to_string()),
            ("include_adult", "false".to_string()),
        ];
        params.push(("query", q.chars().take(150).collect()));
        let path = if anime || unfiltered {
            "search/multi".to_string()
        } else {
            format!("search/{}", media_kind(&query.kind)?)
        };
        tmdb(&state, &path, &params).await?
    } else if unfiltered {
        let (movie_path, movie_params) = feed_request("movie", false, &query, page);
        let (tv_path, tv_params) = feed_request("tv", false, &query, page);
        let (movies, series) = tokio::try_join!(
            tmdb(&state, &movie_path, &movie_params),
            tmdb(&state, &tv_path, &tv_params)
        )?;
        blend(&movies, &series)
    } else {
        let kind = if anime && query.feed.as_deref() == Some("movies") {
            "movie"
        } else {
            media_kind(&query.kind)?
        };
        let (path, params) = feed_request(kind, anime, &query, page);
        tmdb(&state, &path, &params).await?
    };
    if let Some(rows) = result["results"].as_array_mut() {
        let today = time::OffsetDateTime::now_utc().date().to_string();
        rows.retain(|v| v["adult"] != true && has_released(v, &today));
        for row in rows.iter_mut() {
            if row["media_type"].is_null() {
                row["media_type"] = json!(if row.get("title").is_some() { "movie" } else { "tv" });
            }
        }
        if unfiltered {
            rows.retain(|v| matches!(v["media_type"].as_str(), Some("movie") | Some("tv")));
        }
        if anime {
            rows.retain(|v| {
                let media = v["media_type"].as_str().unwrap_or("");
                if search.is_some() && !media.is_empty() && media != "movie" && media != "tv" {
                    return false;
                }
                let is_jp = v["original_language"] == "ja"
                    || v["origin_country"]
                        .as_array()
                        .is_some_and(|c| c.iter().any(|x| x == "JP"));
                let is_anim = v["genre_ids"]
                    .as_array()
                    .is_some_and(|g| g.iter().any(|x| x == 16))
                    || v["genres"]
                        .as_array()
                        .is_some_and(|g| g.iter().any(|x| x == 16 || x["id"] == 16));
                is_jp && is_anim
            });
        }
    }
    Ok(Json(result))
}
async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((kind, id)): AxumPath<(String, u64)>,
) -> ApiResult<Value> {
    user(&state, &headers).await?;
    if !matches!(kind.as_str(), "movie" | "tv") {
        return Err(error(StatusCode::BAD_REQUEST, "Choose the title's movie or series catalog."));
    }
    let catalog = media_kind(&kind)?;
    let mut result = tmdb(
            &state,
            &format!("{catalog}/{id}"),
            &[(
                "append_to_response",
                "videos,credits,recommendations,external_ids".into(),
            )],
        )
        .await?;
    result["media_type"] = json!(catalog);
    if let Some(rows) = result["recommendations"]["results"].as_array_mut() {
        let today = time::OffsetDateTime::now_utc().date().to_string();
        rows.retain(|row| has_released(row, &today));
        for row in rows {
            row["media_type"] = json!(catalog);
        }
    }
    Ok(Json(result))
}
async fn save_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut config): Json<Settings>,
) -> ApiResult<Value> {
    admin(&state, &headers).await?;
    config.tmdb_token = config.tmdb_token.trim().to_owned();
    if config.tmdb_token.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Enter a TMDB API Read Access Token.",
        ));
    }
    let _guard = state.persistence_lock.lock().await;
    write_persisted_json(&data_path(&state, "discovery-settings.json"), &config)
        .await
        .map_err(internal)?;
    Ok(Json(json!({"saved":true})))
}
async fn save_match(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut item): Json<TitleMatch>,
) -> ApiResult<Value> {
    admin(&state, &headers).await?;
    item.kind = media_kind(&item.kind)?.to_owned();
    let root = item.path.split('/').next().unwrap_or("");
    let libraries = read_libraries(&state).await;
    if !safe_relative_path(&item.path)
        || !item.path.contains('/')
        || !libraries
            .get(root)
            .is_some_and(|l| l.content_type == "movies_tv")
        || local_files(&state, &item.path).is_empty()
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Choose an existing movie file or title folder inside a Movies & TV library.",
        ));
    }
    tmdb(&state, &format!("{}/{}", item.kind, item.tmdb_id), &[]).await?;
    let _guard = state.persistence_lock.lock().await;
    let mut matches: Matches = load(&state, "discovery-matches.json").await?;
    matches.titles.retain(|m| m.path != item.path);
    matches.titles.push(item);
    write_persisted_json(&data_path(&state, "discovery-matches.json"), &matches)
        .await
        .map_err(internal)?;
    Ok(Json(json!({"saved":true})))
}

async fn backfill(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    admin(&state, &headers).await?;
    let _run = state.discovery_lock.lock().await;
    let mut metadata = Vec::<Value>::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&state.title_metadata_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.path().extension().is_some_and(|e| e == "json") {
                if let Ok(bytes) = tokio::fs::read(entry.path()).await {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                        metadata.push(value);
                    }
                }
            }
        }
    }
    let mut found = vec![];
    let mut skipped = 0;
    for (library, config) in read_libraries(&state).await {
        if config.content_type != "movies_tv" {
            continue;
        }
        let Ok(mut entries) = tokio::fs::read_dir(state.library_root.join(&library)).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let title = if entry.path().is_file() {
                Path::new(&name)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            } else {
                name.clone()
            };
            let candidates: BTreeMap<String, &Value> = metadata
                .iter()
                .filter(|m| {
                    normalize_catalog_title(m["name"].as_str().unwrap_or(""))
                        == normalize_catalog_title(&title)
                })
                .filter_map(|m| Some((m["id"].as_str()?.to_owned(), m)))
                .collect();
            if candidates.len() != 1 {
                skipped += 1;
                continue;
            }
            let (imdb, cached) = candidates.into_iter().next().unwrap();
            let kind = if cached["type"] == "series" {
                "tv"
            } else {
                "movie"
            };
            let id = if let Some(id) = cached["moviedb_id"].as_u64() {
                id
            } else {
                if !imdb.starts_with("tt") {
                    skipped += 1;
                    continue;
                }
                let lookup = tmdb(
                    &state,
                    &format!("find/{imdb}"),
                    &[("external_source", "imdb_id".into())],
                )
                .await?;
                let key = if kind == "tv" {
                    "tv_results"
                } else {
                    "movie_results"
                };
                let Some(id) = lookup[key]
                    .as_array()
                    .filter(|a| a.len() == 1)
                    .and_then(|a| a[0]["id"].as_u64())
                else {
                    skipped += 1;
                    continue;
                };
                id
            };
            found.push(TitleMatch {
                kind: kind.into(),
                tmdb_id: id,
                path: format!("{library}/{name}"),
            });
        }
    }
    let _guard = state.persistence_lock.lock().await;
    let mut matches: Matches = load(&state, "discovery-matches.json").await?;
    let mut added = 0;
    for item in found {
        if !matches.titles.iter().any(|m| m.path == item.path) {
            matches.titles.push(item);
            added += 1;
        }
    }
    write_persisted_json(&data_path(&state, "discovery-matches.json"), &matches)
        .await
        .map_err(internal)?;
    Ok(Json(json!({"added":added,"unmatched":skipped})))
}
