package ca.sekhrit.tms;

import android.graphics.Bitmap;
import android.os.Build;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Keep the existing origin/session when the server cannot supply a document. */
public class TmsWebViewClient extends BridgeWebViewClient {
    private final Bridge tmsBridge;

    public TmsWebViewClient(Bridge bridge) {
        super(bridge);
        tmsBridge = bridge;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        MainActivity.clearPipForNavigation();
        super.onPageStarted(view, url, favicon);
    }

    /**
     * Android kills the whole app when a WebView renderer dies unhandled.
     * Rebuild the activity instead, and keep the reason so it reaches the logs.
     */
    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail.didCrash();
        android.util.Log.e("TmsWebView", "Renderer gone, crashed=" + crashed);
        return MainActivity.recoverFromRendererLoss(view, crashed ? "crash" : "killed");
    }

    private WebResourceResponse shell() throws Exception {
        InputStream html = tmsBridge.getContext().getAssets().open("public/index.html");
        return new WebResourceResponse("text/html", "UTF-8",
            tmsBridge.getLocalServer().getJavaScriptInjectedStream(html));
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String path = request.getUrl().getPath();
        String server = tmsBridge.getServerUrl();
        boolean appOrigin = server != null && android.net.Uri.parse(server).getAuthority().equals(request.getUrl().getAuthority());
        boolean localOrigin = request.getUrl().getHost().equals(tmsBridge.getHost());
        if (!appOrigin && !localOrigin) return super.shouldInterceptRequest(view, request);
        try {
            if (path.startsWith("/app-shell-assets/")) {
                String mime = path.endsWith(".css") ? "text/css" : "application/javascript";
                return new WebResourceResponse(mime, "UTF-8", tmsBridge.getContext().getAssets().open("public" + path));
            }
            if (request.isForMainFrame() && request.getMethod().equals("GET")) {
                if (localOrigin || path.equals("/index.html") || path.equals("/offline.html")) return shell();
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL(request.getUrl().toString()).openConnection();
                    connection.setConnectTimeout(4000);
                    connection.setReadTimeout(4000);
                    for (var header : request.getRequestHeaders().entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
                    int status = connection.getResponseCode();
                    if (status >= 500) { connection.disconnect(); return shell(); }
                    if (status >= 400) { connection.disconnect(); return super.shouldInterceptRequest(view, request); }
                    return new WebResourceResponse("text/html", "UTF-8",
                        tmsBridge.getLocalServer().getJavaScriptInjectedStream(connection.getInputStream()));
                } catch (Exception unavailable) {
                    if (connection != null) connection.disconnect();
                    return shell();
                }
            }
        } catch (Exception unavailableAsset) {
            android.util.Log.e("TmsOffline", "Could not load bundled React app", unavailableAsset);
        }
        return super.shouldInterceptRequest(view, request);
    }
}
