package ca.sekhrit.tms;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import com.getcapacitor.CapacitorWebView;
import com.capgo.mediasession.MediaSessionPlugin.MediaPlaybackHost;

/**
 * Chromium pauses video and throttles the page as soon as the WebView's window
 * is hidden (screen lock, switching apps, PiP task moved back). While TMS media
 * is playing, keep reporting the window as visible so playback and the
 * video-to-audio handoff keep running.
 */
public class TmsWebView extends CapacitorWebView implements MediaPlaybackHost {
    private boolean sessionPlaying;
    private boolean mediaActionPending;
    private final Runnable finishMediaAction = () -> {
        mediaActionPending = false;
        syncWindowVisibility();
    };

    public TmsWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        if (visibility != View.VISIBLE && (sessionPlaying || mediaActionPending || MainActivity.isMediaPlaying())) {
            super.onWindowVisibilityChanged(View.VISIBLE);
            return;
        }
        super.onWindowVisibilityChanged(visibility);
    }

    /** Re-evaluate the window visibility after playback state changes. */
    void syncWindowVisibility() {
        onWindowVisibilityChanged(getWindowVisibility());
    }

    @Override
    public void onMediaSessionAction() {
        // Notification/headset actions do not resume the activity. Give JS a
        // bounded opportunity to handle the command without opening the UI.
        mediaActionPending = true;
        removeCallbacks(finishMediaAction);
        onResume();
        syncWindowVisibility();
        postDelayed(finishMediaAction, 10_000);
    }

    @Override
    public void onMediaSessionPlaybackStateChanged(boolean playing) {
        // Include MiniAudioPlayer, which does not publish PiP playback state.
        sessionPlaying = playing;
        if (playing) {
            mediaActionPending = false;
            removeCallbacks(finishMediaAction);
            onResume();
        }
        syncWindowVisibility();
    }

    @Override
    protected void onDetachedFromWindow() {
        removeCallbacks(finishMediaAction);
        mediaActionPending = false;
        sessionPlaying = false;
        super.onDetachedFromWindow();
    }
}
