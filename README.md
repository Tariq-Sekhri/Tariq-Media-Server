# TMS

Tariq's Media Server combines streaming with direct control over the media library.
It grew out of two needs I had while using Jellyfin: giving users more ways to
manage media, and downloading movies from discovery through to playback in one app.

## How it compares to Jellyfin

This comparison focuses on Jellyfin's standard experience; plugins and companion
services can extend it.

| Workflow | TMS | Jellyfin |
| --- | --- | --- |
| Upload media | Upload files directly in the app | Typically copy files to the server outside the media app |
| Manage files and folders | Move and rename files, create folders, and organize in bulk | Typically use filesystem tools or external media managers for these operations |
| Control user actions | Per-library permissions for uploads, moves, renames, folder creation, deletion, and server downloads | Library access and media deletion permissions are built in |
| Download from YouTube and other sites | Submit a URL and queue a server download in the app using yt-dlp | Typically use a separate downloader |
| Discover and acquire movies | Find a movie in Discover, request or start its download, and track progress in the app | Typically add companion services such as Seerr and Radarr; integrations can bring requests into Jellyfin clients |

TMS keeps these workflows in one interface, with actions limited by the user's
permissions. Downloads still rely on server tools such as yt-dlp and qBittorrent.
It is built with React, Vinext, and Rust.

References: [Jellyfin user permissions](https://jellyfin.org/docs/general/server/users/adding-managing-users/),
[Jellyfin library setup](https://jellyfin.org/docs/general/server/libraries/),
and [Seerr integrations](https://docs.seerr.dev/).

## Run locally

Requires Windows PowerShell, Node.js **22.13+**, and Rust with Cargo.

```powershell
npm install
./start_tms.ps1
```

Open **http://localhost:3000**. The backend uses port **8787**.
The launcher starts both services; frontend edits automatically rebuild and
restart the production frontend. `cargo-watch` is installed on first use if needed.

Media lives in `C:\TariqsMediaServer`; runtime state is in its `.tms-data` folder,
outside the checkout. Each top-level media folder is a library with its own
content type and access permissions. Manage accounts, libraries, downloads,
and running work at **/admin**.

## Development

For frontend hot reload, run these in separate terminals:

```powershell
npm run backend:dev
npm run dev
```

| Command | Purpose |
| --- | --- |
| `npm run backend:build` | Build the Rust backend |
| `npm run build` | Build the production frontend |
| `npm run test:unit` | Run unit checks |
| `npm test` | Run unit checks and build the frontend |

## Optional downloads setup

For magnet downloads, enable qBittorrent's Web UI and bind it to your VPN
interface. Create an ignored local `password.md` file:

```text
TMS_QBITTORRENT_URL=http://127.0.0.1:8080
TMS_QBITTORRENT_USERNAME=your-username
TMS_QBITTORRENT_PASSWORD=your-password
TMS_VPN_INTERFACE=ProtonVPN
```

The interface name must match exactly; TMS blocks magnet downloads if the VPN
binding cannot be verified. The launcher loads these credentials at startup.
Optional subtitle keys: `TMS_WYZIE_API_KEY` and `TMS_SUBDL_API_KEY`.
Manage yt-dlp setup and throttling in **Admin > Downloads**.

To route Windows `magnet:` links to TMS, set `TMS_TAILSCALE_HOST` in `.env`
(see [.env.example](.env.example)), then run `./install_tms_magnet_handler.ps1`.
Use `./uninstall_tms_magnet_handler.ps1` to remove the association.

## Mobile and further documentation

- [Android internal releases](docs/android-play-release.md)
- [Offline storage](docs/offline-storage.md)
- [Playback queue behavior](docs/queue-behavior.md)
- Web app: open the server's HTTPS Tailscale hostname on your phone and choose
  **Install app** in Chrome or **Add to Home Screen** in Safari.
