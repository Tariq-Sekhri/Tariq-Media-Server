# TMS

**TMS** stands for **Tariq’s Media Server**. It is a local-only media library
built with React, Vinext, and a Rust backend.
The Rust service indexes the `C:\TariqsMediaServer` media root and
streams its media to the frontend. It never reads from the live `C:\JellyFin`
directory unless someone explicitly overrides the backend environment variable.

## Prerequisites

- Node.js `>=22.13.0`
- Rust toolchain with `cargo`
- `cargo-watch` (installed automatically on first `npm run backend:dev` or `./start_tms.ps1`)

## Quick Start

```bash
npm install
./start_tms.ps1
```

Or run frontend and backend separately:

```bash
npm install
npm run backend:dev
npm run dev
npm run build
```

## Install on a phone

TMS is an installable web app. Start TMS, then open its **HTTPS Tailscale
hostname** in your phone browser (not the raw `http://` LAN address):

- Android Chrome: browser menu → **Install app**.
- iPhone Safari: Share → **Add to Home Screen**.

The installed app is the same TMS frontend and requires a connection to the
server for login, media, and library data. It deliberately does not cache
private pages or media on the phone.

## Project shape

- `app/page.tsx` contains the media-library interface and backend integration.
- `backend/` contains the local Rust index and streaming server.
- `C:\TariqsMediaServer` holds media and `.tms-data` runtime state outside the checkout.
- `app/globals.css` and `app/unified.css` contain the styling.
- `public/` contains local demo media.

## Library structure

Planned queue behavior is documented in [Queue behavior requirements](docs/queue-behavior.md).

Every top-level folder in the local media copy is a **library**. A library owns
its content type (mixed media or Movies & TV) and
its access list. Folders inside a library are ordinary folders; they do not
inherit a content type. In a Movies & TV library, selected nested folders can
be marked as movie/show title folders, which enables title metadata and
episode-oriented browsing for that folder.

Library settings are kept in ignored local backend data, never in the media
folders themselves.

Each account also has private playlists and custom tags. Tags are searchable and
playlist membership follows an item when it is renamed. Any folder, filtered
view, or playlist with playable media also provides **Play all** and **Shuffle**;
the resulting order stays intact across automatic advance and player navigation.
The player also offers per-account auto-skip settings for intro and ending
offsets; the feature is off until the account enables it.

## VPN-protected magnet downloads

TMS can send magnet links to qBittorrent's Web API, but it blocks every
request unless qBittorrent reports that it is bound to the exact VPN interface
configured for TMS. Enable qBittorrent's Web UI, bind qBittorrent to your
VPN network interface, then create a local `password.md` file in the project
root with:

```text
TMS_QBITTORRENT_URL=http://127.0.0.1:8080
TMS_QBITTORRENT_USERNAME=your-qbittorrent-username
TMS_QBITTORRENT_PASSWORD=your-qbittorrent-password
TMS_VPN_INTERFACE=ProtonVPN
# Optional: free subtitle APIs (keys remain only on the TMS server)
TMS_WYZIE_API_KEY=your-free-wyzie-key
TMS_SUBDL_API_KEY=your-free-subdl-key
```

Run `./start_tms.ps1`; it reads `password.md` only into the TMS process.

Discover automatically approves and downloads digitally released movies and
completed seasons when the requester has storage available for a 50 GiB budget.
Movies need a digital release date on TMDB that has passed. Every known episode
in a season must have aired; missing dates, upcoming episodes, and open-ended
specials stay available for administrator review. A complete series pack can be
chosen when its seasons are among the completed seasons selected in the request.
Request and library permissions and weekly limits still apply.

Automatic selection uses the existing torrent ranking, requires at least five
seeders, and only chooses complete season packs for shows. If no suitable torrent
is found, the administrator can review the results. The budget remains reserved
through the Server Download handoff, and actual torrent metadata must fit it
before the payload starts. Existing service budgets migrate to 50 GiB once when
the updated backend starts; administrators can subsequently adjust them.

Downloads queued by a full administrator (including Discover release selections)
start uncapped. Full administrators can use **Cap speed** / **Uncap speed** in
Active downloads or Admin > Running work. The choice is saved per download and
survives backend restarts. Existing admin-owned downloads also default to uncapped.
Enabling the cap opts that download into the normal screen-lock policy.

