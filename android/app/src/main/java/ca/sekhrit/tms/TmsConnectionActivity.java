package ca.sekhrit.tms;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import com.getcapacitor.CapConfig;
import java.io.File;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Choose a reachable server before creating the WebView. No network work on the UI thread. */
public class TmsConnectionActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private static File routeDirectory(Context context) {
        return new File(context.getFilesDir(), "server-route");
    }

    static CapConfig selectedConfig(Context context) {
        File directory = routeDirectory(context);
        return new File(directory, "capacitor.config.json").isFile()
            ? CapConfig.loadFromFile(context, directory.getAbsolutePath())
            : CapConfig.loadDefault(context);
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout content = new FrameLayout(this);
        content.setBackgroundColor(Color.rgb(13, 17, 21));
        FrameLayout.LayoutParams indicator = new FrameLayout.LayoutParams(64, 64, Gravity.CENTER);
        content.addView(new ProgressBar(this), indicator);
        setContentView(content);
        worker.execute(() -> {
            selectServer();
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                startActivity(new Intent(this, MainActivity.class));
                finish();
            });
        });
    }

    private void selectServer() {
        try {
            JSONObject config;
            try (var input = getAssets().open("capacitor.config.json")) {
                config = new JSONObject(readText(input));
            }
            JSONObject server = config.optJSONObject("server");
            if (server == null) { server = new JSONObject(); config.put("server", server); }
            String configured = server.optString("url", "");
            JSONObject plugins = config.optJSONObject("plugins");
            JSONObject connection = plugins == null ? null : plugins.optJSONObject("TmsConnection");
            String local = connection == null ? "" : connection.optString("localUrl", "");
            String tailscale = connection == null ? "" : connection.optString("tailscaleUrl", "");
            LinkedHashSet<String> candidates = new LinkedHashSet<>();
            if (!local.isEmpty()) candidates.add(emulatorAddress(local));
            if (!tailscale.isEmpty()) candidates.add(tailscale);
            if (!configured.isEmpty()) candidates.add(configured);
            String selected = null;
            for (String candidate : candidates) {
                boolean reachable = reachable(candidate);
                String label = candidate.equals(tailscale) ? "tailscale" : candidate.equals(configured) ? "configured" : "direct";
                Log.i("TmsConnection", "Route " + label
                    + " " + (reachable ? "reachable" : "unavailable"));
                if (reachable) { selected = candidate; break; }
            }
            if (selected != null) {
                server.put("url", selected);
                server.put("cleartext", selected.startsWith("http://"));
            } else {
                // Both routes failed: retain the established offline shell behavior.
                Log.i("TmsConnection", "No reachable route; using offline fallback");
            }
            File directory = routeDirectory(this);
            if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("Route directory unavailable");
            try (FileOutputStream output = new FileOutputStream(new File(directory, "capacitor.config.json"))) {
                output.write(config.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception error) {
            Log.w("TmsConnection", "Could not select server route", error);
            // An old build's selected route must not override the current APK.
            new File(routeDirectory(this), "capacitor.config.json").delete();
        }
    }

    private String emulatorAddress(String local) {
        if (!(Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish"))) return local;
        ConnectivityManager connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        LinkProperties properties = connectivity.getLinkProperties(connectivity.getActiveNetwork());
        if (properties != null) {
            for (var route : properties.getRoutes()) {
                if (route.isDefaultRoute() && route.getGateway() instanceof Inet4Address) {
                    Uri uri = Uri.parse(local);
                    String authority = route.getGateway().getHostAddress() + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
                    return uri.buildUpon().encodedAuthority(authority).build().toString();
                }
            }
        }
        return local;
    }

    static boolean reachable(String origin) {
        HttpURLConnection request = null;
        try {
            request = (HttpURLConnection) new URL(origin + "/api/health").openConnection();
            request.setConnectTimeout(1500);
            request.setReadTimeout(1500);
            request.setInstanceFollowRedirects(false);
            int status = request.getResponseCode();
            if (status != 200) {
                Log.i("TmsConnection", "Health check returned HTTP " + status);
                return false;
            }
            try (var input = request.getInputStream()) {
                JSONObject health = new JSONObject(readText(input));
                return "ok".equals(health.optString("status")) && health.has("library_available");
            }
        } catch (Exception unavailable) {
            Log.i("TmsConnection", "Health check failed: " + unavailable.getClass().getSimpleName());
            return false;
        } finally {
            if (request != null) request.disconnect();
        }
    }

    private static String readText(InputStream input) throws java.io.IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) {
            output.write(buffer, 0, count);
            if (output.size() > 65_536) throw new java.io.IOException("Response too large");
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    @Override
    protected void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }
}
