package uk.scanaki.kitchen;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.Ndef;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Explicit, foreground NFC operations. No intent dispatch or tag-provided commands. */
public final class NativeNfcBridge {
    private final Activity activity;
    private final WebView webView;
    private final NfcAdapter adapter;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile String documentToken = "";
    private boolean resumed;
    private Operation pending;
    private AlertDialog confirmation;

    private static final class Operation {
        final String id, token, page, writeUrl;
        final boolean nativeNavigation;
        volatile boolean cancelled;
        boolean reading;
        Operation(String id, String token, String page, String writeUrl, boolean nativeNavigation) {
            this.id = id; this.token = token; this.page = page;
            this.writeUrl = writeUrl; this.nativeNavigation = nativeNavigation;
        }
    }

    @SuppressWarnings("deprecation")
    public NativeNfcBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        adapter = NfcAdapter.getDefaultAdapter(activity);
        webView.addJavascriptInterface(this, "__ScanakiNative");
    }

    @JavascriptInterface
    public String getCapabilities() {
        boolean available = adapter != null;
        boolean enabled = available && adapter.isEnabled();
        return "{\"available\":" + available + ",\"enabled\":" + enabled
            + ",\"canRead\":" + enabled + ",\"canWrite\":" + enabled + "}";
    }

    // Tokens are closed over in the main-frame facade, never returned by the Java interface.
    @JavascriptInterface
    public void scan(String token, String requestId) {
        handler.post(() -> { if (authorized(token)) begin(requestId, null, false); });
    }

    @JavascriptInterface
    public void write(String token, String requestId, String url) {
        handler.post(() -> { if (authorized(token)) begin(requestId, url, false); });
    }

    @JavascriptInterface
    public void cancel(String token, String requestId) {
        handler.post(() -> {
            if (authorized(token) && pending != null && pending.id.equals(requestId))
                finish(pending, "cancelled", null, "Cancelled");
        });
    }

    public void installForPage() {
        if (!trustedPage()) return;
        if (documentToken.isEmpty()) documentToken = UUID.randomUUID().toString();
        String token = JSONObject.quote(documentToken);
        webView.evaluateJavascript("(()=>{if(window!==window.top)return;const t=" + token
            + ";window.ScanakiNfc=Object.freeze({"
            + "getCapabilities:()=>window.__ScanakiNative.getCapabilities(),"
            + "scan:id=>window.__ScanakiNative.scan(t,String(id)),"
            + "write:(id,url)=>window.__ScanakiNative.write(t,String(id),String(url)),"
            + "cancel:id=>window.__ScanakiNative.cancel(t,String(id))});"
            + "window.__scanakiNfcDeliver=(key,detail)=>{if(key===t)window.dispatchEvent(new CustomEvent('scanaki:nfc-result',{detail}));};"
            + "window.dispatchEvent(new CustomEvent('scanaki:native-ready'));})()", null);
    }

    private boolean trustedPage() {
        return webView.getUrl() != null && MainActivity.isAllowedUri(Uri.parse(webView.getUrl()));
    }

    private boolean authorized(String token) {
        return resumed && !documentToken.isEmpty() && documentToken.equals(token) && trustedPage();
    }

    public void scanNative() { begin("native-" + UUID.randomUUID(), null, true); }

    private void begin(String id, String writeUrl, boolean nativeNavigation) {
        if (!resumed || id == null || id.length() > 128) return;
        if (pending != null) finish(pending, "cancelled", null, "Replaced by another NFC operation");
        Operation operation = new Operation(id, documentToken, webView.getUrl(), writeUrl, nativeNavigation);
        pending = operation;
        if (writeUrl != null && (writeUrl.length() > 4096 || !MainActivity.isAllowedUri(Uri.parse(writeUrl)))) {
            finish(operation, "error", null, "Only Scanaki HTTPS URLs on port 443 are supported"); return;
        }
        if (adapter == null) {
            Toast.makeText(activity, R.string.nfc_unavailable, Toast.LENGTH_LONG).show();
            finish(operation, "unavailable", null, activity.getString(R.string.nfc_unavailable)); return;
        }
        if (!adapter.isEnabled()) {
            finish(operation, "disabled", null, activity.getString(R.string.nfc_disabled));
            new AlertDialog.Builder(activity).setMessage(R.string.nfc_disabled)
                .setPositiveButton(R.string.nfc_settings, (dialog, which) -> {
                    try { activity.startActivity(new Intent(Settings.ACTION_NFC_SETTINGS)); }
                    catch (RuntimeException error) { Toast.makeText(activity, R.string.nfc_disabled, Toast.LENGTH_LONG).show(); }
                }).setNegativeButton(android.R.string.cancel, null).show();
            return;
        }
        if (writeUrl != null) {
            confirmation = new AlertDialog.Builder(activity).setTitle(R.string.nfc_write_title)
                .setMessage("This replaces the tag's NDEF contents with:\n\n" + writeUrl)
                .setPositiveButton(R.string.nfc_write_confirm, (dialog, which) -> startReader(operation))
                .setNegativeButton(android.R.string.cancel, (dialog, which) -> finish(operation, "cancelled", null, "Cancelled"))
                .setOnCancelListener(dialog -> finish(operation, "cancelled", null, "Cancelled")).show();
        } else startReader(operation);
    }

    private void startReader(Operation operation) {
        if (!resumed || pending != operation || operation.cancelled) return;
        try {
            adapter.enableReaderMode(activity, tag -> handler.post(() -> {
                if (pending != operation || operation.cancelled || operation.reading) return;
                operation.reading = true;
                io.execute(() -> processTag(operation, tag));
            }), NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
                | NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V, null);
            Toast.makeText(activity, R.string.nfc_prompt, Toast.LENGTH_LONG).show();
            emit(operation, "ready", null, activity.getString(R.string.nfc_prompt));
            handler.postDelayed(() -> {
                if (pending == operation) finish(operation, "cancelled", null, "NFC operation timed out");
            }, 60000);
        } catch (RuntimeException error) {
            finish(operation, "error", null, "NFC reader could not start");
        }
    }

    private void processTag(Operation operation, Tag tag) {
        Ndef ndef = Ndef.get(tag);
        String url = null;
        String failure = null;
        try {
            if (ndef == null) throw new IllegalArgumentException("Tag is not NDEF formatted");
            ndef.connect();
            if (operation.cancelled) return;
            if (operation.writeUrl != null) {
                NdefMessage message = new NdefMessage(new NdefRecord[]{NdefRecord.createUri(operation.writeUrl)});
                if (!ndef.isWritable()) throw new IllegalArgumentException("Tag is read-only");
                if (message.toByteArray().length > ndef.getMaxSize()) throw new IllegalArgumentException("Tag capacity is too small");
                if (operation.cancelled) return;
                ndef.writeNdefMessage(message);
                url = operation.writeUrl;
            } else {
                NdefMessage message = ndef.getNdefMessage();
                if (message != null) for (NdefRecord record : message.getRecords()) {
                    // Reject text, smart posters, external types and application records.
                    if (record.getTnf() != NdefRecord.TNF_WELL_KNOWN
                        || !Arrays.equals(record.getType(), NdefRecord.RTD_URI)) continue;
                    Uri uri = record.toUri();
                    if (uri != null && MainActivity.isAllowedUri(uri)) { url = uri.toString(); break; }
                }
                if (url == null) throw new IllegalArgumentException("No supported Scanaki HTTPS URI record found");
            }
        } catch (Exception error) {
            failure = error instanceof IllegalArgumentException ? error.getMessage() : "Tag communication failed. Try again.";
        } finally {
            if (ndef != null) try { ndef.close(); } catch (Exception ignored) { }
        }
        String resultUrl = url;
        String resultFailure = failure;
        handler.post(() -> {
            if (pending != operation || operation.cancelled) return;
            finish(operation, resultFailure == null ? "success" : "error", resultUrl, resultFailure);
            if (operation.nativeNavigation && resultFailure == null && resumed) webView.loadUrl(resultUrl);
        });
    }

    private void emit(Operation operation, String status, String url, String message) {
        if (operation.nativeNavigation) {
            if (message != null && !"ready".equals(status)) Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
            return;
        }
        if ("ready".equals(status)) return;
        if (!authorized(operation.token) || !operation.page.equals(webView.getUrl())) return;
        try {
            JSONObject detail = new JSONObject();
            detail.put("requestId", operation.id); detail.put("status", "success".equals(status) ? "success" : "error");
            if (url != null) detail.put("url", url);
            if (message != null) detail.put("message", message);
            // Check again inside the destination document, guarding navigation races.
            webView.evaluateJavascript("if(window===window.top&&location.href==="
                + JSONObject.quote(operation.page) + ")window.__scanakiNfcDeliver?.("
                + JSONObject.quote(operation.token) + "," + detail + ");", null);
        } catch (Exception ignored) { }
    }

    private void finish(Operation operation, String status, String url, String message) {
        if (pending != operation) return;
        emit(operation, status, url, message);
        operation.cancelled = true;
        pending = null;
        if (confirmation != null) { confirmation.dismiss(); confirmation = null; }
        if (adapter != null) try { adapter.disableReaderMode(activity); } catch (RuntimeException ignored) { }
    }

    public void pageChanged() {
        if (pending != null) finish(pending, "cancelled", null, "Page changed");
        documentToken = "";
    }

    public void routeChanged(String url) {
        // SPA navigation keeps the document facade, but must disarm its old operation.
        if (pending != null && !java.util.Objects.equals(pending.page, url))
            finish(pending, "cancelled", null, "Page changed");
    }

    public void pause() {
        if (pending != null) finish(pending, "cancelled", null, "App paused");
        resumed = false;
    }

    public void resume() { resumed = true; }

    public void destroy() {
        pause();
        documentToken = "";
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        webView.removeJavascriptInterface("__ScanakiNative");
    }
}
