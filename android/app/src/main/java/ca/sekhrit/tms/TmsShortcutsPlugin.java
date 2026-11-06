package ca.sekhrit.tms;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "TmsShortcuts")
public class TmsShortcutsPlugin extends Plugin {
    @PluginMethod
    public void add(PluginCall call) {
        String target = call.getString("url", "");
        String label = call.getString("label", "TMS");
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !isSafeTarget(target)) {
            result.put("requested", false);
            call.resolve(result);
            return;
        }

        Intent creator = new Intent(getActivity(), ShortcutCreatorActivity.class)
            .putExtra(ShortcutCreatorActivity.EXTRA_TARGET, target)
            .putExtra(ShortcutCreatorActivity.EXTRA_LABEL, label);
        getActivity().startActivity(creator);
        result.put("requested", true);
        call.resolve(result);
    }

    private boolean isSafeTarget(String target) {
        return target.startsWith("/") && !target.startsWith("//");
    }
}
