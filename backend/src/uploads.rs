//! Resumable, chunked media uploads.
//!
//! A single multipart request has to survive the whole transfer, so a proxy
//! timeout, a page navigation, a dropped Wi-Fi link, or a server restart used
//! to throw away everything already sent. An upload session instead lives on
//! disk: the client sends the file in small sequential chunks, the server's
//! partial file length is the authoritative resume offset, and the client can
//! reconnect from another page load and continue exactly where it stopped.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::{
    AppState, StoredUser, authenticated_user, finalize_storage_reservation,
    invalidate_library_cache, organize_movie_tv_media, read_libraries, read_persisted_json,
    read_storage_ledger, reconcile_storage_ledger, release_persisted_reservation,
    reserve_storage, safe_relative_path, supervise, unix_now, upload_should_organize_movie_tv,
    valid_upload_extension, write_persisted_json, write_storage_ledger,
};

/// The size clients start with. Small enough that one chunk finishes well
/// inside any proxy timeout on a slow uplink, large enough to keep the
/// per-request overhead negligible on a LAN.
const RECOMMENDED_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 64 * 1024 * 1024;
/// Unfinished uploads keep their partial data and storage reservation for a
/// week so a friend can pick an interrupted batch back up later.
const ABANDONED_SESSION_SECONDS: u64 = 7 * 24 * 60 * 60;
/// Finished sessions are remembered briefly so a client whose completion
/// response was lost can still confirm the upload instead of re-sending it.
const COMPLETED_SESSION_SECONDS: u64 = 24 * 60 * 60;

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct UploadSession {
    id: String,
    user_id: u64,
    parent_path: String,
    relative_path: String,
    file_name: String,
    size: u64,
    #[serde(default)]
    last_modified: Option<u64>,
    reservation_id: String,
    created_at: u64,
    updated_at: u64,
    #[serde(default)]
    completed_path: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct UploadSessionResponse {
    id: String,
    parent_path: String,
    relative_path: String,
    file_name: String,
    size: u64,
    last_modified: Option<u64>,
    received_bytes: u64,
    chunk_size: u64,
    complete: bool,
    path: Option<String>,
    updated_at: u64,
}

#[derive(Deserialize)]
pub(crate) struct CreateUploadSessionRequest {
    parent_path: String,
    #[serde(default)]
    relative_path: Option<String>,
    file_name: String,
    file_size: u64,
    #[serde(default)]
    last_modified: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct UploadChunkQuery {
    offset: u64,
}

/// Where a validated upload will land in the library.
pub(crate) struct UploadTarget {
    pub(crate) content_type: String,
    pub(crate) destination_dir: PathBuf,
    pub(crate) destination: PathBuf,
}

fn upload_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "message": message }))).into_response()
}

fn offset_mismatch(received_bytes: u64) -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "The server has a different amount of this file. Resuming from the server's copy.",
            "received_bytes": received_bytes,
        })),
    )
        .into_response()
}

