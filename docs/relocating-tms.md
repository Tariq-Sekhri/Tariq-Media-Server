# Moving TMS on Windows

Storage locations has a **Move TMS** guide. The offline tool moves the source
installation and main media/data folder together into a new local NTFS folder:

```powershell
# From the current TMS checkout: preview only, no changes.
.\scripts\move-tms.ps1 -Destination 'D:\TMS'
```

The destination must not exist. It will contain `app` (the complete checkout,
dependencies, configuration and build outputs) and `data` (main media and hidden
runtime data, including accounts, sessions, metadata and frontend releases).
External media mounts remain links to their existing targets and are not copied.
Cloud placeholders and unsupported reparse points are rejected.

## Maintenance procedure

1. Record which TMS scheduled tasks are enabled, then disable those tasks so
   startup, supervisor, autotag and download jobs cannot restart during the move.
   Stop TMS using its normal stop command. Exit its tray icon, stop the folder
   picker broker and close qBittorrent. Close other terminals, editors and tools
   using the installation or main data folder. Do not run another coding agent
   or file writer against either folder during relocation.
2. Open administrator PowerShell. Run the preview above, inspect both source
   paths, and repeat with `-Apply` to perform the move. If the main media folder
   is configured outside the default, supply `-LibraryRoot` with its current
   absolute path in both commands. Allow enough space for a complete copy; the
   originals remain intact as backups, even on the same drive.
3. The tool requires offline processes and disabled scheduled tasks. It copies
   ordinary directories/files, preserves their permissions, recreates links
   without traversing them, and compares entry lists and SHA-256 file hashes.
   It verifies again before switching either source path.
4. After success, re-enable only the tasks that were enabled before the move
   and start TMS normally through the existing launcher. Old installation and
   data paths are now directory junctions to the new folders, so startup tasks,
   absolute references, shortcuts and configured download paths remain valid.
   Keep those compatibility junctions in place.
5. Check login, library access, playback and downloads. The tool prints the
   exact `before-move` backup paths. They still occupy the original disk; delete
   them only after verification and with normal backup precautions. The tool
   never automatically deletes the original files or a failed staged copy.

## Transaction and interruption guarantees

This is an offline, rollback-capable transaction, **not a single atomic Windows
filesystem operation**. Windows does not provide one atomic rename covering two
independent roots on different volumes. TMS remains stopped throughout staging
and cutover. Normal launchers refuse to start while a durable recovery journal
exists. If a switch fails, the tool restores both original paths. It does not
claim success for a partial move.

A power failure or forcibly terminated process can leave a partial switch. Keep
TMS stopped and run recovery as administrator:

```powershell
# Use the script in the staged destination if the old installation path is absent.
& 'D:\TMS\app\scripts\move-tms.ps1' -Recover
```

Recovery restores original directories from their saved backup names, removes
only verified compatibility junctions, and preserves staged copies. It refuses
to replace unexpected items. If copying was interrupted before the script was
staged, run `-Recover` from the original installation or its printed backup.
The journal lives under `%ProgramData%\TMS\Relocation`; only administrators and
SYSTEM can modify it. Local accounts can read its paths so unelevated launchers
can detect the startup guard. Recovery must finish before restarting TMS. A failure to
restore a locked folder leaves the journal in place and requires resolving that
lock, then retrying recovery.

The original path locations must remain available to hold the compatibility
junctions; this tool does not prepare removal of the original drive or migration
to a different computer. NTFS file contents and permissions are copied; it does
not preserve hard-link identity or prove application health. Service restart and
functional checks are separate from filesystem verification.
