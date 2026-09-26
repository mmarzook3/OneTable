package uk.scanaki.kitchen;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.IBinder;
import android.os.PowerManager;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** One visible, opt-in LAN queue consumer, independent of WebView login/activity. */
public final class PrinterService extends Service {
    static final String STOP = "uk.scanaki.kitchen.STOP_PRINTING";
    private static final java.util.concurrent.atomic.AtomicInteger WORKER_INSTANCES = new java.util.concurrent.atomic.AtomicInteger();
    static boolean isRunning() { return WORKER_INSTANCES.get() > 0; }
    static final Object WORKER_LOCK = new Object();
    private static final String BASE = "https://scanaki.uk/api/print-agent";
    private static final String CHANNEL = "scanaki-printer";
    private PrinterStore store;
    private ScheduledExecutorService worker;
    private ScheduledExecutorService deadlines;
    private PowerManager.WakeLock wake;
    private volatile boolean stopping;
    private PrinterEngine engine;
    private int failures;

    static void startIfEnabled(Context context) {
        PrinterStore store = new PrinterStore(context);
        if (!store.enabled()) return;
        try { context.startForegroundService(new Intent(context, PrinterService.class)); }
        catch (RuntimeException error) { store.status("Open Scanaki to resume printing; Android blocked background startup"); }
    }
    @Override public void onCreate() {
        super.onCreate(); store = new PrinterStore(this);
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Scanaki printer", NotificationManager.IMPORTANCE_LOW));
        startForeground(71, notification("Starting printer connection"));
        WORKER_INSTANCES.incrementAndGet();
        worker = Executors.newSingleThreadScheduledExecutor();
        deadlines = Executors.newSingleThreadScheduledExecutor();
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Scanaki:printer");
        wake.setReferenceCounted(false);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            store.setEnabled(false); stopping = true;
            worker.execute(this::stopSelf);
            return START_NOT_STICKY;
        }
        if (!store.enabled()) { stopSelf(); return START_NOT_STICKY; }
        if (engine == null) {
            try {
                JSONObject config = store.config();
                if (config == null) throw new IllegalStateException();
                final String token = config.getString("token");
                final long tenant = config.getLong("tenant_id");
                final long agent = config.getLong("agent_id");
                final String host = config.getString("host");
                final int port = config.getInt("port");
                if (!PrinterStore.validHost(host) || port < 1 || port > 65535) throw new IllegalStateException();
                PrinterEngine.Queue queue = new PrinterEngine.Queue() {
                    public List<PrinterEngine.Job> claimed() throws Exception {
                        JSONArray rows = (JSONArray) request("GET", "/jobs/claimed", token, null);
                        List<PrinterEngine.Job> result = new ArrayList<>();
                        for (int index = 0; index < rows.length(); index++) {
                            JSONObject row = rows.getJSONObject(index);
                            validate(row); result.add(new PrinterEngine.Job(row.getLong("id"), ""));
                        }
                        return result;
                    }
                    private void validate(JSONObject row) throws Exception {
                        if (row.getLong("tenant_id") != tenant || row.getLong("claimed_by_agent_id") != agent
                            || !"claimed".equals(row.getString("status"))) throw new IllegalStateException();
                    }
                    public PrinterEngine.Job claim() throws Exception {
                        JSONArray rows = (JSONArray) request("GET", "/jobs?limit=1", token, null);
                        if (rows.length() == 0) return null;
                        if (rows.length() != 1) throw new IllegalStateException();
                        JSONObject row = rows.getJSONObject(0); validate(row);
                        String type = row.getString("job_type");
                        String role = row.optString("printer_role", type);
                        if (!("kitchen".equals(type) || "receipt".equals(type))
                            || !("kitchen".equals(role) || "receipt".equals(role))) throw new IllegalStateException();
                        JSONObject payload = row.getJSONObject("payload");
                        String text = payload.optString("plain_text", "");
                        if (text.isEmpty()) {
                            JSONArray lines = payload.optJSONArray("lines");
                            StringBuilder builder = new StringBuilder();
                            if (lines != null) for (int i = 0; i < lines.length(); i++) {
                                JSONObject line = lines.getJSONObject(i);
                                builder.append(line.optInt("quantity", 1)).append("x ").append(line.optString("name", "")).append('\n');
                            }
                            text = builder.toString();
                        }
                        if (text.isEmpty() || text.length() > 32768) throw new IllegalStateException();
                        return new PrinterEngine.Job(row.getLong("id"), text);
                    }
                    public void complete(long id, boolean done) throws Exception {
                        JSONObject payload = new JSONObject().put("status", done ? "done" : "failed");
                        if (!done) payload.put("error_message", "Print outcome uncertain after interruption. Check paper before manually reprinting.");
                        request("POST", "/jobs/" + id + "/complete", token, payload);
                    }
                };
                PrinterEngine.Transport transport = new PrinterEngine.Transport() {
                    private Socket connect() throws Exception {
                        ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
                        for (Network network : connectivity.getAllNetworks()) {
                            NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
                            if (caps == null || !(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) continue;
                            Socket socket = network.getSocketFactory().createSocket();
                            try { socket.connect(new InetSocketAddress(host, port), 5000); return socket; }
                            catch (Exception error) { socket.close(); }
                        }
                        throw new java.io.IOException("Printer LAN unavailable");
                    }
                    public void probe() throws Exception {
                        try (Socket ignored = connect()) { /* Connectivity only: no paper bytes. */ }
                        JSONObject heartbeat = (JSONObject) request("POST", "/heartbeat", token, new JSONObject());
                        if (heartbeat.getLong("id") != agent || heartbeat.getLong("tenant_id") != tenant) throw new IllegalStateException();
                    }
                    public void send(byte[] bytes) throws Exception {
                        try (Socket socket = connect()) {
                            java.util.concurrent.ScheduledFuture<?> timeout = deadlines.schedule(() -> {
                                try { socket.close(); } catch (Exception ignored) { }
                            }, 10, TimeUnit.SECONDS);
                            try { OutputStream output = socket.getOutputStream(); output.write(bytes); output.flush(); }
                            finally { timeout.cancel(false); }
                        }
                    }
                };
                engine = new PrinterEngine(queue, transport, store, this::showStatus);
                worker.execute(this::tick);
            } catch (Exception error) {
                store.setEnabled(false); showStatus("Printer configuration unavailable. Pair the printer again."); stopSelf();
                return START_NOT_STICKY;
            }
        }
        return START_STICKY;
    }
    private void tick() {
        synchronized (WORKER_LOCK) { tickLocked(); }
    }
    private void tickLocked() {
        if (stopping || !store.enabled()) { stopSelf(); return; }
        wake.acquire(120000);
        try { engine.tick(); failures = 0; }
        catch (Unauthorized error) {
            store.setEnabled(false); showStatus("Print token revoked or invalid. Pair the printer again."); stopSelf(); return;
        } catch (Exception error) {
            failures = Math.min(failures + 1, 4);
            showStatus("Printer/cloud unavailable or recovery pending. Retrying; check Wi-Fi and printer power.");
        }
        if (!stopping && store.enabled()) worker.schedule(this::tick, Math.min(30, 3 * (1 << failures)), TimeUnit.SECONDS);
        else stopSelf();
    }
    private void showStatus(String text) {
        store.status(text);
        getSystemService(NotificationManager.class).notify(71, notification(text));
    }
    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 71, new Intent(this, PrinterSettingsActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Scanaki printer").setContentText(text).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true).build();
    }
    static final class Unauthorized extends Exception { }
    static Object request(String method, String path, String token, JSONObject payload) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE + path).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
        connection.setRequestMethod(method); connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (payload != null) {
                byte[] data = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true); connection.setFixedLengthStreamingMode(data.length);
                connection.setRequestProperty("Content-Type", "application/json");
                try (OutputStream output = connection.getOutputStream()) { output.write(data); }
            }
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new Unauthorized();
            if (status < 200 || status >= 300) throw new java.io.IOException("Print API rejected request");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096]; int size;
                while ((size = input.read(buffer)) != -1) {
                    if (output.size() + size > 262144) throw new java.io.IOException("Print response too large");
                    output.write(buffer, 0, size);
                }
                return new JSONTokener(output.toString(StandardCharsets.UTF_8.name())).nextValue();
            }
        } finally { connection.disconnect(); }
    }
    @Override public void onDestroy() {
        stopping = true;
        // Finish the in-flight send/ack before allowing another worker or pairing.
        // Delayed ticks see stopping=true and cannot claim or send anything.
        worker.execute(() -> {
            synchronized (WORKER_LOCK) {
                if (deadlines != null) deadlines.shutdown();
                if (wake != null && wake.isHeld()) wake.release();
                WORKER_INSTANCES.decrementAndGet();
            }
        });
        worker.shutdown();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
