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
fn copy_video_seek_probe_validates_alignment_and_timebases() {
    let mkv_probe = "\
#tb 0: 1/1000
#tb 1: 1/1000
0, -1075, -992, 41, 95118, 0x42c4c299
1, -992, -992, 21, 339, 0x1ed39d1b
";
    assert_eq!(parse_copy_video_seek_probe(mkv_probe, 92), Some(91.008));

    let misaligned_audio = "\
#tb 0: 1/1000
#tb 1: 1/1000
0, -2940, -2940, 41, 95118, 0x42c4c299
1, 0, 0, 21, 339, 0x1ed39d1b
";
    assert_eq!(parse_copy_video_seek_probe(misaligned_audio, 92), None);
}

fn flag_pair_index(args: &[String], flag: &str, value: &str) -> Option<usize> {
    args.windows(2).position(|pair| pair[0] == flag && pair[1] == value)
}

#[test]
fn copy_video_transcode_args_use_noaccurate_seek_and_clean_hls_flags() {
    let input = Path::new("Shows/Sample/Episode 01.mkv");
    let seg_pattern = Path::new("transcodes/sample/segment_%05d.ts");
    let playlist = Path::new("transcodes/sample/stream.m3u8");
    let to_strings = |args: Vec<std::ffi::OsString>| -> Vec<String> {
        args.into_iter().map(|s| s.to_string_lossy().into_owned()).collect()
    };

    let seek_copy = to_strings(build_hls_ffmpeg_args(
        input, 1080, 92, 0.0, Some(2), None, false, true, false, seg_pattern, playlist,
    ));
    let noaccurate_pos = seek_copy.iter().position(|a| a == "-noaccurate_seek").unwrap();
    let ss_pos = flag_pair_index(&seek_copy, "-ss", "92").unwrap();
    let input_pos = seek_copy.iter().position(|a| a == "-i").unwrap();
    assert_eq!(noaccurate_pos + 1, ss_pos);
    assert!(ss_pos < input_pos);
    assert!(flag_pair_index(&seek_copy, "-avoid_negative_ts", "make_zero").is_some());
    assert!(flag_pair_index(&seek_copy, "-c:v", "copy").is_some());
    assert!(!seek_copy.iter().any(|a| a == "-t"));
    assert!(flag_pair_index(&seek_copy, "-hls_flags", "independent_segments").is_some());

    let start_zero_copy = to_strings(build_hls_ffmpeg_args(
        input, 1080, 0, 0.0, Some(2), None, false, true, false, seg_pattern, playlist,
    ));
    assert!(!start_zero_copy.iter().any(|a| a == "-ss" || a == "-noaccurate_seek" || a == "-avoid_negative_ts"));
    assert!(flag_pair_index(&start_zero_copy, "-hls_flags", "independent_segments").is_some());

    let resumed_prefix = to_strings(build_hls_ffmpeg_args(
        input, 1080, 0, 12.012, Some(2), None, false, false, true, seg_pattern, playlist,
    ));
    assert!(!resumed_prefix.iter().any(|a| a == "-noaccurate_seek"));
    assert!(flag_pair_index(&resumed_prefix, "-ss", "12.012").is_some());
    assert!(flag_pair_index(&resumed_prefix, "-hls_flags", "independent_segments+append_list").is_some());

    let preload_encode = to_strings(build_hls_ffmpeg_args(
        input, 1080, 0, 0.0, Some(2), None, true, false, true, seg_pattern, playlist,
    ));
    assert!(flag_pair_index(&preload_encode, "-t", "12").is_some());
    assert!(flag_pair_index(&preload_encode, "-hls_flags", "independent_segments").is_some());
}

#[test]
fn copy_video_preload_is_never_truncated_or_spliced() {
    assert!(!should_skip_copy_video_preload(false, false));
    assert!(!should_skip_copy_video_preload(false, true));
    assert!(!should_skip_copy_video_preload(true, false));
    assert!(should_skip_copy_video_preload(true, true));

    assert_eq!(resolve_preloaded_hls_action(true, false, true, true), PreloadedHlsAction::ReplaceClean);
    assert_eq!(resolve_preloaded_hls_action(true, true, true, true), PreloadedHlsAction::ReplaceClean);
    assert_eq!(resolve_preloaded_hls_action(true, false, false, true), PreloadedHlsAction::AppendPrefix);
    assert_eq!(resolve_preloaded_hls_action(true, true, false, true), PreloadedHlsAction::ReuseComplete);
    assert_eq!(resolve_preloaded_hls_action(false, false, true, true), PreloadedHlsAction::ReuseComplete);
}

