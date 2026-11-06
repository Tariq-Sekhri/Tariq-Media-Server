package ca.sekhrit.tms;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Ownership and folder cleanup for both generated and recovered downloads. */
final class OfflineDeletionPlan {
    final Set<String> files;
    final List<String> emptyFolderCandidates;
    final boolean sharedBundleFolder;

    OfflineDeletionPlan(Set<String> owned, Set<String> retained, Map<String, String> documents,
                        String bundleFolder, String catalogRoot) {
        files = new HashSet<>(owned);
        files.removeAll(retained);
        Set<String> folders = new HashSet<>();
        boolean shared = false;
        for (Map.Entry<String, String> document : documents.entrySet()) {
            String path = document.getKey();
            String uri = document.getValue();
            if (path.startsWith(bundleFolder + "/") && retained.contains(uri)) shared = true;
            if (!files.contains(uri)) continue;
            while (path.contains("/")) {
                path = path.substring(0, path.lastIndexOf('/'));
                if (!path.equals(catalogRoot)) folders.add(path);
            }
        }
        sharedBundleFolder = shared;
        emptyFolderCandidates = new ArrayList<>(folders);
        emptyFolderCandidates.sort((a, b) -> Integer.compare(b.split("/").length, a.split("/").length));
    }
}
