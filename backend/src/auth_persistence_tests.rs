use super::*;

// Exercise the actual auth readers while heartbeats/account updates replace the
// files. In-place writes can return an empty account/session list to these reads.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn auth_records_remain_readable_during_updates() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let root = std::env::temp_dir().join(format!("tms-auth-test-{}", uuid::Uuid::new_v4()));
    let sessions_path = root.join("sessions.json");
    let users_path = root.join("users.json");
    let sessions: Vec<_> = (0..32)
        .map(|id| StoredSession {
            token: format!("device-{id}"),
            access_token: String::new(),
            expires_at: 0,
            user_id: id,
            password_version: 0,
            created_at: 1,
            last_active_at: 1,
            device_id: format!("browser-{id}"),
            device_name: "Browser".to_owned(),
            user_agent: "test".repeat(100),
            ip_address: String::new(),
        })
        .collect();
    let users: Vec<_> = (0..32)
        .map(|id| StoredUser {
            id,
            name: format!("User {id}"),
            password_hash: None,
            created_at: 1,
            is_admin: false,
            admin_permissions: AdminPermissions::default(),
            password_version: 0,
            avatar: None,
            storage_quota_bytes: None,
        })
        .collect();
    write_sessions(&sessions_path, &sessions).await.unwrap();
    write_users(&users_path, &users).await.unwrap();
    let mut readers = Vec::new();
    for _ in 0..4 {
        let sessions_path = sessions_path.clone();
        let users_path = users_path.clone();
        readers.push(tokio::spawn(async move {
            for _ in 0..400 {
                let records = read_sessions(&sessions_path).await;
                assert_eq!(records.len(), 32, "session disappeared during heartbeat");
                assert!(
                    records
                        .iter()
                        .any(|s| session_accepts_access_token(s, "device-1"))
                );
                assert_eq!(
                    read_users(&users_path).await.len(),
                    32,
                    "accounts disappeared during update"
                );
            }
        }));
    }
    for _ in 0..100 {
        write_sessions(&sessions_path, &sessions).await.unwrap();
        write_users(&users_path, &users).await.unwrap();
    }
    let mut failures = Vec::new();
    for reader in readers {
        if let Err(error) = reader.await {
            failures.push(error);
        }
    }
    // Revocation must still be visible immediately after a completed write.
    write_sessions(&sessions_path, &sessions[2..])
        .await
        .unwrap();
    assert!(
        !read_sessions(&sessions_path)
            .await
            .iter()
            .any(|s| session_accepts_access_token(s, "device-1"))
    );
    std::fs::remove_dir_all(root).unwrap();
    assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn auth_updates_preserve_corrupt_records_for_recovery() {
    let root = std::env::temp_dir().join(format!("tms-auth-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    for name in ["sessions.json", "users.json"] {
        tokio::fs::write(root.join(name), b"damaged").await.unwrap();
    }
    assert!(
        write_sessions(&root.join("sessions.json"), &[])
            .await
            .is_err()
    );
    assert!(write_users(&root.join("users.json"), &[]).await.is_err());
    for name in ["sessions.json", "users.json"] {
        assert_eq!(tokio::fs::read(root.join(name)).await.unwrap(), b"damaged");
    }
    std::fs::remove_dir_all(root).unwrap();
}
