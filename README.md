# TMS

Tariq's Media Server is a private media library built with React, Vinext, and Rust.
Browse and stream media, organize playlists and tags, upload files, and queue
URL or VPN-protected magnet downloads.

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
