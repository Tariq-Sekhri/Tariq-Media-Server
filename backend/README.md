# TMS server

Local Rust backend for TMS (Tariq’s Media Server). It binds to `127.0.0.1:8787`
and reads media from `C:\TariqsMediaServer` by default.

```powershell
npm run backend:dev
```

`npm run backend:dev` uses `cargo-watch` to rebuild and restart the server when
Rust sources change. The first run installs `cargo-watch` automatically.
Running `./start_tms.ps1` builds the backend before launch and restarts any
stale backend process so it always matches the current code.

Endpoints:

- `GET /api/health` reports backend and library availability.
- `GET /api/library` returns the copied folder/file tree as a flat JSON list.
- `GET /api/libraries` returns local library settings; `PUT /api/libraries`
  updates a top-level library's content type and access list.
- `PUT /api/library-title-folders` marks a nested folder in a Movies & TV
  library as a movie/show title folder.
- `GET /api/admin/logs` returns recent TMS server logs for the local
  Admin Dashboard.
- `GET /api/admin/users` lists users without exposing password hashes;
  `POST`, `PUT`, and `DELETE` create, update, and remove users.
- Full administrators bypass all checks. Other accounts can be granted explicit
  admin-panel, user, log, library, and server-download capabilities. User
  managers cannot promote accounts or modify full administrators.
- `GET /media/<relative-path>` streams a file from the copied library.

Optional environment variables:

- `TMS_LIBRARY_ROOT`: override the local media-copy directory.
- `TMS_PORT`: override port `8787`.

The former `FRAMEBOX_*` names remain compatibility fallbacks. Never set
`TMS_LIBRARY_ROOT` to the live `C:\JellyFin` directory.
