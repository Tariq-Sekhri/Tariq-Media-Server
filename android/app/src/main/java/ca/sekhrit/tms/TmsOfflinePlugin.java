package ca.sekhrit.tms;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.Iterator;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "TmsOffline")
public class TmsOfflinePlugin extends Plugin {
    private static final String PREFS = "tms_offline";
    private static final String TREE_URI = "tree_uri";
    private static final String TREE_NAME = "tree_name";
    private static final String LAST_OWNER_ID = "last_owner_id";
    // The local offline shell and the connected server use different WebView
    // origins. Keep user-owned metadata here so favorites and tags do not get
    // stranded in one origin's localStorage while the device is offline.
    private static final String OFFLINE_USER_STATE_PREFIX = "offline_user_state_";
    private static final String PENDING_ORGANIZATION_PREFIX = "pending_organization_";
    private static final String PENDING_FAVORITES_PREFIX = "pending_favorites_";
    // Playlists and tags created or deleted offline.
    private static final String PENDING_CATALOG_PREFIX = "pending_catalog_";
    private static final String MANIFEST = "offline-manifest.json";
    private static final String TMS_ROOT = "TMS Offline";
    // A copy of the catalog kept beside the media. The app-private manifest is
    // deleted on uninstall (or restored stale from a backup), while the media
    // stays in the user's folder; this copy lets a reinstall restore the
    // original bundles, server paths and owners instead of guessing.
    private static final String FOLDER_CATALOG = OfflineStorageLayout.CATALOG;
    private static final String METADATA_ROOT = OfflineStorageLayout.METADATA;
    private static final String METADATA_LAYOUT_TREE = "metadata_layout_tree_v1";
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService downloadWatchdog = Executors.newSingleThreadScheduledExecutor();
    private final Set<String> activeDownloads = ConcurrentHashMap.newKeySet();

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    @PluginMethod
    public synchronized void getLocation(PluginCall call) {
        String uri = preferences().getString(TREE_URI, "");
        JSObject result = new JSObject();
        // A backup restore brings back the saved folder URI but not its
        // permission grant, so only a still-granted folder counts as chosen.
        result.put("configured", hasTreePermission(uri));
        result.put("name", preferences().getString(TREE_NAME, ""));
        call.resolve(result);
    }

    @PluginMethod
    public synchronized void saveOfflineWatchProgress(PluginCall call) {
        int ownerId = call.getInt("ownerId", 0);
        String path = call.getString("path", "");
        JSObject state = call.getObject("state");
        if (ownerId == 0 || path.isEmpty() || state == null) { call.reject("Missing playback progress."); return; }
        try {
            String key = "offline_watch_progress_" + ownerId;
            JSONObject playback = new JSONObject(preferences().getString(key, "{}"));
            JSONObject previous = playback.optJSONObject(path);
            if (previous == null || state.optLong("updated") >= previous.optLong("updated")) {
                playback.put(path, new JSONObject(state.toString()));
                preferences().edit().putString(key, playback.toString()).apply();
            }
            call.resolve();
        } catch (Exception error) { call.reject("Could not save playback progress.", error); }
    }

    @PluginMethod
    public void getOfflineWatchProgress(PluginCall call) {
        int ownerId = call.getInt("ownerId", 0);
        try {
            JSObject result = new JSObject();
            result.put("playback", new JSObject(preferences().getString("offline_watch_progress_" + ownerId, "{}")));
            call.resolve(result);
        } catch (Exception error) { call.reject("Could not read playback progress.", error); }
    }

    @PluginMethod
    public void serverUrl(PluginCall call) {
        String url = getBridge().getServerUrl();
        if (url == null || url.isEmpty()) url = getBridge().getLocalUrl();
        JSObject result = new JSObject();
        result.put("url", url == null ? "" : url);
        call.resolve(result);
    }

