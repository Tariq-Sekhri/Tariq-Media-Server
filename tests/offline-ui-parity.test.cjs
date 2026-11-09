// Offline mode must use the same UI as online mode. Both run the same React
// screens: the server renders app/page.tsx for `/`, and the offline shell
// (browser service worker or the Android app's bundled copy) mounts the very
// same module from app/client-entry.tsx. A change to the online UI therefore
// reaches offline automatically, unless code branches on being offline.
//
// This checker fails when:
// - the offline shell stops rendering the same screens, providers or styles;
// - the offline shell stops being built from the same sources and release;
// - code starts treating offline differently without registering why below;
// - tagging or playlist management stops working through the offline queue.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(file, 'utf8');
const normalize = (line) => line.trim().replace(/\s+/g, ' ');

// Every place the shared UI behaves differently offline. Each entry matches
// lines containing `match` (or equal to it, with `exact`) in `file`, exactly
// `count` of them. Keep a reason
// that explains why the server is required; otherwise share the online code.
const OFFLINE_DIFFERENCES = [
  { file: 'app/page.tsx', match: '<MobileNavigation active={section === "trash" ? "admin" : section}', count: 1, reason: 'The shared mobile navigation hides server-only destinations while disconnected, matching the desktop navigation; downloaded media and queued favorites remain available.' },
  // Connection state and returning online.
  { file: 'app/page.tsx', match: 'if (backendState !== "offline") return;', count: 1, reason: 'Moves to Offline once the server is confirmed unreachable.' },
  { file: 'app/page.tsx', match: 'if (backendState !== "online") return;', count: 2, reason: 'Returns to the previous page and syncs queued offline changes once connected.' },
  { file: 'app/page.tsx', match: 'if (backendState !== "online" || !sessionUser?.id) return;', count: 2, reason: 'Downloaded folders refresh their file list from the server only while connected.' },
  { file: 'app/page.tsx', match: 'if ((backendState !== "online" && backendState !== "cached") || items.length === 0) return;', count: 1, reason: 'Client telemetry about server items is reported only while connected.' },
  { file: 'app/page.tsx', match: 'server_connected: backendState !== "offline",', count: 1, reason: 'Telemetry field.' },
  { file: 'app/page.tsx', match: 'if (backendState === "offline") return null;', count: 1, reason: 'Organization changes skip the request and go to the offline queue.' },
  { file: 'app/page.tsx', match: 'const isFetchingNewFolder =', count: 1, reason: 'No loading skeleton while there is no server to wait for.' },
  // Server libraries are not browsable offline; Offline lists the downloads.
  { file: 'app/page.tsx', match: '{nav.filter((item) => item.id === "offline" || backendState !== "offline")', count: 1, reason: 'Libraries, Discover, Recent and New list server content.' },
  { file: 'app/page.tsx', match: '{backendState !== "offline" && canOpenAdminPanel && (', count: 1, reason: 'The admin panel is served by and manages the server.' },
  { file: 'app/page.tsx', match: '{backendState !== "offline" && <>', count: 1, reason: 'The rail hides only the server library tree. Playlists, tags and user actions stay.' },
  { file: 'app/page.tsx', match: '<small>{railCollapsed ? "" : backendState === "offline" ? "OFFLINE" : "LIBRARIES"}</small>', count: 1, reason: 'Rail heading names the active source.' },
  { file: 'app/page.tsx', match: 'const tagBrowseSection: Section = backendState === "offline" ? "offline" : "library";', count: 1, reason: 'A tag shows the matching downloads when the library is unavailable.' },
  // Playlists show the downloaded items they contain.
  { file: 'app/page.tsx', match: 'const playlistsOffline = section === "playlists" && backendState === "offline";', count: 1, reason: 'Playlists stay open offline instead of loading the server library.' },
  { file: 'app/page.tsx', match: 'section === "notes" || playlistsOffline) return;', count: 1, reason: 'Does not request the server library for an offline playlist.' },
  { file: 'app/page.tsx', match: 'const playlistSourceItems = backendState === "offline" ? offlineAllMediaItems : items;', count: 1, reason: 'Server media cannot play offline, so playlists use their downloaded items.' },
  { file: 'app/page.tsx', match: 'for (const item of [...(backendState === "offline" ? [] : Object.values(sidebarTreeEntries).flat()), ...playlistSourceItems]) {', count: 1, reason: 'Playlist covers come from downloads offline.' },
  { file: 'app/page.tsx', match: 'if (section !== "offline" && !playlistsOffline && !sessionUser?.is_admin)', count: 1, reason: 'Library membership needs the server library list; downloads already belong to the user.' },
  { file: 'app/page.tsx', match: '{(backendState === "online" || backendState === "cached" || playlistsOffline) &&', count: 1, reason: 'Clear filters is unavailable while the library is still loading.' },
  { file: 'app/page.tsx', match: '{(backendState === "online" || playlistsOffline) &&', count: 1, reason: 'Create playlist is offered once playlists are usable, online or offline.' },
  { file: 'app/page.tsx', match: '{backendState === "online" &&', count: 2, reason: 'Creating libraries and uploading need the server.' },
  { file: 'app/page.tsx', match: ': backendState === "offline" && section !== "playlists"', count: 1, reason: 'Empty server sections explain that the server is unavailable.' },
  { file: 'app/page.tsx', match: '{playlistsOffline', count: 1, reason: 'An empty offline playlist explains that only downloads appear.' },
  { file: 'app/page.tsx', match: ': backendState === "offline"', exact: true, count: 1, reason: 'Shows the server error for empty server sections.' },
  // Connection badge and Offline tools.
  { file: 'app/page.tsx', match: '{backendState === "online" ? <><path', count: 1, reason: 'Connection badge icon.' },
  { file: 'app/page.tsx', match: 'onClick={() => void syncOfflineFolders()} disabled={offlineBusy || backendState !== "online"}>', count: 1, reason: 'Syncing downloads needs the server.' },
  { file: 'app/page.tsx', match: '{backendState === "offline" && (', count: 1, reason: 'Try server button.' },
  { file: 'app/page.tsx', match: 'section === "discover" || backendState === "online") && (', count: 1, reason: 'The item count appears once connected; the badge owns other states.' },
  { file: 'app/page.tsx', match: '${backendState === "offline" ? " · Server offline" : ""}', count: 1, reason: 'Offline status line.' },
  // Downloaded copies: the same menu, with server-only file actions disabled.
  { file: 'app/page.tsx', match: 'const isDownloaded = Boolean(item.offline) || section === "offline";', count: 1, reason: 'Identifies a downloaded copy in the shared item menu.' },
  { file: 'app/page.tsx', match: 'disabled={isDownloaded}', count: 3, reason: 'Home screen shortcuts and server downloads need the server file.' },
  { file: 'app/page.tsx', match: 'disabled={isDownloaded || offlineBusy}', count: 1, reason: 'Already available offline.' },
  { file: 'app/page.tsx', match: '{isDownloaded || offlineBundles.some(', count: 1, reason: 'Make available offline label.' },
  { file: 'app/page.tsx', match: 'isDownloaded) && (', count: 3, reason: 'Move, rename, delete, new folder, upload and download change server files: shown, disabled.' },
  { file: 'app/page.tsx', match: '{(item.kind !== "folder" && (canDeleteItem(item) || isDownloaded)) && (', exact: true, count: 1, reason: 'Delete changes server files: shown, disabled.' },
  { file: 'app/page.tsx', match: 'disabled={isDownloaded || !can', count: 4, reason: 'Server file actions are disabled for downloaded copies.' },
  { file: 'app/page.tsx', match: '{!item.trashed && !isDownloaded && !isLibrary && !canDeleteItem(item)', count: 1, reason: 'Delete requests go to server administrators.' },
  { file: 'app/page.tsx', match: 'const isLibrary = item.kind === "folder" && !item.parent && !isDownloaded;', count: 1, reason: 'A downloaded root folder is not a server library.' },
  { file: 'app/page.tsx', match: 'const isLibrary = item.kind === "folder" && !item.parent && !item.offline;', count: 1, reason: 'A downloaded root folder is not a server library.' },
  { file: 'app/page.tsx', match: '{isDownloaded && item.offline?.root && offlineBundle', count: 2, reason: 'Retry and remove apply to downloads only.' },
  { file: 'app/page.tsx', match: 'const offlineBundle = item.offline', count: 1, reason: 'Finds the download behind a downloaded item.' },
  { file: 'app/page.tsx', match: '? offlineBundles.find((bundle) => bundle.id === item.offline!.bundleId)', count: 1, reason: 'Finds the download behind a downloaded item.' },
  { file: 'app/page.tsx', match: '{!item.offline && !item.trashed && item.parent', count: 1, reason: 'Go to location opens the server folder.' },
  { file: 'app/page.tsx', match: 'if (item.offline || section === "offline") return false;', count: 3, reason: 'Delete, move and rename change server files.' },
  { file: 'app/page.tsx', match: '.filter((item) => !item.offline)', count: 1, reason: 'Downloaded folders cannot be selected for bulk actions (canSelectItem).' },
  // Opening downloaded media reads the local file.
  { file: 'app/page.tsx', match: 'if (item.offline) {', count: 3, reason: 'Opening, linking and browsing a download use local files.' },
  { file: 'app/page.tsx', match: 'if (!item.offline) {', count: 1, reason: 'Server media records its access on the server.' },
  { file: 'app/page.tsx', match: 'candidate.id === item.offline!.', count: 2, reason: 'Resolves the local file to open.' },
  { file: 'app/page.tsx', match: 'if (item.offline && item.path) {', count: 1, reason: 'Durations of downloads are kept locally.' },
  { file: 'app/page.tsx', match: 'if (item.offline || section === "offline" || pathIsDownloaded(path)) {', count: 1, reason: 'Favorites of downloads are queued when the server is unavailable.' },
  { file: 'app/page.tsx', match: 'const coverImage = item.offline && item.previewKind === "image" && item.previewSrc', count: 1, reason: 'Downloaded folders use their saved copy of the original artwork instead of requesting the online poster.' },
  { file: 'app/page.tsx', match: 'aria-label={backendState === "online" ? "Server connected"', count: 1, reason: 'Connection badge exposes its current state to assistive technology.' },
  // Watch and the mini player play the local file.
  { file: 'app/watch/page.tsx', match: 'if (details.offline) return;', count: 1, reason: 'Activity is reported to the server only for streamed media.' },
  { file: 'app/watch/page.tsx', match: 'if (details.offline && details.customQueue) {', count: 1, reason: 'Restores a queue of local files.' },
  { file: 'app/watch/page.tsx', match: 'if (details.offline && requestedQuality !== "original") {', count: 1, reason: 'Transcoding needs the server.' },
  { file: 'app/watch/page.tsx', match: 'if (details.offline) {', count: 1, reason: 'Local files play directly without server audio probing.' },
  { file: 'app/watch/page.tsx', match: 'if (!details || details.offline ||', count: 1, reason: 'Preloading the next episode streams from the server.' },
  { file: 'app/watch/page.tsx', match: 'const seekPreviewUrl = seekHover && details && !details.offline ?', count: 1, reason: 'Seek previews are rendered by the server.' },
  { file: 'app/MiniAudioPlayer.tsx', match: 'if (!item.offline && item.path &&', count: 1, reason: 'Progress of streamed audio is reported to the server.' },
  { file: 'app/MiniAudioPlayer.tsx', match: 'if (target.offline) {', count: 1, reason: 'Favorites of downloads are queued for sync.' },
];

