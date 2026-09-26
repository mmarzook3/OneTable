package uk.scanaki.kitchen;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;

/** Local-only setup UI: never passes the agent credential into WebView JavaScript. */
public final class PrinterSettingsActivity extends Activity {
    private PrinterStore store;
    private EditText host, port, token;
    private TextView status;
    private Button activate, stop;
    private boolean saving;
    private PrinterDiscovery discovery;
    private boolean scanning;
    private int scanGeneration;
    private Button findPrinters;
    private TextView scanStatus;
    private LinearLayout printerResults;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        public void run() {
            status.setText(store.status());
            boolean editable = !PrinterService.isRunning() && !saving;
            host.setEnabled(editable); port.setEnabled(editable); token.setEnabled(editable);
            activate.setEnabled(editable); stop.setEnabled(PrinterService.isRunning() && !saving);
            findPrinters.setEnabled(!saving);
            for (int i = 0; i < printerResults.getChildCount(); i++) printerResults.getChildAt(i).setEnabled(editable);
            handler.postDelayed(this, 2000);
        }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        store = new PrinterStore(this);
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32, 32, 32, 32);
        ScrollView scroll = new ScrollView(this); scroll.addView(layout); setContentView(scroll);
        text(layout, "Permanent venue printer", 24);
        text(layout, "Keep this tablet powered and on the printer Wi-Fi. Start printing only after stopping the old laptop agent. Both kitchen tickets and receipts use this printer.", 16);
        status = text(layout, store.status(), 16);
        host = field(layout, "Printer IPv4 address", InputType.TYPE_CLASS_PHONE);
        port = field(layout, "Printer port", InputType.TYPE_CLASS_NUMBER);
        token = field(layout, "Print-agent token (leave blank to keep saved token)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO);
        token.setSaveEnabled(false);
        host.setText("192.168.55.20"); port.setText("9100");
        try {
            JSONObject config = store.config();
            if (config != null) { host.setText(config.getString("host")); port.setText(Integer.toString(config.getInt("port"))); }
        } catch (Exception error) { store.status("Saved pairing is unavailable. Enter a new print-agent token."); }
        findPrinters = button(layout, "Find network printers", this::findNetworkPrinters);
        scanStatus = text(layout, "Finds compatible port-9100 printer candidates on this local IPv4 segment (up to 254 addresses). No test pages are sent. Stop automatic printing before selecting another printer. Other printer types or network segments may need manual entry.", 16);
        printerResults = new LinearLayout(this);
        printerResults.setOrientation(LinearLayout.VERTICAL);
        layout.addView(printerResults);
        activate = button(layout, "Enable automatic printing", this::activate);
        stop = button(layout, "Stop automatic printing", () -> {
            store.setEnabled(false);
            startService(new Intent(this, PrinterService.class).setAction(PrinterService.STOP));
            store.status("Stopping after the current ticket finishes");
        });
        button(layout, "Battery / background settings", () -> startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)));
        text(layout, "Allow unrestricted battery/background operation and auto-launch in the tablet settings. Printing resumes after reboot and unlock. Android force-stop requires reopening Scanaki. If a ticket outcome is uncertain, check paper before manually reprinting.", 16);
        button(layout, "Back to Scanaki", this::finish);
    }
    private void findNetworkPrinters() {
        if (saving) return;
        if (scanning) { cancelDiscovery(); scanStatus.setText("Search cancelled. You can search again or enter an address manually."); return; }
        final int generation = ++scanGeneration;
        scanning = true;
        findPrinters.setText("Cancel printer search");
        printerResults.removeAllViews();
        scanStatus.setText("Searching local network for port-9100 printers... No print data is sent.");
        discovery = new PrinterDiscovery(this, new PrinterDiscovery.Listener() {
            public void found(String address) {
                if (generation != scanGeneration) return;
                Button result = button(printerResults, "Printer candidate: " + address + ":9100", () -> {
                    if (saving || PrinterService.isRunning()) {
                        scanStatus.setText("Stop automatic printing before changing the printer."); return;
                    }
                    host.setText(address); port.setText("9100");
                    scanStatus.setText("Selected " + address + ":9100. Enable automatic printing to save. An open port does not prove the printer model.");
                });
                result.setEnabled(!saving && !PrinterService.isRunning());
            }
            public void finished(String message) {
                if (generation != scanGeneration) return;
                scanning = false; findPrinters.setText("Find network printers"); scanStatus.setText(message);
            }
        });
    }
    private void cancelDiscovery() {
        ++scanGeneration;
        if (discovery != null) { discovery.close(); discovery = null; }
        scanning = false;
        findPrinters.setText("Find network printers");
    }
    private void activate() {
        if (saving || PrinterService.isRunning()) return;
        String address = host.getText().toString().trim();
        int socketPort;
        try { socketPort = Integer.parseInt(port.getText().toString()); } catch (Exception error) { socketPort = 0; }
        if (!PrinterStore.validHost(address) || socketPort < 1 || socketPort > 65535) {
            store.status("Enter a private LAN IPv4 address and valid port"); refreshStatus(); return;
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 72);
            store.status("Approve notifications, then enable printing again"); refreshStatus(); return;
        }
        final int targetPort = socketPort;
        final String enteredToken = token.getText().toString().trim();
        saving = true; activate.setEnabled(false); store.status("Checking pairing securely...");
        new Thread(() -> {
            try {
              synchronized (PrinterService.WORKER_LOCK) {
                if (PrinterService.isRunning()) throw new IllegalStateException();
                JSONObject old = store.config();
                String credential = enteredToken.isEmpty() && old != null ? old.getString("token") : enteredToken;
                if (!credential.matches("[A-Za-z0-9_-]{32,200}")) throw new IllegalArgumentException();
                JSONObject agent = (JSONObject) PrinterService.request("POST", "/heartbeat", credential, new JSONObject());
                JSONObject config = new JSONObject().put("token", credential).put("host", address).put("port", targetPort)
                    .put("agent_id", agent.getLong("id")).put("tenant_id", agent.getLong("tenant_id"));
                if (old == null || !old.toString().equals(config.toString())) {
                    if (old != null) reconcileOldPairing(old);
                    store.configure(config);
                }
                store.setEnabled(true);
                runOnUiThread(() -> { token.setText(""); PrinterService.startIfEnabled(this); });
              }
            } catch (Exception error) {
                store.status("Pairing failed. Check connection/token; resolve outstanding tickets before changing configuration.");
            } finally { runOnUiThread(() -> { saving = false; refreshStatus(); }); }
        }, "scanaki-printer-pairing").start();
    }
    private void reconcileOldPairing(JSONObject old) throws Exception {
        String credential = old.getString("token");
        org.json.JSONArray claims = (org.json.JSONArray) PrinterService.request("GET", "/jobs/claimed", credential, null);
        // A lost claim response may have left no local journal entry at all.
        for (int index = 0; index < claims.length(); index++) {
            JSONObject job = claims.getJSONObject(index);
            if (job.getLong("tenant_id") != old.getLong("tenant_id")
                || job.getLong("claimed_by_agent_id") != old.getLong("agent_id")) throw new IllegalStateException();
            long id = job.getLong("id");
            if (!store.pending().containsKey(id)) store.save(id, false);
        }
        for (java.util.Map.Entry<Long, Boolean> entry : store.pending().entrySet()) {
            JSONObject body = new JSONObject().put("status", entry.getValue() ? "done" : "failed");
            if (!entry.getValue()) body.put("error_message", "Uncertain output during pairing change; check paper before manual reprint.");
            PrinterService.request("POST", "/jobs/" + entry.getKey() + "/complete", credential, body);
            store.remove(entry.getKey());
        }
        org.json.JSONArray remaining = (org.json.JSONArray) PrinterService.request("GET", "/jobs/claimed", credential, null);
        if (remaining.length() != 0) throw new IllegalStateException();
    }
    private void refreshStatus() { status.setText(store.status()); activate.setEnabled(!saving && !PrinterService.isRunning()); }
    private TextView text(LinearLayout layout, String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setPadding(0, 12, 0, 12); layout.addView(view); return view;
    }
    private EditText field(LinearLayout layout, String label, int input) {
        text(layout, label, 16); EditText view = new EditText(this); view.setInputType(input); view.setSingleLine(true); layout.addView(view); return view;
    }
    private Button button(LinearLayout layout, String label, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setOnClickListener(view -> action.run()); layout.addView(button); return button;
    }
    @Override protected void onResume() { super.onResume(); handler.post(refresh); }
    @Override protected void onPause() {
        handler.removeCallbacks(refresh);
        if (scanning) { cancelDiscovery(); scanStatus.setText("Search paused. Tap Find network printers to search again."); }
        super.onPause();
    }
}
