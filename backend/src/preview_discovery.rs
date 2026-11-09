use std::{sync::Mutex, time::Instant};

/// Keep the first change in a burst so coalescing never understates its delay.
#[derive(Default)]
pub(crate) struct DiscoverySignal {
    first_change: Mutex<Option<Instant>>,
    pub(crate) notify: tokio::sync::Notify,
}

impl DiscoverySignal {
    pub(crate) fn changed(&self) {
        self.first_change.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Instant::now);
        // notify_one retains a permit if discovery is still scanning.
        self.notify.notify_one();
    }

    pub(crate) fn take_change(&self) -> Option<Instant> {
        self.first_change.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// A completed run may leave failed videos. Rediscovery should notice new or
/// changed sources, without turning the fallback scan into an endless retry loop.
#[derive(Default)]
pub(crate) struct PendingWork(std::collections::HashMap<String, std::collections::HashSet<String>>);

impl PendingWork {
    pub(crate) fn has_new(&mut self, library: &str, keys: std::collections::HashSet<String>) -> bool {
        let has_new = keys.iter().any(|key| !self.0.get(library).is_some_and(|previous| previous.contains(key)));
        self.0.insert(library.to_owned(), keys);
        has_new
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn preview_discovery_queues_new_sources_without_retrying_unchanged_failures() {
        let mut work = PendingWork::default();
        let keys = |values: &[&str]| values.iter().map(|value| value.to_string()).collect();
        assert!(work.has_new("library", keys(&["video-a-v1", "video-b-v1"])));
        assert!(!work.has_new("library", keys(&["video-b-v1"])));
        assert!(!work.has_new("library", keys(&["video-b-v1"])));
        assert!(work.has_new("library", keys(&["video-b-v2"])));
        assert!(work.has_new("library", keys(&["video-b-v2", "video-c-v1"])));
        assert!(!work.has_new("library", keys(&[])));
        assert!(work.has_new("library", keys(&["video-c-v1"])));
        assert!(work.has_new("other-library", keys(&["video-c-v1"])));
    }

    #[test]
    fn preview_discovery_inventory_finds_added_and_replaced_videos() {
        let base = std::env::temp_dir().join(format!("tms-preview-discovery-{}", uuid::Uuid::new_v4()));
        let library = base.join("library");
        let previews = base.join("previews");
        std::fs::create_dir_all(&library).unwrap();
        let complete = library.join("complete.mp4");
        let pending = library.join("pending.mp4");
        let audio_only = library.join("audio.mp4");
        for path in [&complete, &pending, &audio_only] { std::fs::write(path, b"media").unwrap(); }
        std::fs::write(library.join("image.jpg"), b"image").unwrap();
        let output = |path: &std::path::Path| previews.join(crate::trickplay_key(&path.strip_prefix(&base).unwrap().to_string_lossy().replace('\\', "/"), &path.metadata().unwrap()));
        let complete_output = output(&complete);
        std::fs::create_dir_all(&complete_output).unwrap();
        std::fs::write(complete_output.join(crate::trickplay_frame_name(0)), b"jpg").unwrap();
        crate::write_trickplay_marker(&complete_output, 0);
        let audio_output = output(&audio_only);
        std::fs::create_dir_all(&audio_output).unwrap();
        std::fs::write(audio_output.join("no-video"), b"no video stream").unwrap();
        let scan = || crate::scan_trickplay_inventory(&library, &base, &previews, &Default::default());
        let (work, done, total) = scan();
        assert_eq!(work, vec![pending.clone()]);
        assert_eq!((done, total), (1, 2));
        let added = library.join("added.mp4");
        std::fs::write(&added, b"new media").unwrap();
        assert!(scan().0.contains(&added));
        // A replacement must not inherit the old file's completed previews.
        std::fs::write(&complete, b"replacement with different size").unwrap();
        assert!(scan().0.contains(&complete));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn preview_discovery_keeps_changes_received_during_a_scan() {
        let signal = DiscoverySignal::default();
        signal.changed();
        assert!(signal.take_change().is_some());
        signal.notify.notified().await;
        // A change arriving before the next wait must still wake it.
        signal.changed();
        tokio::time::timeout(Duration::from_millis(100), signal.notify.notified()).await.unwrap();
        assert!(signal.take_change().is_some());
    }

    #[test]
    fn preview_discovery_measures_from_first_change_in_burst() {
        let signal = DiscoverySignal::default();
        signal.changed();
        let first = *signal.first_change.lock().unwrap();
        signal.changed();
        assert_eq!(signal.take_change(), first);
        assert!(signal.take_change().is_none());
    }
}