const SHARED_UI = ['app/page.tsx', 'app/watch/page.tsx', 'app/MiniAudioPlayer.tsx', 'app/WatchMiniPlayer.tsx', 'app/PlaybackProvider.tsx', 'app/OrganizeMediaModal.tsx', 'app/AppShell.tsx', 'app/TagInput.tsx', 'app/WatchPlayerControls.tsx'];
// Code that treats offline differently: the connection state, the offline
// playlist flag, the downloaded-item menu flag and downloaded items.
const OFFLINE_BRANCH = [
  /backendState\s*[!=]==\s*"(offline|online)"/,
  /\bplaylistsOffline\b/,
  /\bisDownloaded\b/,
  /\b(item|target|details\??|candidate|entry)\.offline\b(?!\??\.)/,
];

test('offline-only UI code is registered with the reason it differs from online', () => {
  const unregistered = [];
  const counts = new Map(OFFLINE_DIFFERENCES.map((entry) => [entry, 0]));
  for (const file of SHARED_UI) {
    read(file).split(/\r?\n/).forEach((raw, index) => {
      const line = normalize(raw);
      // Hook dependency lists only name values that are checked elsewhere.
      if (line.startsWith('}, [') || !OFFLINE_BRANCH.some((pattern) => pattern.test(line))) return;
      const entries = OFFLINE_DIFFERENCES.filter((entry) => entry.file === file && (entry.exact ? line === entry.match : line.includes(entry.match)));
      if (entries.length !== 1) unregistered.push(`${file}:${index + 1}: ${line}${entries.length > 1 ? ' (matches several entries)' : ''}`);
      else counts.set(entries[0], counts.get(entries[0]) + 1);
    });
  }
  assert.deepEqual(unregistered, [], [
    'Offline and online UI diverge here. Share the online code path, or, when the',
    'server is genuinely required, add an entry with the reason to OFFLINE_DIFFERENCES',
    'in tests/offline-ui-parity.test.cjs:',
    ...unregistered,
  ].join('\n'));
  const stale = [...counts].filter(([entry, count]) => count !== entry.count)
    .map(([entry, count]) => `${entry.file}: "${entry.match}" expected ${entry.count}, found ${count}`);
  assert.deepEqual(stale, [], `Update OFFLINE_DIFFERENCES to match the code:\n${stale.join('\n')}`);
  for (const entry of OFFLINE_DIFFERENCES) assert.ok(entry.reason.length > 8, `${entry.match} needs a reason`);
});

