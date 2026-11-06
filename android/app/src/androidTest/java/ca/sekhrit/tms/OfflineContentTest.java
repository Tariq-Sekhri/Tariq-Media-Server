package ca.sekhrit.tms;

import static org.junit.Assert.*;
import android.content.Context;
import android.net.Uri;
import com.getcapacitor.AndroidProtocolHandler;
import androidx.core.content.FileProvider;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

public class OfflineContentTest {
    private Uri webUrl(Uri content) {
        return Uri.parse("https://localhost/_capacitor_content_" + content.toString().substring("content:/".length()));
    }

    @Test public void readableAndDeletedDocuments() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File file = new File(context.getCacheDir(), "offline-cover-test.jpg");
        byte[] bytes = "test cover".getBytes(StandardCharsets.UTF_8);
        Files.write(file.toPath(), bytes);
        Uri content = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        AndroidProtocolHandler handler = new AndroidProtocolHandler(context);
        try (var stream = handler.openContentUrl(webUrl(content))) { assertArrayEquals(bytes, stream.readAllBytes()); }
        assertTrue(file.delete());
        try {
            handler.openContentUrl(webUrl(content));
            fail("Missing documents must follow Capacitor's IOException/404 path");
        } catch (java.io.FileNotFoundException expected) { }
    }

    @Test public void revokedTreeDoesNotCrash() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Uri content = Uri.parse("content://com.android.externalstorage.documents/tree/primary%3Adeleted-tms-test/document/primary%3Adeleted-tms-test%2Fcover.jpg");
        assertNull(new AndroidProtocolHandler(context).openContentUrl(webUrl(content)));
    }

    @Test public void deletedTreeProviderRuntimeExceptionDoesNotCrash() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Uri content = Uri.parse("content://ca.sekhrit.tms.test.deleted-tree/cover.jpg");
        assertNull(new AndroidProtocolHandler(context).openContentUrl(webUrl(content)));
    }
}