/// Validates an upload against the library rules shared by the legacy
/// single-request endpoint and resumable sessions.
pub(crate) async fn resolve_upload_target(
    state: &AppState,
    user: &StoredUser,
    parent_path: &str,
    relative_path: &str,
    filename: &str,
) -> Result<UploadTarget, (StatusCode, &'static str)> {
    let Some(library_path) = parent_path.split('/').next().filter(|path| !path.is_empty()) else {
        tracing::warn!(user = %user.name, parent_path, filename, "Upload rejected: parent path has no library");
        return Err((StatusCode::BAD_REQUEST, "Choose a library folder to upload into."));
    };
    if !safe_relative_path(parent_path)
        || !safe_relative_path(relative_path)
        || Path::new(relative_path).file_name().and_then(|name| name.to_str()) != Some(filename)
    {
        tracing::warn!(user = %user.name, parent_path, relative_path, filename, "Upload rejected: unsafe or mismatched upload path");
        return Err((StatusCode::BAD_REQUEST, "This file path cannot be uploaded."));
    }
    let libraries = read_libraries(state).await;
    let Some(library) = libraries.get(library_path) else {
        tracing::warn!(user = %user.name, parent_path, "Upload rejected: library not found");
        return Err((StatusCode::NOT_FOUND, "That library no longer exists."));
    };
    if library.folder_structure_static && relative_path.contains('/') {
        tracing::warn!(user = %user.name, parent_path, relative_path, "Upload rejected: library folder structure is static");
        return Err((StatusCode::FORBIDDEN, "This library does not accept new folders."));
    }
    let allowed = user.is_admin
        || library
            .members
            .iter()
            .any(|member| member.name.eq_ignore_ascii_case(&user.name) && member.can_upload);
    if !allowed {
        tracing::warn!(user = %user.name, parent_path, "Upload rejected: permission denied");
        return Err((StatusCode::FORBIDDEN, "You do not have permission to upload here."));
    }
    let extension = filename
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    if !valid_upload_extension(&library.content_type, &extension) {
        tracing::warn!(user = %user.name, parent_path, filename, content_type = %library.content_type, "Upload rejected: unsupported media format");
        return Err((StatusCode::UNSUPPORTED_MEDIA_TYPE, "This library does not accept that file type."));
    }
    let destination_dir = state.library_root.join(parent_path);
    if !destination_dir.is_dir() {
        tracing::warn!(parent_path, "Upload rejected: destination directory missing");
        return Err((StatusCode::NOT_FOUND, "The destination folder no longer exists."));
    }
    let destination = destination_dir.join(relative_path);
    if destination.exists() {
        tracing::warn!(parent_path, relative_path, "Upload rejected: destination already exists");
        return Err((StatusCode::CONFLICT, "A file with that name already exists."));
    }
    Ok(UploadTarget {
        content_type: library.content_type.clone(),
        destination_dir,
        destination,
    })
}

fn part_path(state: &AppState, id: &str) -> PathBuf {
    state.uploads_dir.join(format!("{id}.part"))
}

