use super::*;

const ACTIVE_DOWNLOAD_BYTES_PER_SECOND: u64 = 5 * 1024 * 1024;

// Query interactive sessions even when the backend runs as SYSTEM.
// Unknown lock state uses the cap until Windows confirms the screen is locked.
#[cfg(windows)]
pub(super) fn system_in_use() -> bool {
    use windows_sys::Win32::System::RemoteDesktop::*;
    unsafe {
        let mut sessions = std::ptr::null_mut();
        let mut count = 0;
        if WTSEnumerateSessionsW(std::ptr::null_mut(), 0, 1, &mut sessions, &mut count) == 0 {
            return true;
        }
        if sessions.is_null() {
            return true;
        }
        let rows = std::slice::from_raw_parts(sessions, count as usize);
        let mut in_use = false;
        for session in rows.iter().filter(|session| session.State == WTSActive) {
            let mut buffer = std::ptr::null_mut();
            let mut bytes = 0;
            if WTSQuerySessionInformationW(
                std::ptr::null_mut(),
                session.SessionId,
                WTSSessionInfoEx,
                &mut buffer,
                &mut bytes,
            ) == 0
            {
                in_use = true;
                break;
            }
            let valid = !buffer.is_null() && bytes as usize >= std::mem::size_of::<WTSINFOEXW>();
            let locked = valid && {
                let info = &*(buffer as *const WTSINFOEXW);
                info.Level == 1
                    && info.Data.WTSInfoExLevel1.SessionFlags as u32 == WTS_SESSIONSTATE_LOCK
            };
            WTSFreeMemory(buffer as *mut _);
            if !locked {
                in_use = true;
                break;
            }
        }
        WTSFreeMemory(sessions as *mut _);
        in_use
    }
}

#[cfg(not(windows))]
pub(super) fn system_in_use() -> bool {
    false
}

fn torrent_limit(in_use: bool, count: usize) -> u64 {
    if in_use {
        (ACTIVE_DOWNLOAD_BYTES_PER_SECOND / count.max(1) as u64).max(1)
    } else {
        0
    }
}

pub(super) fn initial_limit(speed_cap_enabled: bool) -> u64 {
    torrent_limit(speed_cap_enabled && system_in_use(), 1)
}

// Uncapped admin jobs do not take a share of the capped downloads' budget.
fn limit_changes(
    torrents: &[QbittorrentTorrent],
    tracked: &BTreeSet<String>,
    jobs: &MagnetJobs,
    users: &[StoredUser],
    in_use: bool,
) -> BTreeMap<u64, Vec<String>> {
    let active: Vec<_> = torrents
        .iter()
        .filter(|torrent| {
            torrent.category == "TMS"
                && tracked.contains(&torrent.hash)
                && !qbittorrent_torrent_is_complete(torrent)
        })
        .map(|torrent| {
            let capped = jobs
                .jobs
                .iter()
                .find(|job| job.hash.eq_ignore_ascii_case(&torrent.hash))
                .is_none_or(|job| job.uses_speed_cap(users));
            (torrent, capped)
        })
        .collect();
    let capped_count = active
        .iter()
        .filter(|(torrent, capped)| *capped && !qbittorrent_torrent_is_stopped(torrent))
        .count();
    let mut changes = BTreeMap::<u64, Vec<String>>::new();
    for (torrent, capped) in active {
        let limit = torrent_limit(in_use && capped, capped_count);
        if torrent.dl_limit.max(0) as u64 != limit {
            changes.entry(limit).or_default().push(torrent.hash.clone());
        }
    }
    changes
}

