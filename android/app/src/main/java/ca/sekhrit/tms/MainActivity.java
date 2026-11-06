package ca.sekhrit.tms;

import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.app.AppOpsManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.view.WindowCompat;
import androidx.core.view.ViewCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    public static final String EXTRA_SHORTCUT_TARGET = "ca.sekhrit.tms.shortcut_target";
    private static final long RENDERER_LOSS_RETRY_MS = 30_000;
    private static MainActivity activeInstance;
    private static long lastRendererLossAt = -RENDERER_LOSS_RETRY_MS;
    private float pullStartY;
    private boolean pullStartedAtTop;
    private boolean pullStartedNearTop;
    private boolean pipEligible;
    private volatile boolean pipPlaying;
    private boolean pipHasNext;
    private int pipWidth = 16;
    private int pipHeight = 9;
    private boolean pipSettingsRequested;
    private boolean rendererRecoveryStarted;
    private final Runnable rehideSystemBars = this::applyStickyImmersiveMode;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before BridgeActivity creates the web bridge.
        // Registering in load() lets a packaged cold-start page initialise
        // without them, leaving Offline reported as "not implemented".
        registerPlugin(TmsPipPlugin.class);
        registerPlugin(TmsOfflinePlugin.class);
        registerPlugin(TmsShortcutsPlugin.class);
        // TMS is a dark app; native pickers and confirm dialogs follow it.
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES);
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        getBridge().getWebView().setWebViewClient(new TmsWebViewClient(getBridge()));
        // The display cutout band and the WebView's first frame show the
        // window background; keep both on the app's dark surface.
        int appBackground = Color.parseColor("#0d1115");
        getWindow().getDecorView().setBackgroundColor(appBackground);
        getBridge().getWebView().setBackgroundColor(appBackground);
        for (android.view.ViewParent parent = getBridge().getWebView().getParent(); parent instanceof View; parent = parent.getParent()) {
            ((View) parent).setBackgroundColor(appBackground);
        }
        activeInstance = this;
        scheduleStickyImmersiveMode();
        enablePullToRefresh();
        openShortcutTarget(getIntent());
    }

    @Override
    protected void load() {
        // Capacitor rebuilds its JS plugin map while creating a new bridge
        // after a document-picker return. Register here as well as onCreate
        // so a resumed/cold Offline page always sees the native APIs.
        registerPlugin(TmsPipPlugin.class);
        registerPlugin(TmsOfflinePlugin.class);
        registerPlugin(TmsShortcutsPlugin.class);
        config = TmsConnectionActivity.selectedConfig(this);
        super.load();
    }

    @Override
    public void onDestroy() {
        if (activeInstance == this) activeInstance = null;
        super.onDestroy();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openShortcutTarget(intent);
    }

    private void openShortcutTarget(Intent intent) {
        String target = intent == null ? null : intent.getStringExtra(EXTRA_SHORTCUT_TARGET);
        if (target == null || !target.startsWith("/") || target.startsWith("//")) return;
        WebView webView = getBridge().getWebView();
        webView.post(() -> {
            String serverUrl = getBridge().getServerUrl();
            if (serverUrl == null) serverUrl = getBridge().getLocalUrl();
            Uri base = Uri.parse(serverUrl);
            Uri relative = Uri.parse(target);
            Uri destination = base.buildUpon()
                .encodedPath(relative.getEncodedPath())
                .encodedQuery(relative.getEncodedQuery())
                .build();
            webView.loadUrl(destination.toString());
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        TmsPipPlugin.emitAction("foreground");
        scheduleStickyImmersiveMode();
        if (pipSettingsRequested) {
            pipSettingsRequested = false;
            if (pipEligible && pipAllowed()) enterPictureInPictureMode(buildPipParams());
        }
    }

    @Override
    public void onStop() {
        // Screen lock does not send onUserLeaveHint. Start the same audio
        // handoff for every fully hidden activity, while leaving PiP alone.
        if (!isFinishing() && !(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode())) {
            TmsPipPlugin.emitAction("background");
        }
        super.onStop();
    }

    @Override
    public void onPostResume() {
        super.onPostResume();
        // WebView/video transitions can restore Android's bars after onResume.
        scheduleStickyImmersiveMode();
    }

    @Override
    public void onUserLeaveHint() {
        // Android 12+ uses auto-enter. This keeps swipe/home PiP working on
        // Android 8-11 as well.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S && pipEligible) {
            enterPictureInPictureMode(buildPipParams());
        }
        super.onUserLeaveHint();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode);
        TmsPipPlugin.emitState(isInPictureInPictureMode);
        if (!isInPictureInPictureMode) scheduleStickyImmersiveMode();
    }

    public void setPipState(boolean active, int width, int height, boolean playing, boolean hasNext) {
        pipEligible = active;
        boolean wasPlaying = pipPlaying;
        pipPlaying = playing;
        if (wasPlaying && !playing) {
            // Playback stopped; let a hidden WebView report its real visibility again.
            WebView webView = getBridge().getWebView();
            if (webView instanceof TmsWebView) webView.post(((TmsWebView) webView)::syncWindowVisibility);
        }
        pipHasNext = hasNext;
        pipWidth = Math.max(1, width);
        pipHeight = Math.max(1, height);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) setPictureInPictureParams(buildPipParams());
    }

    /** True while the web player reports video or audio playback. */
    public static boolean isMediaPlaying() {
        return activeInstance != null && activeInstance.pipPlaying;
    }

    /** A new document has no player, so it cannot be eligible for PiP. */
    public static void clearPipForNavigation() {
        if (activeInstance != null) activeInstance.setPipState(false, activeInstance.pipWidth, activeInstance.pipHeight, false, false);
    }

    /**
     * Rebuilds the activity, and so its WebView, after the renderer dies.
     * Returns false when there is no activity to rebuild.
     */
    public static boolean recoverFromRendererLoss(WebView view, String reason) {
        MainActivity activity = activeInstance;
        if (activity == null) return false;
        // Android can also notify an already replaced WebView for the same death.
        if (activity.rendererRecoveryStarted || view != activity.getBridge().getWebView()) return true;
        activity.rendererRecoveryStarted = true;
        String url = view.getUrl();
        long now = android.os.SystemClock.elapsedRealtime();
        // A page that keeps killing the renderer must not be reopened forever.
        boolean repeated = now - lastRendererLossAt < RENDERER_LOSS_RETRY_MS;
        lastRendererLossAt = now;
        Uri page = url == null ? null : Uri.parse(url);
        Intent intent = new Intent(activity, MainActivity.class);
        if (!repeated && page != null && page.getEncodedPath() != null && page.getEncodedPath().startsWith("/")) {
            Uri target = Uri.parse(page.getEncodedPath() + (page.getEncodedQuery() == null ? "" : "?" + page.getEncodedQuery()))
                .buildUpon().appendQueryParameter("rendererGone", reason).build();
            intent.putExtra(EXTRA_SHORTCUT_TARGET, target.toString());
        }
        activity.setIntent(intent);
        activity.recreate();
        return true;
    }

    public boolean enterTmsPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !pipEligible || isInPictureInPictureMode()) return false;
        if (!pipAllowed()) {
            pipSettingsRequested = true;
            // The platform exposes this special-access screen, but keeps its
            // action constant hidden from third-party SDK stubs.
            startActivity(new Intent("android.settings.PICTURE_IN_PICTURE_SETTINGS", Uri.parse("package:" + getPackageName())));
            return false;
        }
        return enterPictureInPictureMode(buildPipParams());
    }

    public boolean wasPipSettingsRequested() {
        return pipSettingsRequested;
    }

    public void exitTmsPip() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode()) moveTaskToBack(false);
    }

    public static void dispatchPipAction(String action) {
        if (activeInstance != null) activeInstance.handlePipAction(action);
    }

    private void handlePipAction(String action) {
        if (action == null) return;
        TmsPipPlugin.emitAction(action);
        if ("audio-only".equals(action)) {
            // Dismiss PiP immediately. TmsWebView keeps the video playing while
            // hidden, so JavaScript can finish the audio handoff in the background.
            pipEligible = false;
            exitTmsPip();
        } else if ("close".equals(action)) {
            pipEligible = false;
            finishAndRemoveTask();
        }
    }

    private PictureInPictureParams buildPipParams() {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
            .setAspectRatio(new Rational(pipWidth, pipHeight))
            .setActions(java.util.Arrays.asList(
                pipAction("audio-only", "Switch to audio", R.drawable.ic_pip_headphones),
                pipAction("play-pause", pipPlaying ? "Pause" : "Play", pipPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play),
                pipAction("next", "Next", android.R.drawable.ic_media_next),
                pipAction("close", "Stop playback", android.R.drawable.ic_menu_close_clear_cancel)
            ));
        View content = findViewById(android.R.id.content);
        if (content != null) builder.setSourceRectHint(new android.graphics.Rect(0, 0, content.getWidth(), content.getHeight()));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(pipEligible);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) builder.setCloseAction(pipAction("close", "Stop playback", android.R.drawable.ic_menu_close_clear_cancel));
        return builder.build();
    }

    private boolean pipAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        AppOpsManager appOps = getSystemService(AppOpsManager.class);
        if (appOps == null) return true;
        int mode = appOps.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, android.os.Process.myUid(), getPackageName());
        return mode == AppOpsManager.MODE_ALLOWED || mode == AppOpsManager.MODE_DEFAULT;
    }

    private RemoteAction pipAction(String control, String label, int icon) {
        Intent intent = new Intent(this, PipActionReceiver.class)
            .setAction(PipActionReceiver.ACTION_CONTROL)
            // Without this the tap is queued as a background broadcast and
            // can take seconds to reach the player.
            .addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
            .putExtra(PipActionReceiver.EXTRA_CONTROL, control);
        PendingIntent pendingIntent = PendingIntent.getBroadcast(this, control.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new RemoteAction(Icon.createWithResource(this, icon), label, label, pendingIntent);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            scheduleStickyImmersiveMode();
        }
    }

    private void scheduleStickyImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode()) return;
        View decorView = getWindow().getDecorView();
        decorView.removeCallbacks(rehideSystemBars);
        // Allow the active WebView/video transition to finish before hiding the
        // bars it may have restored. The transient swipe reveal remains enabled.
        decorView.postDelayed(rehideSystemBars, 250);
    }

    private void applyStickyImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode()) return;
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // Capacitor's compatibility inset handler pads older WebViews below
        // the cutout. Keep the viewport edge-to-edge and expose the safe inset
        // to the app header instead, while retaining keyboard avoidance.
        WebView webView = getBridge().getWebView();
        View webParent = (View) webView.getParent();
        ViewCompat.setOnApplyWindowInsetsListener(webParent, (view, insets) -> {
            int top = insets.getInsets(WindowInsetsCompat.Type.displayCutout()).top;
            int keyboard = insets.isVisible(WindowInsetsCompat.Type.ime())
                ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
            view.setPadding(0, 0, 0, keyboard);
            float safeTop = top / getResources().getDisplayMetrics().density;
            webView.evaluateJavascript("document.documentElement.style.setProperty('--safe-area-inset-top','" + safeTop + "px')", null);
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .build();
        });
        ViewCompat.requestApplyInsets(webParent);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            // TMS is a fullscreen app. Android still exposes transient system
            // bars when the user swipes from an edge.
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
        }
    }

    private void enablePullToRefresh() {
        WebView webView = getBridge().getWebView();
        final float topRegion = dp(144);
        final float refreshDistance = dp(96);
        webView.setOnTouchListener((view, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    pullStartY = event.getY();
                    pullStartedAtTop = webView.getScrollY() == 0;
                    pullStartedNearTop = pullStartY <= topRegion;
                    break;
                case MotionEvent.ACTION_UP:
                    if (pullStartedAtTop && pullStartedNearTop && event.getY() - pullStartY >= refreshDistance) {
                        webView.reload();
                        return true;
                    }
                    break;
                case MotionEvent.ACTION_CANCEL:
                    pullStartedAtTop = false;
                    pullStartedNearTop = false;
                    break;
                default:
                    break;
            }
            return false;
        });
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