async fn received_bytes(state: &AppState, id: &str) -> u64 {
    tokio::fs::metadata(part_path(state, id))
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

async fn read_sessions(state: &AppState) -> Vec<UploadSession> {
    read_persisted_json(&state.upload_sessions_path)
        .await
        .unwrap_or_default()
}

async fn write_sessions(state: &AppState, sessions: &Vec<UploadSession>) -> Result<(), Response> {
    write_persisted_json(&state.upload_sessions_path, sessions)
        .await
        .map_err(|status| upload_error(status, "The upload could not be saved on the server."))
}

async fn session_response(state: &AppState, session: &UploadSession) -> UploadSessionResponse {
    let complete = session.completed_path.is_some();
    UploadSessionResponse {
        id: session.id.clone(),
        parent_path: session.parent_path.clone(),
        relative_path: session.relative_path.clone(),
        file_name: session.file_name.clone(),
        size: session.size,
        last_modified: session.last_modified,
        received_bytes: if complete { session.size } else { received_bytes(state, &session.id).await },
        chunk_size: RECOMMENDED_CHUNK_BYTES,
        complete,
        path: session.completed_path.clone(),
        updated_at: session.updated_at,
    }
}

/// One writer per session: a client retry can race a request the server is
/// still finishing, and both must not append at the same offset.
async fn session_write_lock(state: &AppState, id: &str) -> Arc<tokio::sync::Mutex<()>> {
    state
        .upload_write_locks
        .lock()
        .await
        .entry(id.to_owned())
        .or_default()
        .clone()
}

async fn forget_session_write_lock(state: &AppState, id: &str) {
    state.upload_write_locks.lock().await.remove(id);
}

/// Removes an unfinished session's partial data and returns its reserved
/// storage to the owner.
async fn discard_session_data(state: &AppState, session: &UploadSession) {
    let _ = tokio::fs::remove_file(part_path(state, &session.id)).await;
    release_persisted_reservation(state, &session.reservation_id).await;
    forget_session_write_lock(state, &session.id).await;
}

async fn authenticated(state: &AppState, headers: &HeaderMap) -> Result<StoredUser, Response> {
    authenticated_user(state, headers)
        .await
        .ok_or_else(|| upload_error(StatusCode::UNAUTHORIZED, "Your session expired. Sign in again."))
}

pub(crate) async fn list_upload_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<UploadSessionResponse>>, Response> {
    let user = authenticated(&state, &headers).await?;
    let sessions = {
        let _guard = state.upload_sessions_lock.lock().await;
        read_sessions(&state).await
    };
    let mut response = Vec::new();
    for session in sessions
        .iter()
        .filter(|session| session.user_id == user.id && session.completed_path.is_none())
    {
        response.push(session_response(&state, session).await);
    }
    Ok(Json(response))
}

pub(crate) async fn get_upload_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<UploadSessionResponse>, Response> {
    let user = authenticated(&state, &headers).await?;
    let session = {
        let _guard = state.upload_sessions_lock.lock().await;
        read_sessions(&state).await.into_iter().find(|session| session.id == id)
    };
    match session {
        Some(session) if session.user_id == user.id => Ok(Json(session_response(&state, &session).await)),
        _ => Err(upload_error(StatusCode::NOT_FOUND, "This upload is no longer on the server.")),
    }
}

pub(crate) async fn create_upload_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateUploadSessionRequest>,
) -> Result<Json<UploadSessionResponse>, Response> {
    let user = authenticated(&state, &headers).await?;
    let parent_path = request.parent_path.trim().replace('\\', "/");
    let Some(file_name) = Path::new(request.file_name.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
    else {
        return Err(upload_error(StatusCode::BAD_REQUEST, "The file has no name."));
    };
    let relative_path = request
        .relative_path
        .map(|path| path.trim().replace('\\', "/"))
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| file_name.clone());
    if request.file_size == 0 {
        return Err(upload_error(StatusCode::BAD_REQUEST, "Empty files cannot be uploaded."));
    }

    let _guard = state.upload_sessions_lock.lock().await;
    let mut sessions = read_sessions(&state).await;
    // Re-adding the same file resumes its unfinished upload instead of
    // starting over. This is how a reloaded page reconnects to its work.
    if let Some(existing) = sessions.iter().find(|session| {
        session.completed_path.is_none()
            && session.user_id == user.id
            && session.parent_path == parent_path
            && session.relative_path == relative_path
            && session.size == request.file_size
            && session.last_modified == request.last_modified
    }) {
        tracing::info!(event = "upload_resumed", user = %user.name, parent_path, relative_path, upload_id = %existing.id, "Upload session resumed");
        return Ok(Json(session_response(&state, existing).await));
    }
    // Anything else aimed at the same destination is either a stale copy of
    // a changed file from this user, or another user's upload in progress.
    if let Some(index) = sessions.iter().position(|session| {
        session.completed_path.is_none()
            && session.parent_path == parent_path
            && session.relative_path.eq_ignore_ascii_case(&relative_path)
    }) {
        if sessions[index].user_id != user.id {
            return Err(upload_error(
                StatusCode::CONFLICT,
                "Someone else is already uploading a file with that name here.",
            ));
        }
        let stale = sessions.remove(index);
        discard_session_data(&state, &stale).await;
    }

    let target = resolve_upload_target(&state, &user, &parent_path, &relative_path, &file_name)
        .await
        .map_err(|(status, message)| upload_error(status, message))?;
    drop(target);

    let id = uuid::Uuid::new_v4().to_string();
    let reservation_id = format!("upload-{id}");
    {
        let _guard = state.persistence_lock.lock().await;
        let mut ledger = read_storage_ledger(&state.storage_path).await;
        reconcile_storage_ledger(&state, &mut ledger).await;
        if !reserve_storage(&mut ledger, &user, &reservation_id, "upload", request.file_size) {
            tracing::warn!(user = %user.name, parent_path, file_name, size = request.file_size, "Upload rejected: storage quota exceeded");
            return Err(upload_error(
                StatusCode::INSUFFICIENT_STORAGE,
                "This upload would exceed your server storage quota.",
            ));
        }
        write_storage_ledger(&state.storage_path, &ledger)
            .await
            .map_err(|status| upload_error(status, "The upload could not be saved on the server."))?;
    }
    let created = async {
        tokio::fs::create_dir_all(&state.uploads_dir).await?;
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(part_path(&state, &id))
            .await
            .map(drop)
    }
    .await;
    if let Err(error) = created {
        tracing::error!(%error, "Upload failed: could not create the partial upload file");
        release_persisted_reservation(&state, &reservation_id).await;
        return Err(upload_error(StatusCode::INTERNAL_SERVER_ERROR, "The server could not start this upload."));
    }
    let now = unix_now();
    let session = UploadSession {
        id,
        user_id: user.id,
        parent_path,
        relative_path,
        file_name,
        size: request.file_size,
        last_modified: request.last_modified,
        reservation_id,
        created_at: now,
        updated_at: now,
        completed_path: None,
    };
    sessions.push(session.clone());
    if let Err(response) = write_sessions(&state, &sessions).await {
        discard_session_data(&state, &session).await;
        return Err(response);
    }
    tracing::info!(event = "upload_started", user = %user.name, parent_path = %session.parent_path, relative_path = %session.relative_path, upload_id = %session.id, request_bytes = session.size, "Resumable upload started");
    Ok(Json(session_response(&state, &session).await))
}

