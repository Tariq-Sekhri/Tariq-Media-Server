package ca.sekhrit.tms;

import org.junit.Test;
import static org.junit.Assert.*;

public class OfflineStorageLayoutTest {
    @Test public void metadataContentsNeverBecomeRecoveredMedia() {
        assertTrue(OfflineStorageLayout.isMetadataPath(".tms_data/id/art.jpg"));
        assertTrue(OfflineStorageLayout.isMetadataPath("Album/.tms_data/catalog.json"));
        assertTrue(OfflineStorageLayout.isMetadataPath("TMS Offline/.tms-offline-catalog.json"));
        assertTrue(OfflineStorageLayout.isMetadataPath("Album/.tms-folder-cover-123.jpg"));
        assertTrue(OfflineStorageLayout.isMetadataPath("Album/folder-cover.jpg"));
        assertTrue(OfflineStorageLayout.isMetadataPath("primary:offline/.tms_data/id/art.jpg"));
    }

    @Test public void similarlyNamedRealContentStaysRecoverable() {
        assertFalse(OfflineStorageLayout.isMetadataPath("Artist/Album/song.mp3"));
        assertFalse(OfflineStorageLayout.isMetadataPath("tms_data/song.mp3"));
        assertFalse(OfflineStorageLayout.isMetadataPath("Album/cover.jpg"));
    }
}
