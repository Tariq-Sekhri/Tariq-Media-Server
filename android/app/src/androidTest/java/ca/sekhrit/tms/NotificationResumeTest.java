package ca.sekhrit.tms;

import static org.junit.Assert.*;

import android.content.Intent;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** Exercises the real Capacitor callback and Android media-session transport. */
public class NotificationResumeTest {
    private final android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private WebView webView;

    private String evaluate(String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> webView.evaluateJavascript(script, result -> {
            value.set(result);
            done.countDown();
        }));
        assertTrue("WebView callback timed out", done.await(10, TimeUnit.SECONDS));
        return value.get();
    }

    private void await(String script) throws Exception {
        long deadline = System.currentTimeMillis() + 15_000;
        while (System.currentTimeMillis() < deadline) {
            if ("true".equals(evaluate(script))) return;
            Thread.sleep(200);
        }
        fail("Timed out: " + script + "; state=" + evaluate("JSON.stringify({paused:window.audio?.paused,time:window.audio?.currentTime,error:window.testError})"));
    }

    private void dispatch(String command) throws Exception {
        try (ParcelFileDescriptor fd = instrumentation.getUiAutomation().executeShellCommand("cmd media_session dispatch " + command);
             var input = new ParcelFileDescriptor.AutoCloseInputStream(fd)) {
            input.readAllBytes();
        }
    }

    private void pressNotificationPlay() throws Exception {
        android.app.NotificationManager manager = instrumentation.getTargetContext().getSystemService(android.app.NotificationManager.class);
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline) {
            for (var notification : manager.getActiveNotifications()) {
                if (notification.getNotification().actions == null) continue;
                for (var action : notification.getNotification().actions) {
                    if (!"Play".contentEquals(action.title)) continue;
                    assertNotNull("Notification Play must have a valid PendingIntent", action.actionIntent);
                    action.actionIntent.send();
                    return;
                }
            }
            Thread.sleep(100);
        }
        fail("Paused playback notification has no Play action");
    }

    private android.service.notification.StatusBarNotification playbackNotification() {
        var manager = instrumentation.getTargetContext().getSystemService(android.app.NotificationManager.class);
        for (var entry : manager.getActiveNotifications()) {
            if (entry.getId() == 1 && entry.getNotification().extras.getString(android.app.Notification.EXTRA_TITLE, "").equals("TMS resume test")) return entry;
        }
        return null;
    }

    private void verifyNotificationRecoversWhileHidden(MainActivity activity) throws Exception {
        long deadline = System.currentTimeMillis() + 10_000;
        while (playbackNotification() == null && System.currentTimeMillis() < deadline) Thread.sleep(100);
        var notification = playbackNotification();
        assertNotNull("Playing media must have a notification", notification);
        assertTrue("Playing notification must be ongoing", (notification.getNotification().flags & android.app.Notification.FLAG_ONGOING_EVENT) != 0);
        instrumentation.getUiAutomation().performGlobalAction(2); // Home
        Thread.sleep(1_000);
        double before = Double.parseDouble(evaluate("audio.currentTime"));
        var plugin = activity.getBridge().getPlugin("MediaSession").getInstance();
        var serviceField = plugin.getClass().getDeclaredField("service");
        serviceField.setAccessible(true);
        android.app.Service service = (android.app.Service) serviceField.get(plugin);
        assertNotNull(service);
        var sessionField = service.getClass().getDeclaredField("mediaSession");
        sessionField.setAccessible(true);
        Object session = sessionField.get(service);
        var setActive = session.getClass().getMethod("setActive", boolean.class);
        // Model lost system media controls without changing the playing audio
        // or calling a JS/native sync. Recovery must not depend on reopening.
        instrumentation.runOnMainSync(() -> {
            try { setActive.invoke(session, false); } catch (Exception error) { throw new RuntimeException(error); }
            service.stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE);
        });
        deadline = System.currentTimeMillis() + 12_000;
        while (System.currentTimeMillis() < deadline) {
            if (playbackNotification() != null && Boolean.TRUE.equals(session.getClass().getMethod("isActive").invoke(session))) break;
            Thread.sleep(100);
        }
        assertNotNull("Native service must restore missing controls without reopening TMS", playbackNotification());
        assertEquals(true, session.getClass().getMethod("isActive").invoke(session));
        assertFalse("Notification recovery must keep the app hidden", activity.hasWindowFocus());
        assertTrue("Audio must keep advancing during recovery", Double.parseDouble(evaluate("audio.currentTime")) > before + 0.5);
    }

    private String tone() {
        int samples = 8_000 * 60;
        ByteBuffer wav = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes()).putInt(36 + samples * 2).put("WAVEfmt ".getBytes()).putInt(16);
        wav.putShort((short) 1).putShort((short) 1).putInt(8_000).putInt(16_000).putShort((short) 2).putShort((short) 16);
        wav.put("data".getBytes()).putInt(samples * 2);
        for (int i = 0; i < samples; i++) wav.putShort((short) (Math.sin(i * 2 * Math.PI * 220 / 8_000) * 300));
        return "data:audio/wav;base64," + Base64.encodeToString(wav.array(), Base64.NO_WRAP);
    }

    @Test public void notificationPlayWakesPausedHiddenPlayerRepeatedly() throws Exception {
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        webView = activity.getBridge().getWebView();
        try {
            // Use a local test document and tone, with no account or server.
            String html;
            try (var injected = activity.getBridge().getLocalServer().getJavaScriptInjectedStream(
                new java.io.ByteArrayInputStream("<html><head><title>TMS notification test</title></head><body>Notification resume regression test</body></html>".getBytes(java.nio.charset.StandardCharsets.UTF_8)))) {
                html = new String(injected.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            }
            instrumentation.runOnMainSync(() -> {
                webView.stopLoading();
                webView.setWebViewClient(new com.getcapacitor.BridgeWebViewClient(activity.getBridge()));
                String origin = activity.getBridge().getServerUrl();
                if (origin == null) origin = activity.getBridge().getLocalUrl();
                webView.loadDataWithBaseURL(origin, html, "text/html", "UTF-8", null);
            });
            await("document.title === 'TMS notification test' && !!window.Capacitor?.nativeCallback");
            evaluate("window.audio=new Audio('" + tone() + "'); window.audio.loop=true;"
                + "window.setState=(s)=>Capacitor.nativePromise('MediaSession','setPlaybackState',{playbackState:s});"
                + "audio.onplay=()=>setState('playing'); audio.onpause=()=>setState('paused');"
                + "Capacitor.nativeCallback('MediaSession','setActionHandler',{action:'play'},()=>audio.play().catch(e=>window.testError=String(e)));"
                + "Capacitor.nativeCallback('MediaSession','setActionHandler',{action:'pause'},()=>audio.pause());"
                + "Capacitor.nativePromise('MediaSession','setMetadata',{title:'TMS resume test'});"
                + "audio.play().catch(e=>window.testError=String(e)); true");
            await("audio.currentTime > 0.2 && !audio.paused");
            verifyNotificationRecoversWhileHidden(activity);
            for (int attempt = 0; attempt < 2; attempt++) {
                dispatch("pause");
                await("audio.paused");
                instrumentation.getUiAutomation().performGlobalAction(2); // Home
                Thread.sleep(15_000);
                assertEquals("Paused hidden player should be allowed to idle", "\"hidden\"", evaluate("document.visibilityState"));
                // Model a suspended WebView after a longer idle period.
                instrumentation.runOnMainSync(webView::onPause);
                pressNotificationPlay();
                await("!audio.paused");
                assertEquals("Notification Play must wake the hidden playback host", "\"visible\"", evaluate("document.visibilityState"));
                double before = Double.parseDouble(evaluate("audio.currentTime"));
                Thread.sleep(1_500);
                assertTrue("Background media must advance", Double.parseDouble(evaluate("audio.currentTime")) > before + 0.5);
                assertFalse("Play must not reopen the activity", activity.hasWindowFocus());
            }
        } finally {
            evaluate("window.audio?.pause(); if(window.setState) setState('none'); true");
            instrumentation.runOnMainSync(activity::finishAndRemoveTask);
        }
    }
}