pub(crate) async fn put_upload_chunk(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<UploadChunkQuery>,
    body: Bytes,
) -> Result<Json<UploadSessionResponse>, Response> {
    let user = authenticated(&state, &headers).await?;
    if body.is_empty() {
        return Err(upload_error(StatusCode::BAD_REQUEST, "The upload chunk was empty."));
    }
    if body.len() > MAX_CHUNK_BYTES {
        return Err(upload_error(StatusCode::PAYLOAD_TOO_LARGE, "The upload chunk is too large."));
    }
    let session = {
        let _guard = state.upload_sessions_lock.lock().await;
        read_sessions(&state).await.into_iter().find(|session| session.id == id)
    };
    let Some(session) = session.filter(|session| session.user_id == user.id) else {
        return Err(upload_error(StatusCode::NOT_FOUND, "This upload is no longer on the server."));
    };
    if session.completed_path.is_some() {
        return Ok(Json(session_response(&state, &session).await));
    }

    let lock = session_write_lock(&state, &id).await;
    let _write = lock.lock().await;
    let path = part_path(&state, &id);
    let mut file = match tokio::fs::OpenOptions::new().write(true).create(true).truncate(false).open(&path).await {
        Ok(file) => file,
        Err(error) => {
            tracing::error!(%error, upload_id = %id, "Upload failed: could not open the partial upload file");
            return Err(upload_error(StatusCode::INTERNAL_SERVER_ERROR, "The server could not write this upload."));
        }
    };
    let current = file.metadata().await.map(|metadata| metadata.len()).unwrap_or(0);
    if query.offset != current {
        return Err(offset_mismatch(current));
    }
    if current.saturating_add(body.len() as u64) > session.size {
        tracing::warn!(user = %user.name, upload_id = %id, size = session.size, received = current + body.len() as u64, "Upload rejected: file is larger than its declared size");
        return Err(upload_error(StatusCode::BAD_REQUEST, "The file is larger than when the upload started. Remove it and add it again."));
    }
    let written = async {
        file.seek(std::io::SeekFrom::Start(current)).await?;
        file.write_all(&body).await?;
        // Make the new length durable: it is the resume offset the client
        // will be told after a server or power interruption.
        file.sync_data().await
    }
    .await;
    if let Err(error) = written {
        tracing::error!(%error, upload_id = %id, "Upload failed while writing a chunk");
        // A partial chunk would shift every following byte; roll it back so
        // the client retries the whole chunk at the same offset.
        let _ = file.set_len(current).await;
        return Err(upload_error(StatusCode::INTERNAL_SERVER_ERROR, "The server could not write this upload."));
    }
    drop(file);
    Ok(Json(UploadSessionResponse {
        received_bytes: current + body.len() as u64,
        ..session_response(&state, &session).await
    }))
}

