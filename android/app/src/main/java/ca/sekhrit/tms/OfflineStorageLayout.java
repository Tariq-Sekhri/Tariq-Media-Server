package ca.sekhrit.tms;

final class OfflineStorageLayout {
    static final String METADATA = ".tms_data";
    static final String CATALOG = ".tms-offline-catalog.json";

    static boolean isMetadataPath(String path) {
        for (String segment : path.split("/")) {
            if (segment.startsWith(".") || segment.equals("folder-cover.jpg")) return true;
        }
        return false;
    }
}
