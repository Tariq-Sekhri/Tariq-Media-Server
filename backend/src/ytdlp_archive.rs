use std::{collections::HashSet, io, path::Path, time::SystemTime};

use serde_json::Value;

/// yt-dlp owns the persistent archive; cache it for average O(1) TMS lookups.
#[derive(Default)]
pub(crate) struct DownloadArchive {
    stamp: Option<(u64, SystemTime)>,
    ids: HashSet<String>,
}

impl DownloadArchive {
    pub(crate) async fn contains_video(
        &mut self,
        path: &Path,
        metadata: &Value,
    ) -> io::Result<bool> {
        let candidates = video_archive_ids(metadata);
        if candidates.is_empty() {
            return Ok(false);
        }
        let file = match tokio::fs::metadata(path).await {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.stamp = None;
                self.ids.clear();
                return Ok(false);
            }
            Err(error) => return Err(error),
        };
        let stamp = (file.len(), file.modified()?);
        if self.stamp != Some(stamp) {
            let contents = tokio::fs::read_to_string(path).await?;
            self.ids = contents
                .lines()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .collect();
            self.stamp = Some(stamp);
        }
        Ok(candidates.iter().any(|id| self.ids.contains(id)))
    }
}

fn video_archive_ids(metadata: &Value) -> Vec<String> {
    // A playlist's ID is not a video ID, even when it contains just one item.
    if metadata.get("entries").is_some()
        || matches!(
            metadata.get("_type").and_then(Value::as_str),
            Some("playlist" | "multi_video")
        )
    {
        return Vec::new();
    }
    let mut ids = Vec::new();
    if let (Some(extractor), Some(id)) = (
        metadata
            .get("extractor_key")
            .or_else(|| metadata.get("ie_key"))
            .and_then(Value::as_str),
        metadata.get("id").and_then(Value::as_str),
    ) {
        ids.push(format!("{} {id}", extractor.to_lowercase()));
    }
    if let Some(old_ids) = metadata.get("_old_archive_ids").and_then(Value::as_array) {
        ids.extend(old_ids.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    ids
}

pub(crate) fn has_archive_skip(stdout: &str) -> bool {
    stdout.lines().any(|line| {
        line.starts_with("[download] ")
            && line.contains(" has already been recorded in the archive")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn archive_survives_restart_and_refreshes_after_append_or_removal() {
        let path =
            std::env::temp_dir().join(format!("tms-archive-test-{}.txt", uuid::Uuid::new_v4()));
        let first = json!({"extractor_key": "Youtube", "id": "first"});
        let second = json!({"extractor_key": "Youtube", "id": "second"});
        let mut archive = DownloadArchive::default();
        assert!(!archive.contains_video(&path, &first).await.unwrap());
        tokio::fs::write(&path, "youtube first\n").await.unwrap();
        assert!(archive.contains_video(&path, &first).await.unwrap());
        assert!(!archive.contains_video(&path, &second).await.unwrap());
        assert!(
            !archive
                .contains_video(&path, &json!({"extractor_key": "Other", "id": "first"}))
                .await
                .unwrap()
        );
        assert!(archive.contains_video(&path, &json!({"extractor_key": "New", "id": "new", "_old_archive_ids": ["youtube first"]})).await.unwrap());
        assert!(
            !archive
                .contains_video(
                    &path,
                    &json!({"extractor_key": "Youtube", "id": "first", "entries": []})
                )
                .await
                .unwrap()
        );
        tokio::fs::write(&path, "youtube first\nyoutube second\n")
            .await
            .unwrap();
        assert!(archive.contains_video(&path, &second).await.unwrap());
        assert!(
            DownloadArchive::default()
                .contains_video(&path, &second)
                .await
                .unwrap()
        );
        tokio::fs::remove_file(&path).await.unwrap();
        assert!(!archive.contains_video(&path, &first).await.unwrap());
    }

    #[test]
    fn empty_output_is_not_proof_of_an_archive_skip() {
        assert!(!has_archive_skip(""));
        assert!(!has_archive_skip(
            "[download] Finished downloading playlist"
        ));
        assert!(has_archive_skip(
            "[download] first: Video has already been recorded in the archive\n"
        ));
    }
}
