package ca.sekhrit.tms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class PipActionReceiver extends BroadcastReceiver {
    public static final String ACTION_CONTROL = "ca.sekhrit.tms.PIP_CONTROL";
    public static final String EXTRA_CONTROL = "control";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_CONTROL.equals(intent.getAction())) return;
        MainActivity.dispatchPipAction(intent.getStringExtra(EXTRA_CONTROL));
    }
}
