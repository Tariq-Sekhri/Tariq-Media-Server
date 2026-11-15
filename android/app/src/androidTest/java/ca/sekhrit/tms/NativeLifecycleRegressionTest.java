package ca.sekhrit.tms;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.app.PictureInPictureParams;
import android.os.Build;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.lifecycle.Lifecycle;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Assume;
import org.junit.Test;

/** Native integration with a synthetic local document, not a full TMS player E2E test. */
public class NativeLifecycleRegressionTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();

    private String evaluate(WebView view, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(script, value -> {
            result.set(value);
            done.countDown();
        }));
        assertTrue("JavaScript callback timed out", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    private void await(WebView view, String expression) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if ("true".equals(evaluate(view, expression))) return;
            Thread.sleep(50);
        }
        fail("Timed out waiting for synthetic document state: " + expression);
    }

    @Test public void repeatedPipControlBroadcastsReachBridgePromptly() throws Exception {
        Assume.assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> viewRef = new AtomicReference<>();
            scenario.onActivity(activity -> {
                WebView view = activity.getBridge().getWebView();
                viewRef.set(view);
                try {
                    byte[] document = "<html><head><title>Native integration</title></head><body></body></html>".getBytes(StandardCharsets.UTF_8);
                    String html;
                    try (var stream = activity.getBridge().getLocalServer().getJavaScriptInjectedStream(new ByteArrayInputStream(document))) {
                        html = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
                    }
                    view.stopLoading();
                    String origin = activity.getBridge().getServerUrl();
                    if (origin == null) origin = activity.getBridge().getLocalUrl();
                    view.loadDataWithBaseURL(origin, html, "text/html", "UTF-8", null);
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            WebView view = viewRef.get();
            await(view, "document.title === 'Native integration' && !!window.Capacitor?.nativeCallback");
            // The following native promise is ordered after listener registration on the bridge.
            evaluate(view, "window.pipEvents=[]; window.listenerReady=false; Capacitor.nativeCallback('TmsPip','addListener',{eventName:'action'},e=>{if(e && e.action === 'play-pause') pipEvents.push(e.action);}); Capacitor.nativePromise('TmsPip','setState',{active:false}).then(()=>window.listenerReady=true); true");
            await(view, "window.listenerReady === true");
            AtomicReference<PictureInPictureParams> params = new AtomicReference<>();
            scenario.onActivity(activity -> {
                try {
                    var method = MainActivity.class.getDeclaredMethod("buildPipParams");
                    method.setAccessible(true);
                    params.set((PictureInPictureParams) method.invoke(activity));
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            var control = params.get().getActions().get(1).getActionIntent();
            for (int count = 1; count <= 3; count++) {
                long start = SystemClock.elapsedRealtime();
                control.send();
                await(view, "window.pipEvents.length >= " + count);
                long elapsed = SystemClock.elapsedRealtime() - start;
                android.util.Log.i("TmsRegression", "pip_control_delivery_ms=" + elapsed);
                assertTrue("PiP control delivery exceeded 750 ms", elapsed < 750);
                assertEquals("Each control must reach the bridge exactly once", Integer.toString(count), evaluate(view, "pipEvents.length"));
                assertEquals("Control action must be preserved", "\"play-pause\"", evaluate(view, "pipEvents[pipEvents.length-1]"));
            }
        }
    }

    @Test public void noVideoCannotEnterPipAndResumeHidesSystemBars() throws Exception {
        Assume.assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                activity.setPipState(false, 16, 9, false, false);
                assertFalse("A page without video must not enter PiP", activity.enterTmsPip());
                assertFalse(activity.isInPictureInPictureMode());
                assertFalse("No video must not trigger PiP settings", activity.wasPipSettingsRequested());
            });
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.moveToState(Lifecycle.State.RESUMED);
            long deadline = SystemClock.elapsedRealtime() + 5_000;
            AtomicReference<Boolean> hidden = new AtomicReference<>(false);
            while (SystemClock.elapsedRealtime() < deadline && !hidden.get()) {
                scenario.onActivity(activity -> {
                    WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(activity.getWindow().getDecorView());
                    hidden.set(insets != null && !insets.isVisible(WindowInsetsCompat.Type.systemBars()));
                });
                if (!hidden.get()) Thread.sleep(100);
            }
            assertTrue("System bars must hide again after activity resume", hidden.get());
        }
    }
}

