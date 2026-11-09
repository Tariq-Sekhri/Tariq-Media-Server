use super::*;

fn owner() -> StoredUser {
    StoredUser {
        id: 7, name: "Storage test".into(), password_hash: None, created_at: 1,
        is_admin: false, admin_permissions: AdminPermissions::default(), password_version: 0,
        avatar: None, storage_quota_bytes: Some(100),
    }
}

#[test]
fn reservation_rejection_preserves_the_original_hold() {
    let user = owner();
    let mut ledger = StorageLedger::default();
    assert!(reserve_storage(&mut ledger, &user, "job", "yt-dlp", 60));
    assert!(reserve_storage(&mut ledger, &user, "other", "upload", 40));
    let before = serde_json::to_value(&ledger).unwrap();
    assert!(!reserve_storage(&mut ledger, &user, "job", "yt-dlp", 61));
    assert_eq!(serde_json::to_value(&ledger).unwrap(), before);
    assert_eq!(storage_usage(&ledger, user.id), (0, 100));
    assert!(reserve_storage(&mut ledger, &user, "job", "yt-dlp", 50));
    assert_eq!(storage_usage(&ledger, user.id), (0, 90));
}

#[test]
fn reservation_replacement_charges_the_new_owner_without_losing_the_old_hold_on_rejection() {
    let user = owner();
    let mut second = owner();
    second.id = 8;
    second.storage_quota_bytes = Some(50);
    let mut ledger = StorageLedger::default();
    assert!(reserve_storage(&mut ledger, &user, "job", "discover", 60));
    assert!(!reserve_storage(&mut ledger, &second, "job", "discover", 60));
    assert_eq!(storage_usage(&ledger, user.id), (0, 60));
    assert!(reserve_storage(&mut ledger, &second, "job", "discover", 40));
    assert_eq!(storage_usage(&ledger, user.id), (0, 0));
    assert_eq!(storage_usage(&ledger, second.id), (0, 40));
}

#[test]
fn reservation_expansion_keeps_admins_unlimited_with_legacy_limits() {
    let mut user = owner();
    user.is_admin = true;
    let mut ledger = StorageLedger::default();
    assert!(reserve_storage(&mut ledger, &user, "job", "yt-dlp", 60));
    assert!(reserve_storage(&mut ledger, &user, "job", "yt-dlp", 200));
    assert_eq!(storage_usage(&ledger, user.id), (0, 200));
    assert_eq!(storage_quota_response(&user, &ledger).available_bytes, None);
}

#[tokio::test]
async fn reservation_rolls_back_when_the_download_job_cannot_be_saved() {
    let base = std::env::temp_dir().join(format!("tms-reservation-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let storage = base.join("storage.json");
    let blocked_jobs = base.join("jobs.json");
    std::fs::create_dir(&blocked_jobs).unwrap();
    let mut before = StorageLedger::default();
    assert!(reserve_storage(&mut before, &owner(), "unrelated", "upload", 10));
    let mut after = before.clone();
    assert!(reserve_storage(&mut after, &owner(), "new", "yt-dlp", 30));
    assert!(write_reserved_ytdlp_jobs(&storage, &blocked_jobs, &before, &after, &YtDlpJobs::default()).await.is_err());
    let saved = read_storage_ledger(&storage).await;
    assert_eq!(serde_json::to_value(saved).unwrap(), serde_json::to_value(before).unwrap());
    std::fs::remove_dir_all(base).unwrap();
}
