package uk.scanaki.kitchen;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Credential-encrypted storage becomes available after the first device unlock. */
public final class PrinterBootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            PrinterService.startIfEnabled(context);
        }
    }
}