On Windows, capped TMS torrents share a 5 MiB/s download cap while any interactive
session is unlocked. Locking the screen removes this cap; unlocking restores it
on the next downloader poll (normally within two seconds). This uses Windows
session state even when the backend runs as SYSTEM. Other qBittorrent torrents
and any global limits configured in qBittorrent retain their settings.

## Free subtitle sources

TMS always checks matching local `.srt` files and OpenSubtitles. Add either or
both optional free keys above to also search **TVSubtitles** through Wyzie and
**SubDL**. Both providers offer free keys; TMS deliberately uses only Wyzie's
free TVSubtitles source and no paid-only provider or feature.

To make Windows send every `magnet:` link to TMS instead of qBittorrent, run
`./install_tms_magnet_handler.ps1` once. This portable single-file installer
copies itself into the user's local app data before registering the handler, so
it can be sent to another TMS user and the original download can be removed.
It opens `TMS_TAILSCALE_HOST` from `.env` (see `.env.example`) on port 3000; pass
`-TmsHost <address> -TmsPort <port>` to use a different server. It never
starts a local service, opens the browser without a console window,
and asks for a Movies & TV library and optional folder before the link is ever
submitted. Run `./uninstall_tms_magnet_handler.ps1` to remove that user-only
association.

The interface names must match exactly. Credentials stay in the local process
environment and are never written into the repository. Downloads are limited
to existing folders inside TMS’s isolated media library. Existing `FRAMEBOX_*`
variables remain supported as compatibility fallbacks.

## yt-dlp downloads

In Admin → Downloads, **yt-dlp throttling** controls pacing for every
inspect and download job:

- **Sleep interval** — seconds to wait between playlist items (`0` disables)
- **Max sleep** — random extra delay up to this many seconds
- **Rate limit** — optional cap such as `500K` or `2M`

For large playlists, starting with `5` / `10` sleep and `2M` rate limit is a
reasonable way to reduce account rate limits.

## Uploads

Folders with upload permission accept multiple files at once. TMS validates
the selection for the library type, shows byte progress and per-file results,
allows an active batch to be cancelled, and refreshes the library once after the
batch completes. The backend streams each upload into a temporary file and only
publishes the final filename after the transfer succeeds.

## Administration and logs

`/admin` is the local Admin Dashboard. TMS writes daily, component-tagged
server logs to ignored `backend/data/logs/`, then exposes the recent entries to
that dashboard through the local backend. Administrators manage accounts,
library types, and per-user action permissions from the same dashboard.

Running work (`/admin?section=processes`) refreshes every five seconds and
warns when live status is delayed. Failed refreshes keep the previous
snapshot visible with an outdated-status warning. Torrent activity is marked
unavailable when qBittorrent cannot confirm it. Resume and Cancel remain
available, and unsuccessful actions show the error returned by qBittorrent. Cancellation is saved even when
qBittorrent is offline and retried by the download watcher after restart.
The job remains Cancelling until the torrent is gone, leftover files are cleaned
up, and its storage reservation is released. Leftovers in a dedicated download
folder move to recoverable Trash; shared folders are preserved. Exited transcodes leave the
active list while their cached playback output remains available.

Permanently deleting a movie, episode, show, or library from Trash also removes
its HLS transcodes, including completed streams, seek variants, and automatic
quality playlists. Empty Trash and the automatic 30-day purge use the same
cleanup. Moving media to Trash preserves completed caches for restoration.
If transcode removal fails, the Trash item remains available for retry.

For caches left by earlier deletions, run
`./scripts/cleanup-orphan-transcodes.ps1` to audit, then add `-Apply` to remove
identified orphans. The script checks the configured media root and Trash,
preserves active transcodes and unidentified caches, and reports removed bytes.

Automatic preview and audio preparation waits for ten minutes of computer
idle time, no active transcodes or tracked transfers, and no recent playback.
Waiting jobs show whether they need idle time or a worker; paused jobs show
their resume time. Max speed bypasses the idle requirement. Successful preview
runs are collapsed by default. Runs with unreadable videos remain visible as
finished with errors, with cached/generated/failed counts and Retry failed;
retrying scans the library again and skips previews already on disk.

## Useful Commands

- `npm run dev`: start local development with hot reload
- `npm run backend:dev`: start the Rust server on port 8787 with auto-rebuild on backend changes
- `./start_tms.ps1`: build the backend, start both services, and restart a stale backend if needed
- `npm run backend:build`: compile the Rust server
- `npm run build`: create a production build
- `npm test`: build and run the rendered HTML checks

## Learn More

- [Vinext documentation](https://github.com/cloudflare/vinext)
