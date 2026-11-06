package ca.sekhrit.tms;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "TmsPip")
public class TmsPipPlugin extends Plugin {
    private static TmsPipPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void setState(PluginCall call) {
        ((MainActivity) getActivity()).setPipState(
            call.getBoolean("active", false),
            call.getInt("width", 16),
            call.getInt("height", 9),
            call.getBoolean("playing", false),
            call.getBoolean("hasNext", false)
        );
        call.resolve();
    }

    @PluginMethod
    public void enter(PluginCall call) {
        JSObject result = new JSObject();
        result.put("entered", ((MainActivity) getActivity()).enterTmsPip());
        result.put("requiresSettings", ((MainActivity) getActivity()).wasPipSettingsRequested());
        call.resolve(result);
    }

    @PluginMethod
    public void exit(PluginCall call) {
        ((MainActivity) getActivity()).exitTmsPip();
        call.resolve();
    }

    static void emitAction(String action) {
        if (instance == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        instance.notifyListeners("action", data, true);
    }

    static void emitState(boolean inPip) {
        if (instance == null) return;
        JSObject data = new JSObject();
        data.put("inPip", inPip);
        instance.notifyListeners("state", data, true);
    }
}
