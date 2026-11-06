use crate::{PlaybackActivity, PlaybackState, UserState};

// The app sends save_progress = false for libraries set to start from the beginning.
pub fn record(state: &mut UserState, activity: &PlaybackActivity, updated: u64) {
    if activity.save_progress {
        state.playback.insert(activity.path.clone(), PlaybackState {
            position: activity.position.max(0.0),
            duration: activity.duration.max(0.0),
            updated,
            completed: activity.event == "completed",
        });
    } else {
        state.playback.remove(&activity.path);
    }
    state.last_accessed.insert(activity.path.clone(), updated);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_start_progress_is_removed_but_access_is_kept() {
        let mut state = UserState::default();
        let mut activity = PlaybackActivity {
            event: "paused".into(), media_name: "Track".into(),
            path: "Other/audio.mp3".into(), position: 120.0, duration: 600.0, save_progress: true,
        };
        record(&mut state, &activity, 1);
        assert_eq!(state.playback[&activity.path].position, 120.0);
        let old = state.playback[&activity.path].clone();
        activity.path = "Sleep/artist/audio.mp3".into();
        activity.save_progress = false;
        state.playback.insert(activity.path.clone(), old);
        record(&mut state, &activity, 2);
        assert!(!state.playback.contains_key(&activity.path));
        assert_eq!(state.last_accessed[&activity.path], 2);
        assert!(state.playback.contains_key("Other/audio.mp3"));
        activity.save_progress = true;
        record(&mut state, &activity, 3);
        assert_eq!(state.playback[&activity.path].position, 120.0);
    }

    #[test]
    fn progress_is_saved_when_the_flag_is_missing() {
        let activity: PlaybackActivity = serde_json::from_str(r#"{"event":"paused","media_name":"a","path":"Any/a.mp3","position":1,"duration":2}"#).unwrap();
        assert!(activity.save_progress);
    }
}
