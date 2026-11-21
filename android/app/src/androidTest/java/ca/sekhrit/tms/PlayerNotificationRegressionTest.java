package ca.sekhrit.tms;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.app.NotificationManager;
import android.content.Intent;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** Runs the compiled TMS player against the local synthetic HTTP fixture. */
public class PlayerNotificationRegressionTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private WebView view;
    private String evaluate(String expression) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        assertTrue("WebView evaluation did not complete",done.await(2, TimeUnit.SECONDS)); return result.get();
    }
    private void await(String expression) throws Exception {
        long end = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < end) { try { if ("true".equals(evaluate(expression))) return; } catch (AssertionError transientNavigation) { if (System.currentTimeMillis()>=end) throw transientNavigation; } Thread.sleep(100); }
        fail("Player state not reached: " + expression);
    }
    private double awaitAudioPosition(double minimum) throws Exception {
        // Capture the position in the same evaluation that checks playback.
        // PiP dismissal can replace the background audio during the handoff.
        long deadline = android.os.SystemClock.elapsedRealtime() + 10_000;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            String sample = evaluate("(()=>{const audio=document.querySelector('body > audio');"
                + "return audio && !audio.paused && !audio.error && audio.currentTime > " + minimum
                + " ? audio.currentTime : null})()");
            if (sample != null && !sample.equals("null")) return Double.parseDouble(sample);
            Thread.sleep(100);
        }
        throw new AssertionError("Background audio did not advance beyond " + minimum + " seconds");
    }
    private void notificationAction(String title) throws Exception {
        NotificationManager manager = instrumentation.getTargetContext().getSystemService(NotificationManager.class);
        long end = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < end) {
            for (var entry : manager.getActiveNotifications()) {
                if (!entry.getNotification().extras.getString(android.app.Notification.EXTRA_TITLE, "").contains("Afterglow")) continue;
                if (entry.getNotification().actions == null) continue;
                for (var action : entry.getNotification().actions) if (title.contentEquals(action.title)) { action.actionIntent.send(); return; }
            }
            Thread.sleep(100);
        }
        fail("Selected TMS track has no notification action " + title);
    }
    @Test public void actualPlayerNotificationResumesHiddenPausedTrackTwice() throws Exception {
        assertEquals("This fixture test must never navigate the real app", "ca.sekhrit.tms.regression", instrumentation.getTargetContext().getPackageName());
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        view = activity.getBridge().getWebView();
        try {
            instrumentation.runOnMainSync(() -> view.loadUrl("http://127.0.0.1:3100/demo"));
            await("!!document.querySelector('a.card-label-link')");
            instrumentation.runOnMainSync(() -> view.loadUrl("http://127.0.0.1:3100/?folder=Music"));
            await("!!document.querySelector('a.card-label-link[href*=\"Afterglow.mp3\"]')");
            evaluate("document.querySelector('a.card-label-link[href*=\"Afterglow.mp3\"]').click();true");
            await("!!document.querySelector('.miniplayer audio') && document.querySelector('.miniplayer audio').currentTime>.2");
            for (int attempt=0;attempt<2;attempt++) {
                notificationAction("Pause");
                await("document.querySelector('.miniplayer audio').paused");
                instrumentation.getUiAutomation().performGlobalAction(2);
                Thread.sleep(2_000);
                double before = Double.parseDouble(evaluate("document.querySelector('.miniplayer audio').currentTime"));
                notificationAction("Play");
                await("!document.querySelector('.miniplayer audio').paused && document.querySelector('.miniplayer audio').currentTime>"+(before+.15));
                assertFalse("Notification transport must not bring the player to the foreground",activity.hasWindowFocus());
            }
        } finally {
            evaluate("document.querySelectorAll('audio').forEach(a=>a.pause());true");
            instrumentation.runOnMainSync(activity::finishAndRemoveTask);
        }
    }
    @Test public void actualPipAudioActionClosesPromptlyAndKeepsPlaybackPosition() throws Exception {
        assertEquals("ca.sekhrit.tms.regression",instrumentation.getTargetContext().getPackageName());
        MainActivity activity=(MainActivity)instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        view=activity.getBridge().getWebView();
        try {
            instrumentation.runOnMainSync(()->view.loadUrl("http://127.0.0.1:3100/demo"));
            await("!!document.querySelector('a.card-label-link')");
            instrumentation.runOnMainSync(()->view.loadUrl("http://127.0.0.1:3100/?folder=Movies%20and%20Shows%2FOrbital%20Drift%2FSeason%201"));
            await("!!document.querySelector('a.card-label-link[href*=\"S01E01\"]')");
            evaluate("document.querySelector('a.card-label-link[href*=\"S01E01\"]').click();true");
            String active="[...document.querySelector('.watch-video-engine > div').shadowRoot.querySelectorAll('video')].find(v=>!v.paused)";
            await("!!document.querySelector('.watch-video-engine > div')?.shadowRoot && !!("+active+") && ("+active+").currentTime>.2");
            double before=Double.parseDouble(evaluate("("+active+").currentTime"));
            evaluate("document.querySelector('button[aria-label=\"Picture-in-picture\"]').click();true");
            AtomicReference<Boolean> inPip=new AtomicReference<>(false);
            long deadline=android.os.SystemClock.elapsedRealtime()+5_000;
            while(android.os.SystemClock.elapsedRealtime()<deadline&&!inPip.get()){instrumentation.runOnMainSync(()->inPip.set(activity.isInPictureInPictureMode()));Thread.sleep(50);}
            assertTrue("Real player must enter PiP",inPip.get());
            AtomicReference<android.app.PendingIntent> action=new AtomicReference<>();
            instrumentation.runOnMainSync(()->{try{var method=MainActivity.class.getDeclaredMethod("buildPipParams");method.setAccessible(true);action.set(((android.app.PictureInPictureParams)method.invoke(activity)).getActions().get(0).getActionIntent());}catch(Exception error){throw new RuntimeException(error);}});
            long started=android.os.SystemClock.elapsedRealtime();action.get().send();
            while(android.os.SystemClock.elapsedRealtime()-started<750&&inPip.get()){instrumentation.runOnMainSync(()->inPip.set(activity.isInPictureInPictureMode()));Thread.sleep(25);}
            long elapsed=android.os.SystemClock.elapsedRealtime()-started;
            if(inPip.get()) {
                var shot=instrumentation.getUiAutomation().takeScreenshot();
                try(var output=new java.io.FileOutputStream(new java.io.File(instrumentation.getTargetContext().getCacheDir(),"regression-pip-state.png"))){shot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,output);}
            }
            assertFalse("Switch to audio must close PiP in 750 ms",inPip.get());
            android.util.Log.i("TmsRegression","actual_pip_audio_close_ms="+elapsed);
            android.os.Bundle metric=new android.os.Bundle();metric.putLong("pip_audio_close_ms",elapsed);instrumentation.sendStatus(2,metric);
            double position = awaitAudioPosition(Math.max(.2, before - .5));
            awaitAudioPosition(position + .15);
            assertFalse("Audio-only PiP dismissal must leave the activity hidden",activity.hasWindowFocus());
        } finally {evaluate("document.querySelectorAll('audio').forEach(a=>a.pause());true");instrumentation.runOnMainSync(activity::finishAndRemoveTask);}
    }
}