const importsOf = (source) => Object.fromEntries([...source.matchAll(/^import (\w+)(?:, \{[^}]*\})? from "([^"]+)";/gm)].map(([, name, from]) => [name, from]));
const cssOf = (source) => [...source.matchAll(/^import "([^"]+\.css)";/gm)].map(([, file]) => file).sort();
const tagsOf = (jsx) => [...jsx.matchAll(/<([A-Z]\w+)/g)].map(([, tag]) => tag);

test('the offline shell renders the same screens, providers and styles as the server', () => {
  const entry = read('app/client-entry.tsx');
  const layout = read('app/layout.tsx');
  const entryImports = importsOf(entry);
  const layoutImports = importsOf(layout);
  assert.deepEqual(cssOf(entry), cssOf(layout), 'the offline shell loads the same stylesheets');

  // The release reloader asks the server for a newer release.
  const serverOnly = new Set(['ProductionReleaseReloader']);
  const layoutTree = tagsOf(layout.slice(layout.indexOf('<body'))).filter((tag) => !serverOnly.has(tag));
  const entryTree = tagsOf(entry.slice(entry.indexOf('.render('))).filter((tag) => tag !== 'Page');
  assert.deepEqual(entryTree, layoutTree.filter((tag) => tag !== 'html' && tag !== 'body'), 'the same providers wrap every screen');
  for (const tag of entryTree) assert.equal(path.normalize(entryImports[tag]), path.normalize(layoutImports[tag]), `${tag} is the same module`);

  // Every server page maps to the same module in the offline shell.
  const routing = entry.match(/const Page = ([^;]+);/)[1];
  const offlineScreen = (route) => {
    const match = routing.match(new RegExp(`url\\.pathname === "${route}" \\? (\\w+)`));
    return match ? match[1] : routing.trim().split(':').at(-1).trim();
  };
  const pages = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    const file = path.join(dir, dirent.name);
    return dirent.isDirectory() ? pages(file) : dirent.name === 'page.tsx' ? [file] : [];
  });
  for (const file of pages('app')) {
    const route = `/${path.relative('app', path.dirname(file)).split(path.sep).join('/')}`.replace(/\/$/, '') || '/';
    const source = read(file);
    let module = `./${path.relative('app', file).split(path.sep).join('/').replace(/\.tsx$/, '')}`;
    const reexport = source.match(/^export \{ default \} from "([^"]+)";/m);
    if (reexport) module = `./${path.posix.join(path.posix.dirname(module), reexport[1])}`.replace(/^\.\/\.\//, './');
    if (/window\.location\.replace\("\/\?section=\w+"\)/.test(source)) module = './page';
    const screen = offlineScreen(route);
    assert.equal(path.posix.normalize(entryImports[screen]), path.posix.normalize(module), `${route} renders ${module} offline as well`);
  }

  // No forked offline screens or components.
  const forks = fs.readdirSync('app', { recursive: true })
    .filter((file) => /offline/i.test(path.basename(String(file))) && /\.(tsx|jsx|css)$/.test(String(file)));
  assert.deepEqual(forks, [], 'offline UI lives in the shared screens, not separate offline components');
});