/// Moves finished data into the library. A rename is atomic on one volume;
/// external libraries are junctions to other drives, which need a copy.
async fn move_into_library(source: &Path, destination: &Path, file_name: &str) -> std::io::Result<()> {
    match tokio::fs::rename(source, destination).await {
        Ok(()) => Ok(()),
        Err(_) => {
            let parent = destination.parent().unwrap_or(destination);
            let staging = parent.join(format!(".{file_name}.{}.uploading", uuid::Uuid::new_v4()));
            let copied = async {
                tokio::fs::copy(source, &staging).await?;
                tokio::fs::rename(&staging, destination).await
            }
            .await;
            if copied.is_err() {
                let _ = tokio::fs::remove_file(&staging).await;
            } else {
                let _ = tokio::fs::remove_file(source).await;
            }
            copied
        }
    }
}

pub(crate) async fn complete_upload_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<UploadSessionResponse>, Response> {
    let user = authenticated(&state, &headers).await?;
    let _guard = state.upload_sessions_lock.lock().await;
    let mut sessions = read_sessions(&state).await;
    let Some(index) = sessions
        .iter()
        .position(|session| session.id == id && session.user_id == user.id)
    else {
        return Err(upload_error(StatusCode::NOT_FOUND, "This upload is no longer on the server."));
    };
    if sessions[index].completed_path.is_some() {
        return Ok(Json(session_response(&state, &sessions[index]).await));
    }
    let session = sessions[index].clone();
    let lock = session_write_lock(&state, &id).await;
    let _write = lock.lock().await;
    let received = received_bytes(&state, &id).await;
    if received != session.size {
        return Err(offset_mismatch(received));
    }
    let target = resolve_upload_target(&state, &user, &session.parent_path, &session.relative_path, &session.file_name)
        .await
        .map_err(|(status, message)| upload_error(status, message))?;
    let Some(destination_parent) = target.destination.parent() else {
        return Err(upload_error(StatusCode::BAD_REQUEST, "This file path cannot be uploaded."));
    };
    if let Err(error) = tokio::fs::create_dir_all(destination_parent).await {
        tracing::error!(%error, destination = %target.destination.display(), "Upload failed: could not create destination folders");
        return Err(upload_error(StatusCode::INTERNAL_SERVER_ERROR, "The server could not create the destination folder."));
    }
    if let Err(error) = move_into_library(&part_path(&state, &id), &target.destination, &session.file_name).await {
        tracing::error!(%error, destination = %target.destination.display(), "Upload failed while finalizing file");
        return Err(upload_error(StatusCode::INTERNAL_SERVER_ERROR, "The server could not save the finished file."));
    }

    let mut final_path = format!("{}/{}", session.parent_path.trim_end_matches('/'), session.relative_path);
    if upload_should_organize_movie_tv(&target.content_type, &session.relative_path) {
        match organize_movie_tv_media(&state, &target.destination, &target.destination_dir, &session.file_name, None).await {
            Ok(result) => {
                if let Some((_, organized)) = result.moves.first()
                    && let Ok(relative) = organized.strip_prefix(&state.library_root)
                {
                    final_path = relative.to_string_lossy().replace('\\', "/");
                }
                tracing::info!(user = %user.name, parent_path = %session.parent_path, relative_path = %session.relative_path, episodes = result.moved, "Uploaded Movies & TV media organized into the library");
            }
            Err(error) => {
                tracing::info!(user = %user.name, parent_path = %session.parent_path, relative_path = %session.relative_path, error = %error.message, "Uploaded Movies & TV media was left in its selected folder")
            }
        }
    }
    {
        let _guard = state.persistence_lock.lock().await;
        let mut ledger = read_storage_ledger(&state.storage_path).await;
        finalize_storage_reservation(
            &mut ledger,
            &session.reservation_id,
            user.id,
            "upload",
            None,
            &[(final_path.clone(), session.size)],
        );
        if write_storage_ledger(&state.storage_path, &ledger).await.is_err() {
            tracing::error!(upload_id = %id, path = %final_path, "Uploaded file saved, but its storage allocation could not be recorded");
        }
    }
    let now = unix_now();
    sessions[index].completed_path = Some(final_path.clone());
    sessions[index].updated_at = now;
    let completed = sessions[index].clone();
    if write_sessions(&state, &sessions).await.is_err() {
        tracing::error!(upload_id = %id, "Uploaded file saved, but its session could not be marked complete");
    }
    forget_session_write_lock(&state, &id).await;
    let elapsed = now.saturating_sub(session.created_at).max(1);
    tracing::info!(
        event = "upload_completed",
        user = %user.name,
        parent_path = %session.parent_path,
        relative_path = %session.relative_path,
        uploaded_bytes = session.size,
        upload_duration_ms = elapsed * 1000,
        upload_mebibytes_per_second = session.size as f64 / (1024.0 * 1024.0) / elapsed as f64,
        "Upload completed"
    );
    invalidate_library_cache(&state).await;
    Ok(Json(session_response(&state, &completed).await))
}

