use serde_json::Value;

fn aired(date: &Value, today: &str) -> bool {
    let Some(date) = date.as_str().and_then(|s| s.get(..10)) else {
        return false;
    };
    let parts: Vec<_> = date.split('-').collect();
    if parts.len() != 3 {
        return false;
    }
    let valid = parts[0]
        .parse::<i32>()
        .ok()
        .zip(parts[1].parse::<u8>().ok())
        .zip(parts[2].parse::<u8>().ok())
        .is_some_and(|((year, month), day)| {
            time::Month::try_from(month)
                .ok()
                .is_some_and(|month| time::Date::from_calendar_date(year, month, day).is_ok())
        });
    valid && date <= today
}

pub(super) fn digital_movie(releases: &Value, today: &str) -> bool {
    releases["results"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|country| {
            country["release_dates"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|release| release["type"] == 4 && aired(&release["release_date"], today))
        })
}

pub(super) fn completed_season(detail: &Value, season: &Value, today: &str) -> bool {
    let number = season["season_number"].as_u64();
    // Specials are open-ended; they do not establish a completed season.
    if number.is_none_or(|n| n == 0) {
        return false;
    }
    let Some(episodes) = season["episodes"].as_array() else {
        return false;
    };
    let count = detail["seasons"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| row["season_number"].as_u64() == number)
        .and_then(|row| row["episode_count"].as_u64())
        .unwrap_or(0);
    count > 0
        && episodes.len() as u64 == count
        && episodes
            .iter()
            .all(|episode| aired(&episode["air_date"], today))
        && !detail["next_episode_to_air"]["season_number"]
            .as_u64()
            .is_some_and(|n| Some(n) == number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn movies_need_an_actual_past_digital_date() {
        for (kind, date, expected) in [
            (3, "2020-01-01", false),
            (4, "2026-10-11", true),
            (4, "2026-10-12", false),
            (4, "", false),
            (4, "2026-02-30", false),
        ] {
            assert_eq!(
                digital_movie(
                    &json!({"results":[{"release_dates":[{"type":kind,"release_date":date}]}]}),
                    "2026-10-11"
                ),
                expected
            );
        }
    }
    #[test]
    fn seasons_require_all_known_episodes_to_have_aired() {
        let mut detail =
            json!({"status":"Returning Series","seasons":[{"season_number":1,"episode_count":2}]});
        let mut season = json!({"season_number":1,"episodes":[{"air_date":"2026-01-01"},{"air_date":"2026-10-11"}]});
        assert!(completed_season(&detail, &season, "2026-10-11"));
        season["episodes"][1]["air_date"] = json!("2026-10-12");
        assert!(!completed_season(&detail, &season, "2026-10-11"));
        season["episodes"][1]["air_date"] = Value::Null;
        assert!(!completed_season(&detail, &season, "2026-10-11"));
        detail["status"] = json!("Ended");
        assert!(!completed_season(&detail, &season, "2026-10-11"));
        season["episodes"][1]["air_date"] = json!("2026-10-11");
        detail["next_episode_to_air"] = json!({"season_number":1});
        assert!(!completed_season(&detail, &season, "2026-10-11"));
        detail["next_episode_to_air"] = Value::Null;
        detail["seasons"][0]["episode_count"] = json!(3);
        assert!(!completed_season(&detail, &season, "2026-10-11"));
    }
}
