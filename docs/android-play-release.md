# Android Internal testing releases

Push to `main` to build a signed bundle and publish it to Google Play Internal
testing. The workflow can also be started manually on `main`.

Version codes are `100000 + GITHUB_RUN_NUMBER`. Version names use the npm version
plus `-ci.<run number>`. Future manual uploads must use a version code higher than
the latest CI upload. Production promotion remains a Play Console action.

The `build` job saves `tms-play-bundle` for 30 days. If publishing fails, use
GitHub Actions **Re-run failed jobs** to retry the separate `publish` job with
the same signed artifact. Do not rerun a release already accepted by Play.

Repository secrets hold the existing upload keystore, its passwords and alias
(`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`), plus `TMS_CAPACITOR_SERVER_URL`. The server URL preserves
the existing app's online entry point; CI fails if it is missing.

`GCP_SERVICE_ACCOUNT` identifies `tms-play-publisher` in Cloud project
`project-33477e16-5086-4c11-933`. `GCP_WORKLOAD_IDENTITY_PROVIDER` is
`projects/837350808864/locations/global/workloadIdentityPools/android-apps-github/providers/github`.
Google verifies repository ID `1447990908`, owner ID `34610622`, and `main`.
Only that repository identity can impersonate the publisher. The publisher has
view and testing-release permissions only for `ca.sekhrit.tms`.

No persistent Google service-account key is stored. Publishing uses a short-lived
OIDC access token and the Google Play Developer API. The build needs no access
to live media, production storage or the running TMS server.
