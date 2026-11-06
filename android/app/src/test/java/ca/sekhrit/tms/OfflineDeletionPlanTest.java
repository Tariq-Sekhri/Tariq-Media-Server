package ca.sekhrit.tms;

import org.junit.Test;
import java.util.Map;
import java.util.Set;
import static org.junit.Assert.*;

public class OfflineDeletionPlanTest {
    @Test public void recoveredFilesAndCoversAreDeletedFromTheirActualLocations() {
        OfflineDeletionPlan plan = new OfflineDeletionPlan(Set.of("audio", "cover", "nested-cover"), Set.of(), Map.of(
            "Artist/song.mp3", "audio", "Artist/.cover.jpg", "cover", "Artist/Album/.cover.jpg", "nested-cover"),
            "TMS Offline/Recovered-recovere", "TMS Offline");
        assertEquals(Set.of("audio", "cover", "nested-cover"), plan.files);
        assertEquals(2, plan.emptyFolderCandidates.size());
        assertEquals("Artist/Album", plan.emptyFolderCandidates.get(0));
        assertEquals("Artist", plan.emptyFolderCandidates.get(1));
        assertFalse(plan.sharedBundleFolder);
    }

    @Test public void sharedMediaAndCoversSurviveRemovingAnotherBundle() {
        OfflineDeletionPlan plan = new OfflineDeletionPlan(Set.of("audio", "cover"), Set.of("cover", "other-audio"), Map.of(
            "TMS Offline/Album-id/song.mp3", "audio", "TMS Offline/Album-id/.cover.jpg", "cover",
            "TMS Offline/Album-id/other.mp3", "other-audio"), "TMS Offline/Album-id", "TMS Offline");
        assertEquals(Set.of("audio"), plan.files);
        assertTrue(plan.sharedBundleFolder);
        assertFalse(plan.emptyFolderCandidates.contains("TMS Offline"));
    }

    @Test public void rootLevelLegacyFilesNeverMakeTheSelectedRootADeletionTarget() {
        OfflineDeletionPlan plan = new OfflineDeletionPlan(Set.of("audio"), Set.of(), Map.of("song.mp3", "audio"),
            "TMS Offline/Album-id", "TMS Offline");
        assertEquals(Set.of("audio"), plan.files);
        assertTrue(plan.emptyFolderCandidates.isEmpty());
    }

    @Test public void missingFilesRemainSafeToRetryWithoutRemovingUnrelatedFolders() {
        OfflineDeletionPlan plan = new OfflineDeletionPlan(Set.of("missing"), Set.of(), Map.of("Other/file.mp3", "unrelated"),
            "TMS Offline/Album-id", "TMS Offline");
        assertEquals(Set.of("missing"), plan.files);
        assertTrue(plan.emptyFolderCandidates.isEmpty());
    }
}