    @PluginMethod
    public void openServer(PluginCall call) {
        String url = getBridge().getServerUrl();
        if (url == null || url.isEmpty()) {
            call.reject("No server URL configured.");
            return;
        }
        final String destination = url.endsWith("/") ? url : url + "/";
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(destination));
        call.resolve();
    }

    @PluginMethod
    public void chooseLocation(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "locationChosen");
    }

    @ActivityCallback
    private void locationChosen(PluginCall call, androidx.activity.result.ActivityResult activityResult) {
        if (call == null) return;
        Intent data = activityResult.getData();
        if (activityResult.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("No offline folder was selected.");
            return;
        }
        Uri tree = data.getData();
        int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, flags);
            String name = documentName(tree);
            preferences().edit().putString(TREE_URI, tree.toString()).putString(TREE_NAME, name).apply();
            recoverCatalogFromSelectedFolder(tree);
            JSObject result = new JSObject();
            result.put("configured", true);
            result.put("name", name);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("TMS could not keep access to that folder.", error);
        }
    }

    @PluginMethod
    public synchronized void list(PluginCall call) {
        int ownerId = call.getInt("ownerId", 0);
        try {
            JSONArray stored = readManifest();
            String treeValue = preferences().getString(TREE_URI, "");
            boolean folderAvailable = hasTreePermission(treeValue);
            if (folderAvailable && activeDownloads.isEmpty() && (stored.length() == 0
                || !treeValue.equals(preferences().getString(METADATA_LAYOUT_TREE, "")))) {
                recoverCatalogFromSelectedFolder(Uri.parse(treeValue));
                stored = readManifest();
            }
            int effectiveOwnerId = resolveOfflineOwnerId(stored, ownerId);
            boolean changed = false;
            JSArray bundles = new JSArray();
            for (int index = 0; index < stored.length(); index++) {
                JSONObject bundle = stored.getJSONObject(index);
                if (bundle.optInt("ownerId", 0) == 0 && effectiveOwnerId != 0) {
                    // A catalog recovered after reinstall has no session owner.
                    // Claim it for the first remembered account on this device.
                    bundle.put("ownerId", effectiveOwnerId);
                    changed = true;
                }
                if ("downloading".equals(bundle.optString("status")) && !activeDownloads.contains(bundle.optString("id", ""))) {
                    bundle.put("status", "error");
                    bundle.put("error", "Download was interrupted or stalled. Try again to continue.");
                    changed = true;
                }
                // The bundled offline shell has a local Capacitor origin, while
                // the live app uses the remote TMS origin. Restore only the
                // last signed-in owner's device catalog in that local shell.
                if (bundle.optInt("ownerId", 0) == effectiveOwnerId) bundles.put(bundle);
            }
            if (changed) writeManifest(stored);
            JSObject result = new JSObject();
            result.put("bundles", bundles);
            result.put("locationName", preferences().getString(TREE_NAME, ""));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read offline downloads.", error);
        }
    }

    @PluginMethod
    public synchronized void download(PluginCall call) {
        JSObject requested = call.getObject("bundle");
        String token = call.getString("token", "");
        String treeValue = preferences().getString(TREE_URI, "");
        if (!hasTreePermission(treeValue)) {
            call.reject("Choose an offline download folder first.");
            return;
        }
        if (requested == null) {
            call.reject("Missing offline download details.");
            return;
        }
        final String bundleId = requested.optString("id", "");
        if (!activeDownloads.add(bundleId)) {
            call.reject("This offline download is already running.");
            return;
        }
        downloads.execute(() -> {
            JSONObject bundle = requested;
            List<Uri> stagedDocuments = new ArrayList<>();
            try {
                bundle = new JSONObject(requested.toString());
                preferences().edit().putInt(LAST_OWNER_ID, bundle.optInt("ownerId", 0)).apply();
                bundle.put("status", "downloading");
                upsertBundle(bundle);
                Uri tree = Uri.parse(treeValue);
                Uri tmsRoot = findOrCreateDirectory(tree, TMS_ROOT);
                String bundleFolderName = safeSegment(bundle.optString("name", "Download")) + "-" + bundle.optString("id").substring(0, Math.min(8, bundle.optString("id").length()));
                Uri bundleRoot = findOrCreateDirectory(tmsRoot, bundleFolderName);
                JSONArray files = bundle.getJSONArray("files");
                long downloadedBytes = 0;
                for (int index = 0; index < files.length(); index++) {
                    JSONObject file = files.getJSONObject(index);
                    if (savedFileComplete(file)) downloadedBytes += Math.max(0, file.optLong("size", 0));
                    else file.remove("localUri");
                }
                long startedAt = System.currentTimeMillis();
                long[] lastProgressPersistedAt = { 0 };
                final JSONObject downloadingBundle = bundle;
                for (int index = 0; index < files.length(); index++) {
                    JSONObject file = files.getJSONObject(index);
                    if (!file.optString("localUri", "").isEmpty()) continue;
                    Uri directory = bundleRoot;
                    String[] parts = file.optString("relativePath", file.optString("name")).split("/");
                    for (int part = 0; part < parts.length - 1; part++) {
                        if (!parts[part].isEmpty()) directory = findOrCreateDirectory(directory, safeSegment(parts[part]));
                    }
                    String filename = safeSegment(parts.length == 0 ? file.optString("name", "file") : parts[parts.length - 1]);
                    String destinationName = filename;
                    if (bundle.optJSONObject("syncPreviousBundle") != null && findChild(directory, filename) != null) {
                        destinationName = "sync-" + Integer.toHexString((file.optString("url") + file.optLong("size")).hashCode()) + "-" + filename;
                    }
                    Uri destination = findOrCreateFile(directory, mimeType(filename), destinationName);
                    if (bundle.optJSONObject("syncPreviousBundle") != null) stagedDocuments.add(destination);
                    final long completedBytes = downloadedBytes;
                    final int currentFile = index + 1;
                    final String currentFileName = file.optString("name", filename);
                    final long currentFileTotalBytes = Math.max(0, file.optLong("size", 0));
                    reportDownloadProgress(downloadingBundle, completedBytes, 0, currentFileTotalBytes, startedAt, files.length(), currentFile, currentFileName, lastProgressPersistedAt, true);
                    long fileBytes = downloadTo(file.getString("url"), token, destination, currentBytes ->
                        reportDownloadProgress(downloadingBundle, completedBytes, currentBytes, currentFileTotalBytes, startedAt, files.length(), currentFile, currentFileName, lastProgressPersistedAt, false)
                    );
                    if (currentFileTotalBytes > 0 && fileBytes != currentFileTotalBytes) {
                        throw new Exception("Incomplete download: " + currentFileName + " (" + fileBytes + " of " + currentFileTotalBytes + " bytes). Try again.");
                    }
                    downloadedBytes += fileBytes;
                    file.put("localUri", destination.toString());
                    bundle.put("downloadedBytes", downloadedBytes);
                    bundle.put("completedFiles", currentFile);
                    upsertBundle(bundle);
                }
                JSONObject cover = bundle.optJSONObject("cover");
                if (cover != null && !savedDocumentExists(cover)) {
                    Uri destination = metadataCoverDestination(tree, bundle, cover);
                    if (bundle.optJSONObject("syncPreviousBundle") != null) stagedDocuments.add(destination);
                    downloadedBytes += downloadTo(cover.getString("url"), cover.optBoolean("public", false) ? "" : token, destination, bytes -> {});
                    cover.put("localUri", destination.toString());
                    bundle.put("downloadedBytes", downloadedBytes);
                    upsertBundle(bundle);
                }
                JSONObject covers = bundle.optJSONObject("covers");
                if (covers != null) {
                    Iterator<String> coverPaths = covers.keys();
                    while (coverPaths.hasNext()) {
                        JSONObject folderCover = covers.getJSONObject(coverPaths.next());
                        if (savedDocumentExists(folderCover)) continue;
                        Uri destination = metadataCoverDestination(tree, bundle, folderCover);
                        if (bundle.optJSONObject("syncPreviousBundle") != null) stagedDocuments.add(destination);
                        downloadedBytes += downloadTo(folderCover.getString("url"), folderCover.optBoolean("public", false) ? "" : token, destination, bytes -> {});
                        folderCover.put("localUri", destination.toString());
                        bundle.put("downloadedBytes", downloadedBytes);
                        upsertBundle(bundle);
                    }
                }
                bundle.put("status", "ready");
                bundle.put("downloadedBytes", downloadedBytes);
                bundle.put("completedFiles", files.length());
                bundle.remove("currentFileName");
                bundle.remove("currentFileIndex");
                bundle.remove("currentFileDownloadedBytes");
                bundle.remove("currentFileTotalBytes");
                bundle.remove("downloadSpeedBytes");
                bundle.remove("etaSeconds");
                bundle.remove("error");
                JSONObject previous = bundle.optJSONObject("syncPreviousBundle");
                bundle.remove("syncPreviousBundle");
                upsertBundle(bundle);
                persistFolderCatalog();
                if (previous != null) {
                    Set<String> retained = new HashSet<>(bundleDocumentUris(bundle));
                    for (String uri : bundleDocumentUris(previous)) {
                        if (!retained.contains(uri)) try { deleteDocumentStrict(Uri.parse(uri)); } catch (Exception ignored) { }
                    }
                }
                JSObject result = new JSObject();
                result.put("bundle", persistedBundle(bundle));
                call.resolve(result);
            } catch (Exception error) {
                android.util.Log.e("TmsOffline", "Offline download failed for " + bundleId, error);
                try {
                    // A failed resync leaves the previous complete catalog usable.
                    JSONObject previous = bundle.optJSONObject("syncPreviousBundle");
                    if (previous != null) {
                        Set<String> retained = new HashSet<>(bundleDocumentUris(previous));
                        for (Uri staged : stagedDocuments) {
                            if (!retained.contains(staged.toString())) try { deleteDocumentStrict(staged); } catch (Exception ignored) { }
                        }
                        bundle = previous;
                    } else bundle.put("status", "error");
                    bundle.put("error", error.getMessage() == null ? "Offline download failed" : error.getMessage());
                    upsertBundle(bundle);
                    persistFolderCatalog();
                } catch (Exception ignored) {}
                call.reject(error.getMessage() == null ? "Offline download failed" : error.getMessage(), error);
            } finally {
                activeDownloads.remove(bundleId);
            }
        });
    }

    @PluginMethod
    public synchronized void remove(PluginCall call) {
        String id = call.getString("id", "");
        int ownerId = call.getInt("ownerId", 0);
        try {
            if (activeDownloads.contains(id)) throw new Exception("Wait for this offline download to finish before removing it.");
            JSONArray stored = readManifest();
            int effectiveOwnerId = resolveOfflineOwnerId(stored, ownerId);
            JSONArray next = new JSONArray();
            for (int index = 0; index < stored.length(); index++) {
                JSONObject bundle = stored.getJSONObject(index);
                if (id.equals(bundle.optString("id")) && effectiveOwnerId == bundle.optInt("ownerId", 0)) {
                    deleteBundleFolder(bundle, stored);
                } else {
                    next.put(bundle);
                }
            }
            // Save the recovery copy first. A failure must leave the private
            // catalog available for retry, rather than resurrect a stale copy.
            persistFolderCatalog(next);
            writeManifest(next);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not remove the offline download.", error);
        }
    }

    @PluginMethod
    public synchronized void reconcile(PluginCall call) {
        JSObject requested = call.getObject("bundle");
        if (requested == null || requested.optString("id", "").isEmpty()) {
            call.reject("Missing offline bundle details.");
            return;
        }
        try {
            JSONObject next = new JSONObject(requested.toString());
            JSONObject existing = null;
            JSONArray stored = readManifest();
            for (int index = 0; index < stored.length(); index++) {
                JSONObject candidate = stored.getJSONObject(index);
                if (next.optString("id").equals(candidate.optString("id"))) { existing = candidate; break; }
            }
            if (existing == null) { call.reject("Offline bundle no longer exists."); return; }
            Map<String, JSONObject> oldByPath = new HashMap<>();
            List<JSONObject> oldFileList = new ArrayList<>();
            JSONArray oldFiles = existing.optJSONArray("files");
            if (oldFiles != null) for (int index = 0; index < oldFiles.length(); index++) {
                JSONObject file = oldFiles.getJSONObject(index);
                oldByPath.put(file.optString("path"), file);
                oldFileList.add(file);
            }
            Set<String> retainedUris = ConcurrentHashMap.newKeySet();
            JSONArray newFiles = next.getJSONArray("files");
            for (int index = 0; index < newFiles.length(); index++) {
                JSONObject file = newFiles.getJSONObject(index);
                String path = file.optString("path");
                JSONObject old = oldByPath.get(path);
                if (old == null || !savedFileComplete(old)) {
                    for (JSONObject candidate : oldFileList) {
                        if (candidate.optLong("size", -1) == file.optLong("size", -2)
                            && candidate.optString("name").equals(file.optString("name"))
                            && savedFileComplete(candidate)) { old = candidate; break; }
                    }
                }
                if (old != null && old.optLong("size", -1) == file.optLong("size", -2) && savedFileComplete(old)) {
                    file.put("localUri", old.optString("localUri"));
                    retainedUris.add(old.optString("localUri"));
                }
            }
            JSONObject oldCovers = existing.optJSONObject("covers");
            JSONObject nextCovers = next.optJSONObject("covers");
            if (oldCovers != null && nextCovers != null) {
                Iterator<String> paths = nextCovers.keys();
                while (paths.hasNext()) {
                    String path = paths.next();
                    JSONObject oldCover = oldCovers.optJSONObject(path);
                    JSONObject nextCover = nextCovers.optJSONObject(path);
                    if (oldCover != null && nextCover != null
                        && oldCover.optString("url").equals(nextCover.optString("url"))
                        && savedDocumentExists(oldCover)) nextCover.put("localUri", oldCover.optString("localUri"));
                }
            }
            next.put("status", "ready");
            next.put("syncPreviousBundle", new JSONObject(existing.toString()));
            next.put("updatedAt", System.currentTimeMillis());
            JSObject result = new JSObject();
            result.put("bundle", new JSObject(next.toString()));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not reconcile the offline bundle.", error);
        }
    }

    @PluginMethod
    public void saveOfflineUserState(PluginCall call) {
        int ownerId = call.getInt("ownerId", 0);
        JSObject state = call.getObject("state");
        if (ownerId == 0 || state == null) {
            call.reject("Missing offline user state.");
            return;
        }
        preferences().edit()
            .putInt(LAST_OWNER_ID, ownerId)
            .putString(OFFLINE_USER_STATE_PREFIX + ownerId, state.toString())
            .apply();
        call.resolve();
    }

    @PluginMethod
    public void getOfflineUserState(PluginCall call) {
        try {
            int ownerId = resolveOfflineOwnerId(readManifest(), call.getInt("ownerId", 0));
            String saved = ownerId == 0 ? "" : preferences().getString(OFFLINE_USER_STATE_PREFIX + ownerId, "");
            JSObject result = new JSObject();
            if (!saved.isEmpty()) result.put("state", new JSObject(saved));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read offline user state.", error);
        }
    }

    @PluginMethod
    public void queueOfflineOrganization(PluginCall call) {
        queuePendingChange(call, PENDING_ORGANIZATION_PREFIX, "organization");
    }

    @PluginMethod
    public void queueOfflineFavorite(PluginCall call) {
        queuePendingChange(call, PENDING_FAVORITES_PREFIX, "favorite");
    }

    private void queuePendingChange(PluginCall call, String prefix, String label) {
        try {
            int ownerId = resolveOfflineOwnerId(readManifest(), call.getInt("ownerId", 0));
            JSObject update = call.getObject("update");
            String path = update == null ? "" : update.optString("path", "");
            if (ownerId == 0 || path.isEmpty()) {
                call.reject("Missing offline " + label + " update.");
                return;
            }
            JSONArray changes = new JSONArray(preferences().getString(prefix + ownerId, "[]"));
            JSONArray next = new JSONArray();
            for (int index = 0; index < changes.length(); index++) {
                JSONObject existing = changes.getJSONObject(index);
                if (!path.equals(existing.optString("path", ""))) next.put(existing);
            }
            next.put(new JSONObject(update.toString()));
            preferences().edit().putInt(LAST_OWNER_ID, ownerId).putString(prefix + ownerId, next.toString()).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not queue offline " + label + " update.", error);
        }
    }

    @PluginMethod
    public void getPendingOfflineChanges(PluginCall call) {
        try {
            int ownerId = resolveOfflineOwnerId(readManifest(), call.getInt("ownerId", 0));
            JSObject result = new JSObject();
            result.put("organization", new JSArray(preferences().getString(PENDING_ORGANIZATION_PREFIX + ownerId, "[]")));
            result.put("favorites", new JSArray(preferences().getString(PENDING_FAVORITES_PREFIX + ownerId, "[]")));
            result.put("catalog", new JSArray(preferences().getString(PENDING_CATALOG_PREFIX + ownerId, "[]")));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read pending offline changes.", error);
        }
    }

    @PluginMethod
    public void replacePendingOfflineChanges(PluginCall call) {
        try {
            int ownerId = resolveOfflineOwnerId(readManifest(), call.getInt("ownerId", 0));
            if (ownerId == 0) {
                call.reject("No offline user is available.");
                return;
            }
            JSArray organization = call.getArray("organization", new JSArray());
            JSArray favorites = call.getArray("favorites", new JSArray());
            JSArray catalog = call.getArray("catalog", new JSArray());
            preferences().edit()
                .putString(PENDING_ORGANIZATION_PREFIX + ownerId, organization.toString())
                .putString(PENDING_FAVORITES_PREFIX + ownerId, favorites.toString())
                .putString(PENDING_CATALOG_PREFIX + ownerId, catalog.toString())
                .apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not save pending offline changes.", error);
        }
    }

    @PluginMethod
    public void clearPendingOfflineChange(PluginCall call) {
        try {
            int ownerId = resolveOfflineOwnerId(readManifest(), call.getInt("ownerId", 0));
            String path = call.getString("path", "");
            String kind = call.getString("kind", "");
            String prefix = "organization".equals(kind) ? PENDING_ORGANIZATION_PREFIX : "favorite".equals(kind) ? PENDING_FAVORITES_PREFIX : "";
            if (ownerId == 0 || path.isEmpty() || prefix.isEmpty()) {
                call.reject("Missing pending offline change.");
                return;
            }
            JSONArray current = new JSONArray(preferences().getString(prefix + ownerId, "[]"));
            JSONArray next = new JSONArray();
            for (int index = 0; index < current.length(); index++) {
                JSONObject update = current.getJSONObject(index);
                if (!path.equals(update.optString("path", ""))) next.put(update);
            }
            preferences().edit().putString(prefix + ownerId, next.toString()).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not clear pending offline change.", error);
        }
    }

    /**
     * The standalone offline shell has a different WebView origin from the
     * connected TMS app, so it cannot read the connected app's localStorage
     * owner id. Prefer the persisted owner and recover it from older manifest
     * entries that were downloaded before LAST_OWNER_ID existed.
     */
    private int resolveOfflineOwnerId(JSONArray stored, int requestedOwnerId) throws Exception {
        if (requestedOwnerId != 0) return requestedOwnerId;

        int rememberedOwnerId = preferences().getInt(LAST_OWNER_ID, 0);
        if (rememberedOwnerId != 0) return rememberedOwnerId;

        for (int index = stored.length() - 1; index >= 0; index--) {
            int recoveredOwnerId = stored.getJSONObject(index).optInt("ownerId", 0);
            if (recoveredOwnerId != 0) {
                preferences().edit().putInt(LAST_OWNER_ID, recoveredOwnerId).apply();
                return recoveredOwnerId;
            }
        }
        return 0;
    }

    @PluginMethod
    public void open(PluginCall call) {
        String value = call.getString("uri", "");
        if (value.isEmpty()) {
            call.reject("Missing offline file.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(Uri.parse(value), call.getString("mimeType", "*/*"))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("No app could open this offline file.", error);
        }
    }

    private interface DownloadProgress {
        void onProgress(long downloadedBytes) throws Exception;
    }

    private boolean savedFileComplete(JSONObject file) {
        String value = file.optString("localUri", "");
        if (value.isEmpty()) return false;
        try (Cursor cursor = getContext().getContentResolver().query(Uri.parse(value),
            new String[]{DocumentsContract.Document.COLUMN_SIZE}, null, null, null)) {
            return cursor != null && cursor.moveToFirst() && cursor.getLong(0) == file.optLong("size", 0);
        } catch (Exception unavailable) { return false; }
    }

    private boolean savedDocumentExists(JSONObject file) {
        String value = file.optString("localUri", "");
        if (value.isEmpty()) return false;
        try (InputStream input = getContext().getContentResolver().openInputStream(Uri.parse(value))) {
            return input != null;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void reportDownloadProgress(
        JSONObject bundle,
        long completedBytes,
        long currentFileBytes,
        long currentFileTotalBytes,
        long startedAt,
        int totalFiles,
        int currentFile,
        String currentFileName,
        long[] lastPersistedAt,
        boolean force
    ) throws Exception {
        long now = System.currentTimeMillis();
        if (!force && now - lastPersistedAt[0] < 500) return;
        long downloadedBytes = completedBytes + currentFileBytes;
        long elapsedMillis = Math.max(1, now - startedAt);
        long speedBytes = downloadedBytes * 1000 / elapsedMillis;
        long remainingBytes = Math.max(0, bundle.optLong("totalBytes", 0) - downloadedBytes);
        bundle.put("downloadedBytes", downloadedBytes);
        bundle.put("completedFiles", Math.max(0, currentFile - 1));
        bundle.put("totalFiles", totalFiles);
        bundle.put("currentFileIndex", currentFile);
        bundle.put("currentFileName", currentFileName);
        bundle.put("currentFileDownloadedBytes", currentFileBytes);
        bundle.put("currentFileTotalBytes", currentFileTotalBytes);
        bundle.put("downloadSpeedBytes", speedBytes);
        bundle.put("etaSeconds", speedBytes > 0 ? remainingBytes / speedBytes : 0);
        bundle.put("updatedAt", now);
        upsertBundle(bundle);
        lastPersistedAt[0] = now;
    }

    private long downloadTo(String source, String token, Uri destination, DownloadProgress progress) throws Exception {
        if (source.startsWith("/")) {
            String server = getBridge().getServerUrl();
            if (server == null || server.isEmpty()) server = getBridge().getLocalUrl();
            if (server == null || server.isEmpty()) throw new Exception("No TMS server URL is available for offline sync.");
            source = server.replaceAll("/+$", "") + source;
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(source).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);
        connection.setUseCaches(false);
        connection.setRequestProperty("Connection", "close");
        if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
        long total = 0;
        AtomicReference<HttpURLConnection> activeConnection = new AtomicReference<>(connection);
        AtomicLong lastByteAt = new AtomicLong(System.currentTimeMillis());
        ScheduledFuture<?> watchdog = downloadWatchdog.scheduleAtFixedRate(() -> {
            if (System.currentTimeMillis() - lastByteAt.get() >= 35_000) {
                HttpURLConnection active = activeConnection.get();
                if (active != null) active.disconnect();
            }
        }, 35, 2, TimeUnit.SECONDS);
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new Exception("Server returned " + status);
            try (InputStream input = new BufferedInputStream(connection.getInputStream());
             OutputStream output = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                if (output == null) throw new Exception("The selected folder is not writable.");
                byte[] buffer = new byte[128 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    output.write(buffer, 0, read);
                    total += read;
                    lastByteAt.set(System.currentTimeMillis());
                    progress.onProgress(total);
                }
            }
        } finally {
            activeConnection.set(null);
            watchdog.cancel(true);
            connection.disconnect();
        }
        return total;
    }

    private Uri findOrCreateDirectory(Uri parent, String name) throws Exception {
        Uri existing = findChild(parent, name);
        if (existing != null) return existing;
        Uri created = DocumentsContract.createDocument(getContext().getContentResolver(), documentUri(parent), DocumentsContract.Document.MIME_TYPE_DIR, name);
        if (created == null) throw new Exception("Could not create " + name + " in the selected folder.");
        return created;
    }

    private Uri findOrCreateFile(Uri parent, String mime, String name) throws Exception {
        Uri existing = findChild(parent, name);
        if (existing != null) return existing;
        Uri created = DocumentsContract.createDocument(getContext().getContentResolver(), documentUri(parent), mime, name);
        if (created == null) throw new Exception("Could not create " + name + ".");
        return created;
    }

    private Uri findChild(Uri parent, String name) {
        Uri children = childDocumentsUri(parent);
        try (Cursor cursor = getContext().getContentResolver().query(children,
            new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            while (cursor != null && cursor.moveToNext()) {
                if (name.equals(cursor.getString(1))) return DocumentsContract.buildDocumentUriUsingTree(parent, cursor.getString(0));
            }
        } catch (Exception ignored) {}
        return null;
    }

    private boolean hasTreePermission(String value) {
        if (value == null || value.isEmpty()) return false;
        for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (permission.isReadPermission() && value.equals(permission.getUri().toString())) return true;
        }
        return false;
    }

    // Keep the selected tree and catalog even if its provider temporarily
    // returns no rows (unmounted storage, startup, or a provider outage).
    // Only an explicit location change/removal may discard saved access.

    private static final class IndexedDocument {
        final String uri;
        final String name;
        final String relativePath;
        final long size;
        boolean claimed;

        IndexedDocument(String uri, String name, String relativePath, long size) {
            this.uri = uri;
            this.name = name;
            this.relativePath = relativePath;
            this.size = size;
        }
    }

    /**
     * Downloads live in the user-selected SAF folder but their catalog normally
     * lives in app-private storage.  An uninstall removes that catalog without
     * removing the media (and a backup restore can bring back a catalog whose
     * file grants are gone), so rebuild it from the folder whenever one is
     * chosen: restore bundles from the folder's catalog copy, rebind every
     * known file to the document now in the folder, and turn any remaining
     * older downloads into recovered bundles.
     */
    private synchronized void recoverCatalogFromSelectedFolder(Uri tree) {
        try {
            Map<String, IndexedDocument> byPath = new LinkedHashMap<>();
            indexDocuments(tree, "", byPath);
            JSONArray manifest = readManifest();
            Set<String> knownIds = new HashSet<>();
            for (int index = 0; index < manifest.length(); index++) knownIds.add(manifest.getJSONObject(index).optString("id"));

            boolean changed = false;
            List<Uri> catalogs = new ArrayList<>();
            Uri metadata = findChildStrict(tree, METADATA_ROOT);
            if (metadata != null) {
                Uri catalog = findChildStrict(metadata, FOLDER_CATALOG);
                if (catalog != null) catalogs.add(catalog);
            }
            for (String catalogPath : new String[]{TMS_ROOT + "/" + FOLDER_CATALOG, FOLDER_CATALOG}) {
                IndexedDocument catalog = byPath.get(catalogPath);
                if (catalog != null) { catalog.claimed = true; catalogs.add(Uri.parse(catalog.uri)); }
            }
            for (Uri catalog : catalogs) {
                JSONArray saved;
                try {
                    saved = new JSONArray(readDocument(catalog));
                } catch (Exception unreadable) {
                    android.util.Log.w("TmsOffline", "Ignoring unreadable offline folder catalog", unreadable);
                    continue;
                }
                for (int index = 0; index < saved.length(); index++) {
                    JSONObject bundle = saved.optJSONObject(index);
                    if (bundle == null || bundle.optString("id").isEmpty() || !knownIds.add(bundle.optString("id"))) continue;
                    manifest.put(bundle);
                    changed = true;
                }
            }

            // Repair metadata accidentally imported as media by an older
            // resync, including metadata-only recovered bundles.
            JSONArray contentManifest = new JSONArray();
            for (int index = 0; index < manifest.length(); index++) {
                JSONObject bundle = manifest.getJSONObject(index);
                JSONArray files = bundle.optJSONArray("files");
                JSONArray content = new JSONArray();
                if (files != null) for (int fileIndex = 0; fileIndex < files.length(); fileIndex++) {
                    JSONObject file = files.getJSONObject(fileIndex);
                    String local = file.optString("localUri", "");
                    String documentPath = local.isEmpty() ? "" : DocumentsContract.getDocumentId(Uri.parse(local));
                    if (OfflineStorageLayout.isMetadataPath(file.optString("relativePath", file.optString("name")))
                        || OfflineStorageLayout.isMetadataPath(documentPath)) { changed = true; continue; }
                    content.put(file);
                }
                if (files != null && content.length() != files.length()) {
                    if (content.length() == 0) continue;
                    bundle.put("files", content);
                    bundle.put("totalFiles", content.length());
                    bundle.put("completedFiles", content.length());
                }
                contentManifest.put(bundle);
            }
            manifest = contentManifest;

            Map<String, IndexedDocument> byUri = new HashMap<>();
            for (IndexedDocument document : byPath.values()) byUri.put(document.uri, document);
            for (int index = 0; index < manifest.length(); index++) {
                if (rebindBundle(manifest.getJSONObject(index), byPath, byUri)) changed = true;
            }

            // Media from downloads that predate the folder catalog.
            Map<String, JSONObject> recovered = new LinkedHashMap<>();
            for (IndexedDocument document : byPath.values()) {
                // Hidden files are the catalog itself or stale folder art.
                if (document.claimed || OfflineStorageLayout.isMetadataPath(document.relativePath)) continue;
                String[] parts = document.relativePath.split("/");
                int depth;
                String name;
                if (parts.length > 2 && parts[0].equals(TMS_ROOT)) {
                    depth = 2;
                    // Download folders are "<name>-<first 8 characters of the id>".
                    name = parts[1].replaceFirst("-[^-]{1,8}$", "");
                } else if (parts.length > 1 && !parts[0].equals(TMS_ROOT)) {
                    depth = 1;
                    name = parts[0];
                } else {
                    depth = parts.length - 1;
                    name = documentName(tree);
                }
                String key = String.join("/", Arrays.copyOfRange(parts, 0, depth));
                JSONObject bundle = recovered.get(key);
                if (bundle == null) {
                    String id = "recovered-" + Integer.toHexString((tree + "|" + key).hashCode());
                    if (knownIds.contains(id)) continue;
                    bundle = new JSONObject();
                    bundle.put("id", id);
                    bundle.put("ownerId", 0);
                    bundle.put("ownerName", "Recovered offline library");
                    bundle.put("path", "Recovered/" + name);
                    bundle.put("name", name);
                    bundle.put("kind", "folder");
                    bundle.put("status", "ready");
                    bundle.put("createdAt", System.currentTimeMillis());
                    bundle.put("downloadedBytes", 0);
                    bundle.put("totalBytes", 0);
                    bundle.put("files", new JSONArray());
                    recovered.put(key, bundle);
                }
                JSONObject file = new JSONObject();
                file.put("id", "recovered-file-" + Integer.toHexString(document.uri.hashCode()));
                file.put("name", document.name);
                file.put("kind", recoveredKind(document.name));
                file.put("size", document.size);
                file.put("url", "");
                file.put("relativePath", String.join("/", Arrays.copyOfRange(parts, depth, parts.length)));
                file.put("localUri", document.uri);
                bundle.getJSONArray("files").put(file);
                bundle.put("downloadedBytes", bundle.optLong("downloadedBytes") + document.size);
                bundle.put("totalBytes", bundle.optLong("totalBytes") + document.size);
                document.claimed = true;
            }
            for (JSONObject bundle : recovered.values()) {
                int count = bundle.getJSONArray("files").length();
                bundle.put("completedFiles", count);
                bundle.put("totalFiles", count);
                manifest.put(bundle);
                changed = true;
            }
            if (changed) writeManifest(manifest);
            persistFolderCatalog();
        } catch (Exception error) {
            android.util.Log.w("TmsOffline", "Could not recover offline catalog", error);
        }
    }

    /**
     * Point a bundle's files at the documents that are in the selected folder
     * now. Files are matched by their saved URI, then by the path the download
     * wrote them to, then by name and size (older builds moved audio).
     */
    private boolean rebindBundle(JSONObject bundle, Map<String, IndexedDocument> byPath, Map<String, IndexedDocument> byUri) throws Exception {
        String id = bundle.optString("id", "");
        String folder = safeSegment(bundle.optString("name", "Download")) + "-" + id.substring(0, Math.min(8, id.length()));
        boolean changed = false;
        int missing = 0;
        JSONArray files = bundle.optJSONArray("files");
        List<JSONObject> entries = new ArrayList<>();
        if (files != null) for (int index = 0; index < files.length(); index++) entries.add(files.getJSONObject(index));
        int mediaCount = entries.size();
        if (bundle.optJSONObject("cover") != null) entries.add(bundle.getJSONObject("cover"));
        JSONObject covers = bundle.optJSONObject("covers");
        if (covers != null) {
            Iterator<String> keys = covers.keys();
            while (keys.hasNext()) entries.add(covers.getJSONObject(keys.next()));
        }
        for (int index = 0; index < entries.size(); index++) {
            JSONObject file = entries.get(index);
            boolean isCover = index >= mediaCount;
            long size = file.optLong("size", 0);
            String saved = file.optString("localUri", "");
            String relative;
            if (isCover) relative = safeSegment(file.optString("relativePath", "folder-cover.jpg"));
            else {
                List<String> segments = new ArrayList<>();
                for (String part : file.optString("relativePath", file.optString("name")).split("/")) {
                    if (!part.isEmpty()) segments.add(safeSegment(part));
                }
                relative = String.join("/", segments);
            }
            IndexedDocument match = null;
            for (IndexedDocument candidate : new IndexedDocument[]{
                byUri.get(saved), byPath.get(TMS_ROOT + "/" + folder + "/" + relative), byPath.get(folder + "/" + relative),
            }) {
                if (candidate != null && !candidate.claimed && (size <= 0 || candidate.size == size)) { match = candidate; break; }
            }
            if (match == null && !isCover && size > 0) {
                String name = file.optString("name", "");
                for (IndexedDocument candidate : byPath.values()) {
                    if (!candidate.claimed && candidate.size == size && candidate.name.equals(name)) { match = candidate; break; }
                }
            }
            if (match != null) {
                match.claimed = true;
                if (!match.uri.equals(saved)) {
                    file.put("localUri", match.uri);
                    changed = true;
                }
            } else if (!saved.isEmpty() && !(isCover ? savedDocumentExists(file) : savedFileComplete(file))) {
                // Not in this folder and no longer readable: download it again.
                file.remove("localUri");
                changed = true;
                if (!isCover) missing++;
            } else if (saved.isEmpty() && !isCover) {
                missing++;
            }
        }
        String status = bundle.optString("status");
        if (missing > 0 && "ready".equals(status)) {
            bundle.put("status", "error");
            bundle.put("error", missing + (missing == 1 ? " file is" : " files are") + " missing from the offline folder. Try again to download " + (missing == 1 ? "it." : "them."));
            changed = true;
        } else if (missing == 0 && mediaCount > 0 && "error".equals(status)) {
            bundle.put("status", "ready");
            bundle.remove("error");
            changed = true;
        }
        return changed;
    }

    private void indexDocuments(Uri directory, String relativePath, Map<String, IndexedDocument> out) throws Exception {
        indexDocuments(directory, relativePath, out, false);
    }

    private void indexDocuments(Uri directory, String relativePath, Map<String, IndexedDocument> out, boolean includeMetadata) throws Exception {
        List<Uri> folders = new ArrayList<>();
        List<String> folderPaths = new ArrayList<>();
        try (Cursor cursor = getContext().getContentResolver().query(childDocumentsUri(directory), new String[]{
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
        }, null, null, null)) {
            if (cursor == null) throw new Exception("Could not read the offline folder. Reconnect it and try again.");
            while (cursor.moveToNext()) {
                String name = cursor.getString(1);
                String path = relativePath.isEmpty() ? name : relativePath + "/" + name;
                Uri child = DocumentsContract.buildDocumentUriUsingTree(directory, cursor.getString(0));
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2))) {
                    // Hidden folders such as Android's .thumbnails are not downloads.
                    if (name.startsWith(".") && !(includeMetadata && name.equals(METADATA_ROOT))) continue;
                    folders.add(child);
                    folderPaths.add(path);
                    continue;
                }
                long size = Math.max(0, cursor.isNull(3) ? 0 : cursor.getLong(3));
                out.put(path, new IndexedDocument(child.toString(), name, path, size));
            }
        }
        for (int index = 0; index < folders.size(); index++) indexDocuments(folders.get(index), folderPaths.get(index), out, includeMetadata);
    }

    private String readDocument(Uri uri) throws Exception {
        try (InputStream input = getContext().getContentResolver().openInputStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new Exception("Could not open " + uri);
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** Mirror the catalog into the selected folder so a reinstall can restore it. */
    private synchronized void persistFolderCatalog() {
        String treeValue = preferences().getString(TREE_URI, "");
        if (!hasTreePermission(treeValue)) return;
        try {
            JSONArray manifest = readManifest();
            Set<String> oldCovers = migrateCovers(Uri.parse(treeValue), manifest);
            writeManifest(manifest);
            persistFolderCatalog(manifest);
            Set<String> referenced = new HashSet<>();
            for (int index = 0; index < manifest.length(); index++) referenced.addAll(bundleDocumentUris(manifest.getJSONObject(index)));
            for (String uri : oldCovers) if (!referenced.contains(uri)) deleteDocumentStrict(Uri.parse(uri));
        } catch (Exception error) {
            android.util.Log.w("TmsOffline", "Could not save the offline folder catalog", error);
        }
    }

    private JSObject persistedBundle(JSONObject fallback) throws Exception {
        JSONArray manifest = readManifest();
        for (int index = 0; index < manifest.length(); index++) {
            JSONObject bundle = manifest.getJSONObject(index);
            if (bundle.optString("id").equals(fallback.optString("id"))) return new JSObject(bundle.toString());
        }
        return new JSObject(fallback.toString());
    }

    private void persistFolderCatalog(JSONArray manifest) throws Exception {
        String treeValue = preferences().getString(TREE_URI, "");
        if (!hasTreePermission(treeValue)) throw new Exception("Reconnect the original offline folder to remove its files and metadata.");
        Uri tree = Uri.parse(treeValue);
        Uri root = manifest.length() == 0 ? findChildStrict(tree, METADATA_ROOT) : findOrCreateDirectory(tree, METADATA_ROOT);
        if (root != null) writeFolderCatalog(root, manifest, manifest.length() > 0);
        // Only remove legacy copies after the new catalog is safely written.
        Uri legacy = findChildStrict(tree, TMS_ROOT);
        if (legacy != null) writeFolderCatalog(legacy, new JSONArray(), false);
        writeFolderCatalog(tree, new JSONArray(), false);
        preferences().edit().putString(METADATA_LAYOUT_TREE, treeValue).apply();
    }

    private Uri metadataCoverDestination(Uri tree, JSONObject bundle, JSONObject cover) throws Exception {
        Uri root = findOrCreateDirectory(tree, METADATA_ROOT);
        Uri folder = findOrCreateDirectory(root, safeSegment(bundle.getString("id")));
        String name = safeSegment(cover.optString("relativePath", "folder-cover.jpg"));
        if (bundle.optJSONObject("syncPreviousBundle") != null) name = "sync-" + Integer.toHexString(cover.optString("url").hashCode()) + "-" + name;
        return findOrCreateFile(folder, mimeType(cover.optString("name", "folder-cover.jpg")), name);
    }

    private Set<String> migrateCovers(Uri tree, JSONArray manifest) throws Exception {
        Set<String> old = new HashSet<>();
        for (int index = 0; index < manifest.length(); index++) {
            JSONObject bundle = manifest.getJSONObject(index);
            List<JSONObject> covers = new ArrayList<>();
            if (bundle.optJSONObject("cover") != null) covers.add(bundle.getJSONObject("cover"));
            JSONObject nested = bundle.optJSONObject("covers");
            if (nested != null) {
                Iterator<String> keys = nested.keys();
                while (keys.hasNext()) covers.add(nested.getJSONObject(keys.next()));
            }
            for (JSONObject cover : covers) {
                if (!savedDocumentExists(cover)) continue;
                String source = cover.getString("localUri");
                Uri target = metadataCoverDestination(tree, bundle, cover);
                if (source.equals(target.toString())) continue;
                try (InputStream input = getContext().getContentResolver().openInputStream(Uri.parse(source));
                     OutputStream output = getContext().getContentResolver().openOutputStream(target, "wt")) {
                    if (input == null || output == null) throw new Exception("Could not move offline cover metadata.");
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
                }
                cover.put("localUri", target.toString());
                old.add(source);
            }
        }
        return old;
    }

    private void writeFolderCatalog(Uri root, JSONArray manifest, boolean create) throws Exception {
        Uri target = findChildStrict(root, FOLDER_CATALOG);
        if (manifest.length() == 0) {
            if (target != null) deleteDocumentStrict(target);
            return;
        }
        if (target == null) {
            if (!create) return;
            target = findOrCreateFile(root, "application/json", FOLDER_CATALOG);
        }
        try (OutputStream output = getContext().getContentResolver().openOutputStream(target, "wt")) {
            if (output == null) throw new Exception("The selected folder is not writable.");
            output.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    private String recoveredKind(String name) {
        String mime = mimeType(name);
        if (mime.startsWith("audio/")) return "audio";
        if (mime.startsWith("video/")) return "video";
        if (mime.startsWith("image/")) return "image";
        return "file";
    }

    private Uri documentUri(Uri value) {
        // A child document URI ALSO has a tree prefix. Resolving it back to
        // the tree ID flattened every bundle/subfolder into the picked root.
        if (DocumentsContract.isDocumentUri(getContext(), value)) return value;
        if (DocumentsContract.isTreeUri(value)) return DocumentsContract.buildDocumentUriUsingTree(value, DocumentsContract.getTreeDocumentId(value));
        return value;
    }

    /**
     * Child document URIs also carry the selected-tree prefix, so they must be
     * recognized before a picked-root tree URI.  Otherwise recursion always
     * resolves back to the picked root instead of the child directory.
     */
    private Uri childDocumentsUri(Uri parent) {
        String documentId;
        if (DocumentsContract.isDocumentUri(getContext(), parent)) {
            documentId = DocumentsContract.getDocumentId(parent);
        } else if (DocumentsContract.isTreeUri(parent)) {
            documentId = DocumentsContract.getTreeDocumentId(parent);
        } else {
            documentId = DocumentsContract.getDocumentId(documentUri(parent));
        }
        return DocumentsContract.buildChildDocumentsUriUsingTree(parent, documentId);
    }

    private String documentName(Uri value) {
        try (Cursor cursor = getContext().getContentResolver().query(documentUri(value), new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {}
        return "Selected folder";
    }

    private Set<String> bundleDocumentUris(JSONObject bundle) throws Exception {
        Set<String> uris = new HashSet<>();
        JSONArray files = bundle.optJSONArray("files");
        if (files != null) for (int index = 0; index < files.length(); index++) {
            String uri = files.getJSONObject(index).optString("localUri", "");
            if (!uri.isEmpty()) uris.add(uri);
        }
        JSONObject cover = bundle.optJSONObject("cover");
        if (cover != null && !cover.optString("localUri").isEmpty()) uris.add(cover.optString("localUri"));
        JSONObject covers = bundle.optJSONObject("covers");
        if (covers != null) {
            Iterator<String> keys = covers.keys();
            while (keys.hasNext()) {
                String uri = covers.getJSONObject(keys.next()).optString("localUri", "");
                if (!uri.isEmpty()) uris.add(uri);
            }
        }
        return uris;
    }

    private Uri findChildStrict(Uri parent, String name) throws Exception {
        try (Cursor cursor = getContext().getContentResolver().query(childDocumentsUri(parent),
            new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor == null) throw new Exception("Could not read the offline folder. Reconnect it and try again.");
            while (cursor.moveToNext()) {
                if (name.equals(cursor.getString(1))) return DocumentsContract.buildDocumentUriUsingTree(parent, cursor.getString(0));
            }
        }
        return null;
    }

    private void deleteDocumentStrict(Uri uri) throws Exception {
        // An empty query means the document is already gone; provider and
        // permission errors must propagate instead of forgetting the download.
        try (Cursor cursor = getContext().getContentResolver().query(uri,
            new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID}, null, null, null)) {
            if (cursor == null) throw new Exception("Could not check an offline file. Reconnect its folder and try again.");
            if (!cursor.moveToFirst()) return;
        } catch (java.io.FileNotFoundException missing) {
            return;
        }
        if (!DocumentsContract.deleteDocument(getContext().getContentResolver(), uri)) throw new Exception("Could not delete an offline file or folder. Try again.");
    }

    private void deleteBundleFolder(JSONObject bundle, JSONArray manifest) throws Exception {
        String treeValue = preferences().getString(TREE_URI, "");
        if (!hasTreePermission(treeValue)) throw new Exception("Reconnect the original offline folder to remove its files and metadata.");
        Uri tree = Uri.parse(treeValue);
        Map<String, IndexedDocument> documents = new LinkedHashMap<>();
        indexDocuments(tree, "", documents, true);
        Set<String> retained = new HashSet<>();
        for (int index = 0; index < manifest.length(); index++) {
            JSONObject other = manifest.getJSONObject(index);
            if (!bundle.optString("id").equals(other.optString("id"))) retained.addAll(bundleDocumentUris(other));
        }
        Map<String, String> paths = new LinkedHashMap<>();
        for (IndexedDocument document : documents.values()) {
            paths.put(document.relativePath, document.uri);
        }
        String id = bundle.optString("id", "");
        String folder = TMS_ROOT + "/" + safeSegment(bundle.optString("name", "Download")) + "-" + id.substring(0, Math.min(8, id.length()));
        OfflineDeletionPlan plan = new OfflineDeletionPlan(bundleDocumentUris(bundle), retained, paths, folder, TMS_ROOT);
        // Recovered and migrated downloads may live outside the generated
        // bundle directory. Their saved document URIs are authoritative.
        for (String uri : plan.files) deleteDocumentStrict(Uri.parse(uri));
        Uri target = findRelativeDirectory(tree, folder);
        if (target != null && !plan.sharedBundleFolder) deleteDocumentStrict(target);
        String metadataFolder = METADATA_ROOT + "/" + safeSegment(id);
        OfflineDeletionPlan metadataPlan = new OfflineDeletionPlan(bundleDocumentUris(bundle), retained, paths, metadataFolder, METADATA_ROOT);
        Uri metadata = findRelativeDirectory(tree, metadataFolder);
        if (metadata != null && !metadataPlan.sharedBundleFolder) deleteDocumentStrict(metadata);
        // Remove now-empty recovered folders, preserving folders with other
        // downloads or unrelated files and preserving the user's picked root.
        for (String path : plan.emptyFolderCandidates) {
            if (path.equals(METADATA_ROOT)) continue;
            Uri directory = findRelativeDirectory(tree, path);
            if (directory == null) continue;
            try (Cursor cursor = getContext().getContentResolver().query(childDocumentsUri(directory),
                new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID}, null, null, null)) {
                if (cursor == null) throw new Exception("Could not check an offline folder.");
                if (cursor.moveToFirst()) continue;
            }
            deleteDocumentStrict(directory);
        }
    }

    private Uri findRelativeDirectory(Uri root, String path) throws Exception {
        for (String part : path.split("/")) {
            root = findChildStrict(root, part);
            if (root == null) return null;
        }
        return root;
    }

    private synchronized JSONArray readManifest() throws Exception {
        File file = new File(getContext().getFilesDir(), MANIFEST);
        if (!file.exists()) return new JSONArray();
        byte[] data;
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            data = output.toByteArray();
        }
        return new JSONArray(new String(data, StandardCharsets.UTF_8));
    }

    private synchronized void writeManifest(JSONArray manifest) throws Exception {
        File file = new File(getContext().getFilesDir(), MANIFEST);
        File temporary = new File(getContext().getFilesDir(), MANIFEST + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (file.exists() && !file.delete()) throw new Exception("Could not update the offline catalog.");
        if (!temporary.renameTo(file)) throw new Exception("Could not save the offline catalog.");
    }

    private synchronized void upsertBundle(JSONObject bundle) throws Exception {
        if (bundle.optJSONObject("syncPreviousBundle") != null && "downloading".equals(bundle.optString("status"))) return;
        JSONArray stored = readManifest();
        JSONArray next = new JSONArray();
        boolean replaced = false;
        for (int index = 0; index < stored.length(); index++) {
            JSONObject current = stored.getJSONObject(index);
            if (bundle.optString("id").equals(current.optString("id"))) {
                next.put(bundle);
                replaced = true;
            } else next.put(current);
        }
        if (!replaced) next.put(bundle);
        writeManifest(next);
    }

    private static String safeSegment(String value) {
        String cleaned = value.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").replaceAll("[. ]+$", "");
        return cleaned.isEmpty() ? "item" : cleaned.substring(0, Math.min(150, cleaned.length()));
    }

    private static String mimeType(String name) {
        String extension = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
        if (extension.matches("mp4|mkv|webm|mov|avi|m4v|mpeg|mpg|wmv|3gp|ts|m2ts")) return "video/*";
        if (extension.matches("mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff|alac")) return "audio/*";
        if (extension.matches("jpg|jpeg|png|gif|webp|bmp|tif|tiff|avif|heic|heif")) return "image/*";
        if (extension.equals("pdf")) return "application/pdf";
        return "application/octet-stream";
    }

    @Override
    protected void handleOnDestroy() {
        downloads.shutdown();
    }
}