pub(super) async fn apply_limits(
    state: &AppState,
    session: &QbittorrentSession,
    torrents: &[QbittorrentTorrent],
    tracked: &BTreeSet<String>,
) -> Result<(), String> {
    let jobs = read_magnet_jobs(&state.magnet_jobs_path).await;
    let users = read_users(&state.users_path).await;
    for (limit, hashes) in limit_changes(torrents, tracked, &jobs, &users, system_in_use()) {
        let count = hashes.len();
        let mut request = state
            .qbittorrent_http
            .post(format!(
                "{}/api/v2/torrents/setDownloadLimit",
                session.base_url
            ))
            .header(reqwest::header::REFERER, &session.base_url)
            .form(&[("hashes", hashes.join("|")), ("limit", limit.to_string())]);
        if let Some(cookie) = &session.cookie {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        if !request
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            tracing::warn!(limit, "Could not apply download speed policy; will retry");
            return Err("Could not apply download speed policy.".to_owned());
        }
        tracing::info!(limit, downloads = count, "Applied download speed policy");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unlocked_transfers_share_cap_and_locked_transfers_are_unlimited() {
        assert_eq!(torrent_limit(true, 1), 5 * 1024 * 1024);
        assert_eq!(torrent_limit(true, 2), 5 * 1024 * 1024 / 2);
        assert_eq!(torrent_limit(false, 5), 0);
        assert!(torrent_limit(true, 0) > 0);
    }
    fn user(id: u64, full_admin: bool) -> StoredUser {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": "Test", "password_hash": null, "created_at": 0,
            "is_admin": full_admin,
            "admin_permissions": { "access_admin_panel": true, "view_processes": true }
        }))
        .unwrap()
    }

    fn job(hash: &str, user_id: u64, cap: Option<bool>) -> MagnetJob {
        serde_json::from_value(serde_json::json!({
            "hash": hash, "user_id": user_id, "user_name": "Test",
            "destination_path": "Movies/Test", "reservation_id": hash,
            "reserved_bytes": 0, "status": "downloading", "error": null,
            "created_at": 0, "updated_at": 0, "speed_cap_enabled": cap
        }))
        .unwrap()
    }

    fn torrent(hash: &str, limit: i64) -> QbittorrentTorrent {
        serde_json::from_value(serde_json::json!({
            "hash": hash, "category": "TMS", "state": "downloading",
            "size": 100, "amount_left": 80, "progress": 0.2, "dl_limit": limit
        }))
        .unwrap()
    }

    #[test]
    fn legacy_admin_defaults_and_saved_overrides_survive_restart() {
        let users = [user(1, true), user(2, false)];
        let mut legacy = serde_json::to_value(job("admin", 1, None)).unwrap();
        legacy.as_object_mut().unwrap().remove("speed_cap_enabled");
        let legacy: MagnetJob = serde_json::from_value(legacy).unwrap();
        assert!(!legacy.uses_speed_cap(&users));
        assert!(job("limited-admin", 2, None).uses_speed_cap(&users));
        assert!(job("unknown-owner", 99, None).uses_speed_cap(&users));
        for cap in [true, false] {
            let saved = serde_json::to_vec(&job("admin", 1, Some(cap))).unwrap();
            let restored: MagnetJob = serde_json::from_slice(&saved).unwrap();
            assert_eq!(restored.uses_speed_cap(&users), cap);
        }
    }

    #[test]
    fn admin_uncapping_and_recapping_preserve_member_bandwidth_share() {
        let users = [user(1, true), user(2, false)];
        let torrents = [
            torrent("admin", 123),
            torrent("member-a", 0),
            torrent("member-b", 0),
        ];
        let tracked = torrents.iter().map(|t| t.hash.clone()).collect();
        let mut jobs = MagnetJobs {
            jobs: vec![
                job("admin", 1, None),
                job("member-a", 2, None),
                job("member-b", 2, None),
            ],
        };
        let changes = limit_changes(&torrents, &tracked, &jobs, &users, true);
        assert_eq!(changes[&0], vec!["admin"]);
        assert_eq!(
            changes[&(ACTIVE_DOWNLOAD_BYTES_PER_SECOND / 2)],
            vec!["member-a", "member-b"]
        );
        jobs.jobs[0].speed_cap_enabled = Some(true);
        let changes = limit_changes(&torrents, &tracked, &jobs, &users, true);
        assert_eq!(
            changes[&(ACTIVE_DOWNLOAD_BYTES_PER_SECOND / 3)],
            vec!["admin", "member-a", "member-b"]
        );
        jobs.jobs[0].speed_cap_enabled = Some(false);
        assert_eq!(
            limit_changes(&torrents, &tracked, &jobs, &users, true)[&0],
            vec!["admin"]
        );
        // A full admin can queue on behalf of a member without changing ownership.
        jobs.jobs[1].speed_cap_enabled = Some(false);
        assert_eq!(
            limit_changes(&torrents, &tracked, &jobs, &users, true)
                [&ACTIVE_DOWNLOAD_BYTES_PER_SECOND],
            vec!["member-b"]
        );
    }

    #[test]
    fn lock_removes_caps_and_policy_ignores_completed_and_untracked_torrents() {
        let mut torrents = vec![
            torrent("active", 500),
            torrent("done", 500),
            torrent("untracked", 500),
            torrent("other-category", 500),
        ];
        torrents[1].progress = 1.0;
        torrents[1].amount_left = 0;
        torrents[3].category = "elsewhere".to_owned();
        let tracked = ["active", "done", "other-category"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let changes = limit_changes(&torrents, &tracked, &MagnetJobs::default(), &[], false);
        assert_eq!(changes, BTreeMap::from([(0, vec!["active".to_owned()])]));
        torrents[0].dl_limit = -1;
        assert!(limit_changes(&torrents, &tracked, &MagnetJobs::default(), &[], false).is_empty());
    }

    #[test]
    fn paused_downloads_do_not_dilute_active_download_caps() {
        let mut torrents = [torrent("active", 0), torrent("paused", 0)];
        torrents[1].state = "stoppedDL".to_owned();
        let tracked = torrents.iter().map(|t| t.hash.clone()).collect();
        let changes = limit_changes(&torrents, &tracked, &MagnetJobs::default(), &[], true);
        assert_eq!(
            changes[&ACTIVE_DOWNLOAD_BYTES_PER_SECOND],
            vec!["active", "paused"]
        );
    }
}
