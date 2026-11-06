# Offline storage

The selected offline location contains a hidden `.tms_data` directory for TMS
metadata. Cover images live under `.tms_data/<bundle-id>/`. Android also keeps
its recovery catalog at `.tms_data/.tms-offline-catalog.json`; its private
manifest remains the device's working catalog. The browser keeps its working
catalog in IndexedDB.

Media stays in its existing content folders. New bundle downloads use
`TMS Offline/<name>-<id-prefix>/`; recovered and previously moved media does
not need to be moved or downloaded again.

Android reads the hidden recovery catalog directly and excludes hidden
directories and generated cover files from content recovery. The first folder
reconciliation migrates legacy catalogs and saved cover art. Browser resync
migrates existing cover art locally. Old copies are removed after the updated
references are saved. Failed replacement downloads preserve the original art
needed by the previous catalog.

Removing an offline download removes its media, per-bundle metadata directory,
and catalog entry. Shared Android documents remain available to the downloads
that still reference them. The user's selected root is never removed.

If the selected folder is deleted from mounted Android primary storage, opening
Offline clears its stale private catalog and forgets the folder selection. It
does not recreate the directory or start downloads. Lost grants, unavailable
providers, and detached removable storage retain their catalog for recovery.
Requests for unavailable media or covers return HTTP 404 instead of crashing
the WebView.

## Tags, playlists and favorites offline

Offline mode is the same React UI as online mode; the offline shell mounts the
same screens. Tagging items and folders, adding items to playlists, creating
and deleting playlists and tags, and favorites all work offline. Changes are
queued (`app/lib/offline-organization.ts`) and shown immediately, then sent to
the server in order once it is reachable: creations, item changes, deletions,
favorites. Playlists created offline get their server id during sync. Android
keeps the queue in the device store so the offline shell and the connected app,
which are different WebView origins, share it.

`npm run check:offline` runs the offline organization tests and the UI parity
checker. The checker fails when the offline shell stops rendering the shared
screens, or when code treats offline differently without an entry, and reason,
in `OFFLINE_DIFFERENCES` (`tests/offline-ui-parity.test.cjs`).