test('the offline shell is built from the same sources as each release', () => {
  assert.match(read('public/index.html'), /<script type="module" src="\/app\/client-entry\.tsx">/);
  const shellBuild = read('scripts/build-app-shell.mjs');
  assert.match(shellBuild, /input: resolve\("public\/index\.html"\)/);
  assert.match(shellBuild, /writeFile\("dist\/client\/offline\.html", await readFile\("dist\/client\/index\.html"\)\)/, 'offline.html is the same document');
  assert.match(shellBuild, /tms-react-shell-\$\{revision\}/, 'each build installs a new cached shell');
  assert.match(read('package.json'), /"build": "vinext build && node scripts\/build-app-shell\.mjs"/, 'every build produces the online app and the offline shell together');
  const worker = read('public/service-worker.js');
  assert.match(worker, /caches\.match\("\/index\.html"\)/, 'the browser falls back to the cached shell');
  assert.match(worker, /app-shell-manifest\.json/);
  const client = read('android/app/src/main/java/ca/sekhrit/tms/TmsWebViewClient.java');
  assert.match(client, /getAssets\(\)\.open\("public\/index\.html"\)/, 'Android falls back to the bundled shell');
  assert.match(client, /path\.startsWith\("\/app-shell-assets\/"\)/);
  assert.match(read('capacitor.config.ts'), /webDir: "dist\/client"/);
  const release = read('.github/workflows/android-play-release.yml');
  assert.match(release, /npm run test:unit[\s\S]*npm run build\s+npx cap sync android/, 'each Android release tests, then bundles the shell built from its own commit');
});

