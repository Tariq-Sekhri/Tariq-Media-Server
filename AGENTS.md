# Browser validation

Use browser testing or browser automation only when the user explicitly asks for it. Do not automatically open the browser to validate routine code changes. Use focused non-browser checks appropriate to the change and report any validation limitations.

When validating browser behavior, use the user's real browser and existing signed-in session. Do not use the inbuilt browser or collaborative preview for validation. The real browser is already logged into the user's account, so validation should exercise that account and session.

If the real browser cannot be accessed, report that limitation instead of switching to the inbuilt browser.

# Automatic frontend rebuilds

TMS automatically rebuilds and restarts the production frontend when frontend source files change. The watcher is `scripts/watch-production-frontend.ps1`, started by the normal `start_tms.ps1` launcher.

After making frontend changes, wait for the watcher to finish rebuilding and restarting before validating in the browser. Check the watcher log at `C:\TariqsMediaServer\.tms-data\tms-frontend-watcher.log` (or the configured data directory), then verify that `/tms-release` identifies a live release whose `source-stamp.txt` matches the current checkout using `Get-TmsFrontendSourceStamp` from `scripts/frontend-source-stamp.ps1`.

Do not manually stop the frontend or ask the user to restart TMS merely because the browser initially shows the old build. An "Access is denied" error from a manual stop does not mean the automatic watcher is blocked. Wait and inspect the watcher logs and live release first. Only request a restart if there is evidence that the automatic rebuild/restart has failed or the watcher is not running.

# Build directories

Use the repository's normal configured build and output directories. Do not create or use separate temporary or isolated build directories, including Cargo `--target-dir` or `CARGO_TARGET_DIR` overrides. If a build directory is locked, wait for it or report the blocker instead of using another directory.

# Commits

Commit the intended source and documentation changes when the authorized work is finished. Use main unless the user requests another branch. Preserve unrelated changes and do not include generated build artifacts in the commit.

# Mobile releases

Pushing to `main` triggers the Android internal testing release (`.github/workflows/android-play-release.yml`). Any change that affects the mobile app must be committed, and it ships to phones only after it is pushed. Do not push on your own: commit locally and push only when the user explicitly says to, so internal releases are not spammed. When mobile work is committed but not pushed, tell the user it still needs a push to reach the phone.

# Old history

Commits before the clean restart (2026-11-06) are in the private `Tariq-Media-Server-archive` repo, available as the `archive` remote. Run `git fetch archive` and look at `archive/main` or other `archive/*` branches when you need old commits. Never push archive history to `origin`.
