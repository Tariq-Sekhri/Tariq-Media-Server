use super::*;

fn quota_user(id: u64, name: &str) -> StoredUser {
    StoredUser {
        id, name: name.into(), password_hash: None, created_at: 0,
        is_admin: false, admin_permissions: AdminPermissions::default(),
        password_version: 0, avatar: None, storage_quota_bytes: Some(100),
    }
}

#[test]
fn known_download_size_respects_remaining_quota_and_finalizes_only_its_owner() {
    let first = quota_user(11, "Viewer One");
    let second = quota_user(12, "Viewer Two");
    let mut ledger = StorageLedger::default();
    assert!(reserve_storage(&mut ledger, &first, "prior", "upload", 40));
    assert!(reserve_storage(&mut ledger, &second, "other", "upload", 90));
    let (size, estimated) = ytdlp_estimated_bytes(&serde_json::json!({"filesize": 60, "duration": 9999}), "video");
    assert_eq!((size, estimated), (Some(60), false));
    assert!(reserve_storage(&mut ledger, &first, "download", "yt-dlp", size.unwrap()));
    assert!(!reserve_storage(&mut ledger, &first, "download", "yt-dlp", 61));
    assert_eq!(storage_usage(&ledger, first.id), (0, 100));
    finalize_storage_reservation(&mut ledger, "download", first.id, "yt-dlp", Some("download"), &[("Shared/clip.mp4".into(), 55)]);
    assert_eq!(storage_usage(&ledger, first.id), (55, 40));
    assert_eq!(storage_usage(&ledger, second.id), (0, 90));
    assert_eq!(storage_quota_response(&first, &ledger).available_bytes, Some(5));
}

#[test]
fn file_rules_and_membership_are_applied_together_per_account() {
    let first = quota_user(11, "Viewer One");
    let second = quota_user(12, "Viewer Two");
    let mut library = default_library_config("mixed".into());
    library.members.push(LibraryMember {
        name: first.name.clone(), can_view: true, can_delete: false, can_move: false,
        can_create_folders: false, can_upload: false, can_download: false, can_rename: false,
    });
    let libraries = BTreeMap::from([("Shared".to_owned(), library)]);
    for rule in [file_rule("/media/Shared/clip.mp4", None), file_rule("/api/qualities", Some("video_path=Shared%2Fclip.mp4"))] {
        let FileRule::LibraryPath(path) = rule else { panic!("expected a library path") };
        assert!(can_view_library_path(&first, &libraries, &path));
        assert!(!can_view_library_path(&second, &libraries, &path));
    }
    assert_eq!(file_rule("/api/qualities", Some("video_path=Shared%2F..%2FPrivate%2Fclip.mp4")), FileRule::Deny);
    assert!(!path_is_within("SharedExtra/clip.mp4", "Shared"));
}

#[test]
fn resume_keyframes_ignore_invalid_packets_and_select_latest_eligible_point() {
    let packets = "90.0,K__\nNaN,K__\n101.0,K__\n99.0,___\n95.0,K__\ninf,K__\n";
    assert_eq!(keyframe_at_or_before(packets, 100.0), Some(95.0));
    assert_eq!(keyframe_at_or_before(packets, 89.0), None);
    assert_eq!(keyframe_at_or_before(packets, 101.0), Some(101.0));
}

#[tokio::test]
async fn startup_duration_requires_segments_on_disk_and_accepts_complete_short_clip() {
    let root = std::env::temp_dir().join(format!("tms-regression-hls-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let playlist = root.join("stream.m3u8");
    let content = "#EXTM3U\n#EXTINF:1.5,\na.ts\n#EXTINF:2.5,\nb.ts\n";
    std::fs::write(root.join("a.ts"), b"a").unwrap();
    std::fs::write(&playlist, content).unwrap();
    assert_eq!(playlist_playable_buffer(&playlist, 4.0).await, None);
    std::fs::write(root.join("b.ts"), b"b").unwrap();
    assert_eq!(playlist_playable_buffer(&playlist, 4.0).await, Some((2, 4.0)));
    assert_eq!(playlist_playable_buffer(&playlist, 4.1).await, None);
    std::fs::write(&playlist, format!("{content}#EXT-X-ENDLIST\n")).unwrap();
    assert_eq!(playlist_playable_buffer(&playlist, 4.1).await, Some((2, 4.0)));
    std::fs::remove_file(root.join("b.ts")).unwrap();
    assert_eq!(playlist_playable_buffer(&playlist, 4.1).await, None);
    std::fs::remove_dir_all(root).unwrap();
}