#[test]
fn copy_video_seek_and_hls_segments_keep_audio_and_video_aligned_in_mkv_and_mp4() {
    let ffmpeg = env::var_os("TMS_FFMPEG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\Jellyfin\Server\ffmpeg.exe"));
    if !ffmpeg.is_file() {
        return;
    }
    let ffprobe = ffmpeg.with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if !ffprobe.is_file() {
        return;
    }
    struct TempDirGuard(PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let root = std::env::temp_dir().join(format!("tms-hls-copy-seek-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let _guard = TempDirGuard(root.clone());

    let mkv_clip = root.join("sample.mkv");
    let gen_mkv = hidden_sync_command(&ffmpeg)
        .args([
            "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=10",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=10",
            "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=10",
            "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-g", "72", "-keyint_min", "72", "-sc_threshold", "0",
            "-c:a", "aac", "-ar", "48000", "-ac", "2",
        ])
        .arg(&mkv_clip)
        .output()
        .unwrap();
    assert!(gen_mkv.status.success(), "{}", String::from_utf8_lossy(&gen_mkv.stderr));

    let mp4_clip = root.join("sample.mp4");
    let gen_mp4 = hidden_sync_command(&ffmpeg)
        .args([
            "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=10",
            "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=48000:duration=10",
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-g", "72", "-keyint_min", "72", "-sc_threshold", "0",
            "-c:a", "aac", "-ar", "48000", "-ac", "2",
        ])
        .arg(&mp4_clip)
        .output()
        .unwrap();
    assert!(gen_mp4.status.success(), "{}", String::from_utf8_lossy(&gen_mp4.stderr));

    for (idx, (clip, start, audio_stream)) in [
        (&mkv_clip, 5_u64, Some(2_u32)),
        (&mp4_clip, 5_u64, None),
        (&mkv_clip, 0_u64, Some(2_u32)),
    ]
    .into_iter()
    .enumerate()
    {
        if start > 0 {
            let probe = hidden_sync_command(&ffmpeg)
                .args(copy_video_seek_probe_args(clip, start, audio_stream))
                .output()
                .unwrap();
            assert!(probe.status.success(), "{}", String::from_utf8_lossy(&probe.stderr));
            let offset = parse_copy_video_seek_probe(&String::from_utf8_lossy(&probe.stdout), start)
                .expect("copy_video probe should align video and audio");
            assert!((1.5..=5.1).contains(&offset), "unexpected landed offset {offset}");
        }
        let out_dir = root.join(format!("hls_{idx}"));
        std::fs::create_dir_all(&out_dir).unwrap();
        let seg_pattern = out_dir.join("segment_%05d.ts");
        let playlist = out_dir.join("stream.m3u8");
        let hls = hidden_sync_command(&ffmpeg)
            .args(build_hls_ffmpeg_args(
                clip, 90, start, 0.0, audio_stream, None, false, true, false, &seg_pattern, &playlist,
            ))
            .output()
            .unwrap();
        assert!(hls.status.success(), "{}", String::from_utf8_lossy(&hls.stderr));

        let m3u8 = std::fs::read_to_string(&playlist).unwrap();
        assert_eq!(m3u8.matches("#EXT-X-DISCONTINUITY").count(), 0, "{m3u8}");
        assert!(m3u8.contains("segment_00000.ts"), "{m3u8}");

        let seg0 = out_dir.join("segment_00000.ts");
        let packets = hidden_sync_command(&ffprobe)
            .args(["-v", "error", "-show_entries", "packet=codec_type,pts_time", "-of", "csv=p=0"])
            .arg(&seg0)
            .output()
            .unwrap();
        assert!(packets.status.success(), "{}", String::from_utf8_lossy(&packets.stderr));
        let mut video_pts = Vec::new();
        let mut audio_pts = Vec::new();
        for line in String::from_utf8_lossy(&packets.stdout).lines() {
            let mut parts = line.trim().split(',');
            let Some(kind) = parts.next() else { continue };
            let Some(pts) = parts.next().and_then(|v| v.parse::<f64>().ok()) else { continue };
            if kind == "video" {
                video_pts.push(pts);
            } else if kind == "audio" {
                audio_pts.push(pts);
            }
        }
        assert!(!video_pts.is_empty(), "segment_00000.ts missing video packets");
        assert!(!audio_pts.is_empty(), "segment_00000.ts missing audio packets");
        let min_v = video_pts.into_iter().reduce(f64::min).unwrap();
        let min_a = audio_pts.into_iter().reduce(f64::min).unwrap();
        assert!((min_v - min_a).abs() <= 0.35, "A/V start skew too large: v={min_v}, a={min_a}");
    }
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