pub(crate) async fn cancel_upload_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, Response> {
    let user = authenticated(&state, &headers).await?;
    let _guard = state.upload_sessions_lock.lock().await;
    let mut sessions = read_sessions(&state).await;
    let Some(index) = sessions
        .iter()
        .position(|session| session.id == id && (session.user_id == user.id || user.is_admin))
    else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let session = sessions.remove(index);
    if session.completed_path.is_none() {
        let lock = session_write_lock(&state, &id).await;
        let _write = lock.lock().await;
        discard_session_data(&state, &session).await;
        tracing::info!(event = "upload_cancelled", user = %user.name, parent_path = %session.parent_path, relative_path = %session.relative_path, upload_id = %id, "Upload cancelled");
    }
    write_sessions(&state, &sessions).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn modified_seconds(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

/// Expires abandoned partial uploads and forgets old completed ones.
async fn sweep_upload_sessions(state: &AppState) {
    let _guard = state.upload_sessions_lock.lock().await;
    let mut sessions = read_sessions(state).await;
    let now = unix_now();
    let mut kept = Vec::with_capacity(sessions.len());
    let mut changed = false;
    for session in sessions.drain(..) {
        if session.completed_path.is_some() {
            if now.saturating_sub(session.updated_at) < COMPLETED_SESSION_SECONDS {
                kept.push(session);
            } else {
                changed = true;
            }
            continue;
        }
        let last_activity = tokio::fs::metadata(part_path(state, &session.id))
            .await
            .ok()
            .and_then(|metadata| modified_seconds(&metadata))
            .unwrap_or(session.updated_at)
            .max(session.updated_at);
        if now.saturating_sub(last_activity) < ABANDONED_SESSION_SECONDS {
            kept.push(session);
        } else {
            tracing::info!(event = "upload_expired", upload_id = %session.id, parent_path = %session.parent_path, relative_path = %session.relative_path, "Abandoned upload expired");
            discard_session_data(state, &session).await;
            changed = true;
        }
    }
    if changed {
        let _ = write_sessions(state, &kept).await;
    }
    // Partial files with no session belong to nothing and can never resume.
    let known = kept.iter().map(|session| format!("{}.part", session.id)).collect::<std::collections::HashSet<_>>();
    if let Ok(mut entries) = tokio::fs::read_dir(&state.uploads_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if known.contains(&name) {
                continue;
            }
            let stale = entry
                .metadata()
                .await
                .ok()
                .and_then(|metadata| modified_seconds(&metadata))
                .is_none_or(|modified| now.saturating_sub(modified) > 60 * 60);
            if stale {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
}

pub(crate) fn spawn_upload_session_sweep(state: AppState) {
    supervise("upload-session-sweep", move || {
        let state = state.clone();
        async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
            loop {
                interval.tick().await;
                sweep_upload_sessions(&state).await;
            }
        }
    });
}

pub(crate) type UploadWriteLocks = Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_records_tolerate_older_fields() {
        let session: UploadSession = serde_json::from_str(
            r#"{"id":"a","user_id":1,"parent_path":"Lib","relative_path":"a.mp4","file_name":"a.mp4","size":10,"reservation_id":"upload-a","created_at":1,"updated_at":1}"#,
        )
        .unwrap();
        assert!(session.completed_path.is_none());
        assert!(session.last_modified.is_none());
    }
}