// Function bodies in page.tsx, found by name.
const body = (source, name) => {
  const start = source.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${name} exists`);
  const open = source.indexOf('{', source.indexOf('=>', start));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(open, index + 1);
  }
  throw new Error(`Unbalanced ${name}`);
};

test('tagging and playlist management use the offline queue when the server is unavailable', () => {
  const page = read('app/page.tsx');
  assert.match(body(page, 'reachServer'), /if \(backendState === "offline"\) return null;/);
  const calls = {
    saveOrganization: ['reachServer(', 'queueOfflineOrganization(', 'applyOrganizationState(organizedLocally('],
    syncBulkOrganizationUpdates: ['reachServer(', 'queueOfflineOrganization('],
    createPlaylistRecord: ['reachServer(', 'queueOfflinePlaylistCreate('],
    createPlaylistInline: ['createPlaylistRecord('],
    createPlaylist: ['createPlaylistRecord('],
    createTag: ['reachServer(', 'queueOfflineTagCreate('],
    deletePlaylist: ['reachServer(', 'queueOfflinePlaylistDelete('],
    deleteTag: ['reachServer(', 'queueOfflineTagDelete('],
    toggleFavorite: ['queueOfflineFavorite('],
    applyOrganizationState: ['applyPendingOrganization(', 'readPendingOfflineChanges()'],
  };
  for (const [name, expected] of Object.entries(calls)) {
    const code = body(page, name);
    for (const call of expected) assert.ok(code.includes(call), `${name} calls ${call}`);
  }
  assert.doesNotMatch(body(page, 'saveOrganization'), /kind !== "folder" && pathIsDownloaded/, 'downloaded folders can be tagged offline');
  assert.doesNotMatch(body(page, 'startOrganizing'), /offline/, 'Tags & playlists opens for downloads');
  assert.match(page, /\{!item\.trashed && item\.path && \(\s*<button onClick=\{\(\) => startOrganizing\(item\)\}>/, 'the item menu offers Tags & playlists for downloads');
  assert.match(page, /await syncPendingOfflineOrganization\(\)/, 'queued changes sync when the server returns');
  assert.match(page, /window\.setInterval\(refresh, 15_000\)/, 'metadata retries while connected without a page refresh');
  assert.match(page, /hydratePendingOfflineChanges\(\)\.then\(\(\) => readOfflineUserState/, 'the offline shell shows changes queued in the other origin');

  // The rail keeps Playlists and Tags offline; only the library tree needs the server.
  const gate = page.indexOf('{backendState !== "offline" && <>');
  const gated = page.slice(gate, page.indexOf('</>}', gate));
  assert.ok(gated.includes('renderFolderNodes()'));
  assert.ok(!gated.includes('<b>PLAYLISTS</b>') && !gated.includes('<b>TAGS</b>') && !gated.includes('title="Settings"'), 'playlists, tags and user actions are shown offline too');

  // Watch and the mini player organize with the same modal and queue.
  const modal = read('app/OrganizeMediaModal.tsx');
  for (const call of ['queueOfflineOrganization(', 'queueOfflinePlaylistCreate(', 'readSavedOrganization()', 'applyPendingOrganization(']) {
    assert.ok(modal.includes(call), `OrganizeMediaModal calls ${call}`);
  }
  for (const file of ['app/watch/page.tsx', 'app/MiniAudioPlayer.tsx']) assert.match(read(file), /<OrganizeMediaModal/);
});

test('the device store keeps playlist and tag changes for the connected app', () => {
  const plugin = read('android/app/src/main/java/ca/sekhrit/tms/TmsOfflinePlugin.java');
  assert.match(plugin, /result\.put\("catalog", new JSArray\(preferences\(\)\.getString\(PENDING_CATALOG_PREFIX \+ ownerId, "\[\]"\)\)\);/);
  assert.match(plugin, /\.putString\(PENDING_CATALOG_PREFIX \+ ownerId, catalog\.toString\(\)\)/);
});
