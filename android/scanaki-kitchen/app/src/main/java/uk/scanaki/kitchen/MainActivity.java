package uk.scanaki.kitchen;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SafeBrowsingResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

@SuppressWarnings("deprecation")
public final class MainActivity extends Activity {
    private static final String KDS_URL = "https://scanaki.uk/kitchen";
    private static final String HEARTBEAT_URL =
        "https://scanaki.uk/api/tenant/kitchen-devices/heartbeat";
    private static final String HEARTBEAT_DIAGNOSTICS_URL =
        "https://scanaki.uk/api/tenant/kitchen-devices/diagnostics";
    private static final String DEVICE_KEY_STORAGE = "native_kds_device_key";
    private static final String HEARTBEAT_DIAGNOSTICS_STORAGE = "native_kds_heartbeat_diagnostics";
    private static final long HEARTBEAT_INTERVAL_SECONDS = 10;
    private static final int HEARTBEAT_FAILURE_THRESHOLD = 3;
    private static final long HEARTBEAT_OFFLINE_AFTER_MS = 25_000;
    private static final int MAX_HEARTBEAT_DIAGNOSTICS = 50;
    private static final long FRONTEND_UPDATE_CHECK_INTERVAL_MS = 60_000;
    private static final int CELLULAR_REQUEST_TIMEOUT_MS = 8_000;
    private static final Set<String> ALLOWED_HOSTS = Set.of("scanaki.uk", "www.scanaki.uk");

    private WebView webView;
    private ProgressBar progressBar;
    private TextView connectionBanner;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private ConnectivityManager.NetworkCallback cellularFallbackCallback;
    private Network cellularFallbackNetwork;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ScheduledExecutorService heartbeatExecutor;
    private String deviceKey;
    private boolean showingOfflinePage;
    private boolean networkWasLost;
    private boolean hasResumedOnce;
    private boolean cellularFallbackRequested;
    private boolean internetPanelShownForOutage;
    private long lastFrontendUpdateCheckAt;
    private int consecutiveHeartbeatFailures;
    private long lastSuccessfulHeartbeatAt = System.currentTimeMillis();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        deviceKey = getOrCreateDeviceKey();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        createContentView();
        getWindow().getDecorView().post(this::enterImmersiveMode);
        configureWebView();

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(KDS_URL);
        }
        registerNetworkRecovery();
    }

    private void createContentView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF090B10);

        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleLarge);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(64, 64);
        progressParams.gravity = android.view.Gravity.CENTER;
        root.addView(progressBar, progressParams);

        connectionBanner = new TextView(this);
        connectionBanner.setBackgroundColor(0xFF991B1B);
        connectionBanner.setTextColor(0xFFFFFFFF);
        connectionBanner.setTextSize(14);
        connectionBanner.setGravity(Gravity.CENTER);
        connectionBanner.setPadding(16, 12, 16, 12);
        connectionBanner.setText(R.string.heartbeat_failed);
        connectionBanner.setVisibility(View.GONE);
        connectionBanner.setElevation(12);
        FrameLayout.LayoutParams bannerParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        bannerParams.gravity = Gravity.TOP;
        root.addView(connectionBanner, bannerParams);

        setContentView(root);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(
            settings.getUserAgentString() + " ScanakiKitchen/" + BuildConfig.VERSION_NAME
        );

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WebView.startSafeBrowsing(this, null);
        }

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }

            @Override
            public void onProgressChanged(WebView view, int progress) {
                progressBar.setVisibility(progress < 100 ? View.VISIBLE : View.GONE);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("scanaki".equalsIgnoreCase(uri.getScheme())) {
                    if ("network-settings".equalsIgnoreCase(uri.getHost())) {
                        internetPanelShownForOutage = false;
                        openInternetConnectivityPanel();
                    } else if ("retry".equalsIgnoreCase(uri.getHost())) {
                        attemptNetworkRecovery();
                    }
                    return true;
                }
                if (isAllowedUri(uri)) {
                    showingOfflinePage = false;
                    return false;
                }
                Toast.makeText(MainActivity.this, R.string.blocked_link, Toast.LENGTH_SHORT).show();
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if (isAllowedUri(uri)) {
                    // Persist HttpOnly access/refresh cookies immediately. Android may
                    // terminate a kiosk-style app without delivering onPause first.
                    CookieManager.getInstance().flush();
                    synchroniseDeviceKey(view);
                }
                if (isAllowedUri(uri) && shouldReturnToKitchen(uri.getPath())) {
                    view.loadUrl(KDS_URL);
                }
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                super.doUpdateVisitedHistory(view, url, isReload);
                Uri uri = Uri.parse(url);
                if (isAllowedUri(uri)) {
                    // Angular login changes routes without a full page load.
                    CookieManager.getInstance().flush();
                }
            }

            @Override
            public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                WebResourceError error
            ) {
                if (request.isForMainFrame()) {
                    attemptNetworkRecovery();
                }
            }

            @Override
            public void onReceivedHttpError(
                WebView view,
                WebResourceRequest request,
                WebResourceResponse errorResponse
            ) {
                if (request.isForMainFrame() && errorResponse.getStatusCode() >= 500) {
                    showOfflinePage();
                }
            }

            @Override
            public void onSafeBrowsingHit(
                WebView view,
                WebResourceRequest request,
                int threatType,
                SafeBrowsingResponse callback
            ) {
                callback.backToSafety(true);
            }
        });
    }

    private boolean isAllowedUri(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme())
            && uri.getHost() != null
            && ALLOWED_HOSTS.contains(uri.getHost().toLowerCase());
    }

    private boolean shouldReturnToKitchen(String path) {
        if (path == null || path.trim().isEmpty()) {
            return true;
        }
        return !path.startsWith("/kitchen")
            && !path.startsWith("/login")
            && !path.startsWith("/forgot-password")
            && !path.startsWith("/reset-password");
    }

    private void showOfflinePage() {
        if (showingOfflinePage) {
            return;
        }
        showingOfflinePage = true;
        progressBar.setVisibility(View.GONE);
        webView.loadDataWithBaseURL(
            null,
            getString(R.string.offline_html),
            "text/html",
            "UTF-8",
            null
        );
    }

    private void registerNetworkRecovery() {
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkRequest request = new NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handlePotentialNetworkRecovery(network);
            }

            @Override
            public void onCapabilitiesChanged(
                Network network,
                NetworkCapabilities capabilities
            ) {
                if (isValidatedInternet(capabilities)) {
                    handlePotentialNetworkRecovery(network);
                }
            }

            @Override
            public void onLost(Network network) {
                runOnUiThread(() -> {
                    mainHandler.postDelayed(() -> {
                        if (!hasInternetConnection()) {
                            attemptNetworkRecovery();
                        }
                    }, 750);
                });
            }
        };
        connectivityManager.registerNetworkCallback(request, networkCallback);
        if (!hasInternetConnection()) {
            attemptNetworkRecovery();
        }
    }

    private void handlePotentialNetworkRecovery(Network network) {
        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
        if (!isValidatedInternet(capabilities)) {
            return;
        }
        runOnUiThread(() -> {
            if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                releaseCellularFallback();
            }
            internetPanelShownForOutage = false;
            boolean shouldReload = networkWasLost || showingOfflinePage;
            networkWasLost = false;
            showingOfflinePage = false;
            if (shouldReload) {
                webView.loadUrl(KDS_URL);
            }
            requestImmediateHeartbeat();
        });
    }

    private void attemptNetworkRecovery() {
        if (hasInternetConnection()) {
            handlePotentialNetworkRecovery(getUsableNetwork());
            return;
        }

        networkWasLost = true;
        if (!isWifiEnabled()) {
            showOfflinePage();
            openInternetConnectivityPanel();
            return;
        }

        requestCellularFallback();
    }

    private boolean isWifiEnabled() {
        WifiManager wifiManager = (WifiManager) getApplicationContext()
            .getSystemService(Context.WIFI_SERVICE);
        return wifiManager != null && wifiManager.isWifiEnabled();
    }

    private void requestCellularFallback() {
        if (cellularFallbackRequested || cellularFallbackNetwork != null) {
            return;
        }
        cellularFallbackRequested = true;
        NetworkRequest request = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();
        cellularFallbackCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                useCellularFallbackIfValidated(network);
            }

            @Override
            public void onCapabilitiesChanged(
                Network network,
                NetworkCapabilities capabilities
            ) {
                if (isValidatedInternet(capabilities)) {
                    useCellularFallbackIfValidated(network);
                }
            }

            @Override
            public void onUnavailable() {
                runOnUiThread(() -> {
                    cellularFallbackRequested = false;
                    cellularFallbackCallback = null;
                    showOfflinePage();
                    openInternetConnectivityPanel();
                });
            }

            @Override
            public void onLost(Network network) {
                runOnUiThread(() -> {
                    releaseCellularFallback();
                    attemptNetworkRecovery();
                });
            }
        };
        try {
            connectivityManager.requestNetwork(
                request,
                cellularFallbackCallback,
                CELLULAR_REQUEST_TIMEOUT_MS
            );
        } catch (RuntimeException ignored) {
            cellularFallbackRequested = false;
            cellularFallbackCallback = null;
            showOfflinePage();
            openInternetConnectivityPanel();
        }
    }

    private void useCellularFallbackIfValidated(Network network) {
        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
        if (!isValidatedInternet(capabilities)) {
            return;
        }
        cellularFallbackNetwork = network;
        connectivityManager.bindProcessToNetwork(network);
        handlePotentialNetworkRecovery(network);
    }

    private void releaseCellularFallback() {
        if (cellularFallbackNetwork != null) {
            connectivityManager.bindProcessToNetwork(null);
            cellularFallbackNetwork = null;
        }
        if (cellularFallbackCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(cellularFallbackCallback);
            } catch (IllegalArgumentException ignored) {
                // A timed-out request is already unregistered by Android.
            }
            cellularFallbackCallback = null;
        }
        cellularFallbackRequested = false;
    }

    private void openInternetConnectivityPanel() {
        if (internetPanelShownForOutage) {
            return;
        }
        internetPanelShownForOutage = true;
        Intent intent = new Intent(
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? Settings.Panel.ACTION_INTERNET_CONNECTIVITY
                : Settings.ACTION_WIRELESS_SETTINGS
        );
        try {
            startActivity(intent);
        } catch (RuntimeException ignored) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    private boolean hasInternetConnection() {
        return getUsableNetwork() != null;
    }

    private Network getUsableNetwork() {
        if (connectivityManager == null) {
            return null;
        }
        if (cellularFallbackNetwork != null) {
            NetworkCapabilities cellularCapabilities = connectivityManager
                .getNetworkCapabilities(cellularFallbackNetwork);
            if (isValidatedInternet(cellularCapabilities)) {
                return cellularFallbackNetwork;
            }
        }
        Network network = connectivityManager.getActiveNetwork();
        if (network == null) {
            return null;
        }
        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
        return isValidatedInternet(capabilities) ? network : null;
    }

    private boolean isValidatedInternet(NetworkCapabilities capabilities) {
        return capabilities != null
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private String getOrCreateDeviceKey() {
        String saved = getPreferences(MODE_PRIVATE).getString(DEVICE_KEY_STORAGE, "");
        if (isValidDeviceKey(saved)) {
            return saved;
        }
        String androidId = Settings.Secure.getString(
            getContentResolver(),
            Settings.Secure.ANDROID_ID
        );
        String suffix = androidId == null || androidId.trim().isEmpty()
            ? UUID.randomUUID().toString().replace("-", "")
            : androidId.replaceAll("[^A-Za-z0-9_-]", "");
        String generated = "android_" + suffix;
        getPreferences(MODE_PRIVATE).edit().putString(DEVICE_KEY_STORAGE, generated).apply();
        return generated;
    }

    private boolean isValidDeviceKey(String value) {
        return value != null
            && value.length() >= 16
            && value.length() <= 64
            && value.matches("^[A-Za-z0-9_-]+$");
    }

    private void synchroniseDeviceKey(WebView view) {
        // The native Android ID is authoritative. Copy it into the web app instead of
        // adopting a browser-generated key, which created duplicate device rows after
        // cache clears and app upgrades.
        view.evaluateJavascript(
            "localStorage.setItem('one-table-kds-device-key','" + deviceKey + "')",
            null
        );
    }

    private void startNativeHeartbeat() {
        if (heartbeatExecutor != null && !heartbeatExecutor.isShutdown()) {
            return;
        }
        heartbeatExecutor = Executors.newSingleThreadScheduledExecutor();
        heartbeatExecutor.scheduleWithFixedDelay(
            this::sendNativeHeartbeat,
            0,
            HEARTBEAT_INTERVAL_SECONDS,
            TimeUnit.SECONDS
        );
    }

    private void stopNativeHeartbeat() {
        if (heartbeatExecutor != null) {
            heartbeatExecutor.shutdownNow();
            heartbeatExecutor = null;
        }
    }

    private void requestImmediateHeartbeat() {
        ScheduledExecutorService executor = heartbeatExecutor;
        if (executor != null && !executor.isShutdown()) {
            executor.submit(this::sendNativeHeartbeat);
        }
    }

    private void sendNativeHeartbeat() {
        long startedAt = System.currentTimeMillis();
        if (!hasInternetConnection()) {
            handleHeartbeatFailure(
                null,
                "No validated Wi-Fi or mobile connection",
                System.currentTimeMillis() - startedAt
            );
            return;
        }
        String cookies = CookieManager.getInstance().getCookie("https://scanaki.uk/");
        if (cookies == null || !cookies.contains("access_token=")) {
            hideHeartbeatFailure();
            requestFrontendUpdateCheck();
            return;
        }
        HttpURLConnection connection = null;
        try {
            JSONObject payload = new JSONObject();
            payload.put("device_key", deviceKey);
            payload.put(
                "name",
                "Scanaki Kitchen app - " + Build.MANUFACTURER + " " + Build.MODEL
            );
            payload.put("display_route", "kitchen");
            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);

            connection = (HttpURLConnection) new URL(HEARTBEAT_URL).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(body.length);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cookie", cookies);
            connection.setRequestProperty(
                "User-Agent",
                "ScanakiKitchen/" + BuildConfig.VERSION_NAME
            );
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            int status = connection.getResponseCode();
            InputStream response = status >= 400
                ? connection.getErrorStream()
                : connection.getInputStream();
            if (response != null) {
                try (response) {
                    byte[] buffer = new byte[256];
                    while (response.read(buffer) != -1) {
                        // Drain the small response so the HTTPS connection closes cleanly.
                    }
                }
            }
            if (status >= 200 && status < 300) {
                CookieManager.getInstance().flush();
                handleHeartbeatSuccess(
                    cookies,
                    System.currentTimeMillis() - startedAt
                );
                requestFrontendUpdateCheck();
            } else if (status == 401 || status == 403) {
                recordHeartbeatDiagnostic(
                    "auth_failure",
                    status,
                    System.currentTimeMillis() - startedAt,
                    "Native heartbeat authentication was rejected; web token refresh will retry."
                );
                hideHeartbeatFailure();
                requestFrontendUpdateCheck();
            } else {
                handleHeartbeatFailure(
                    status,
                    "Heartbeat returned HTTP " + status,
                    System.currentTimeMillis() - startedAt
                );
            }
        } catch (Exception error) {
            handleHeartbeatFailure(
                null,
                error.getClass().getSimpleName() + ": " + safeDetail(error.getMessage()),
                System.currentTimeMillis() - startedAt
            );
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private synchronized void handleHeartbeatFailure(
        Integer statusCode,
        String detail,
        long durationMs
    ) {
        consecutiveHeartbeatFailures += 1;
        recordHeartbeatDiagnostic("failure", statusCode, durationMs, detail);
        if (
            consecutiveHeartbeatFailures >= HEARTBEAT_FAILURE_THRESHOLD
                && System.currentTimeMillis() - lastSuccessfulHeartbeatAt
                    >= HEARTBEAT_OFFLINE_AFTER_MS
        ) {
            showHeartbeatFailure();
        }
    }

    private synchronized void handleHeartbeatSuccess(String cookies, long durationMs) {
        int recoveredFailures = consecutiveHeartbeatFailures;
        if (recoveredFailures > 0) {
            recordHeartbeatDiagnostic(
                "recovered",
                200,
                durationMs,
                "Heartbeat recovered after " + recoveredFailures + " consecutive failure(s)."
            );
        }
        consecutiveHeartbeatFailures = 0;
        lastSuccessfulHeartbeatAt = System.currentTimeMillis();
        hideHeartbeatFailure();
        uploadPendingHeartbeatDiagnostics(cookies);
    }

    private synchronized void recordHeartbeatDiagnostic(
        String outcome,
        Integer statusCode,
        long durationMs,
        String detail
    ) {
        try {
            JSONObject event = new JSONObject();
            event.put("source", "native");
            event.put("outcome", outcome);
            event.put("occurred_at", Instant.now().toString());
            if (statusCode != null) event.put("status_code", statusCode);
            event.put("duration_ms", Math.max(0, durationMs));
            event.put("consecutive_failures", consecutiveHeartbeatFailures);
            event.put("network_type", currentNetworkType());
            event.put("wifi_enabled", isWifiEnabled());
            event.put("network_validated", hasInternetConnection());
            event.put("detail", safeDetail(detail));

            JSONArray stored = pendingHeartbeatDiagnostics();
            JSONArray capped = new JSONArray();
            int first = Math.max(0, stored.length() - (MAX_HEARTBEAT_DIAGNOSTICS - 1));
            for (int index = first; index < stored.length(); index += 1) {
                capped.put(stored.get(index));
            }
            capped.put(event);
            getPreferences(MODE_PRIVATE)
                .edit()
                .putString(HEARTBEAT_DIAGNOSTICS_STORAGE, capped.toString())
                .apply();
            appendHeartbeatLog(event.toString());
            if (!"recovered".equals(outcome)) {
                Log.w("ScanakiHeartbeat", event.toString());
            } else {
                Log.i("ScanakiHeartbeat", event.toString());
            }
        } catch (Exception error) {
            Log.w("ScanakiHeartbeat", "Could not persist heartbeat diagnostic", error);
        }
    }

    private JSONArray pendingHeartbeatDiagnostics() {
        String stored = getPreferences(MODE_PRIVATE)
            .getString(HEARTBEAT_DIAGNOSTICS_STORAGE, "[]");
        try {
            return new JSONArray(stored == null ? "[]" : stored);
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    private void uploadPendingHeartbeatDiagnostics(String cookies) {
        JSONArray events = pendingHeartbeatDiagnostics();
        if (events.length() == 0 || cookies == null || cookies.trim().isEmpty()) return;
        HttpURLConnection diagnosticConnection = null;
        try {
            JSONObject payload = new JSONObject();
            payload.put("device_key", deviceKey);
            payload.put("events", events);
            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            diagnosticConnection = (HttpURLConnection) new URL(
                HEARTBEAT_DIAGNOSTICS_URL
            ).openConnection();
            diagnosticConnection.setRequestMethod("POST");
            diagnosticConnection.setConnectTimeout(5000);
            diagnosticConnection.setReadTimeout(5000);
            diagnosticConnection.setDoOutput(true);
            diagnosticConnection.setFixedLengthStreamingMode(body.length);
            diagnosticConnection.setRequestProperty("Content-Type", "application/json");
            diagnosticConnection.setRequestProperty("Accept", "application/json");
            diagnosticConnection.setRequestProperty("Cookie", cookies);
            diagnosticConnection.setRequestProperty(
                "User-Agent",
                "ScanakiKitchen/" + BuildConfig.VERSION_NAME
            );
            try (OutputStream output = diagnosticConnection.getOutputStream()) {
                output.write(body);
            }
            int status = diagnosticConnection.getResponseCode();
            InputStream response = status >= 400
                ? diagnosticConnection.getErrorStream()
                : diagnosticConnection.getInputStream();
            if (response != null) {
                try (response) {
                    byte[] buffer = new byte[256];
                    while (response.read(buffer) != -1) {
                        // Drain response.
                    }
                }
            }
            if (status >= 200 && status < 300) {
                getPreferences(MODE_PRIVATE)
                    .edit()
                    .putString(HEARTBEAT_DIAGNOSTICS_STORAGE, "[]")
                    .apply();
            }
        } catch (Exception error) {
            Log.w("ScanakiHeartbeat", "Diagnostic upload deferred", error);
        } finally {
            if (diagnosticConnection != null) diagnosticConnection.disconnect();
        }
    }

    private String currentNetworkType() {
        Network network = getUsableNetwork();
        NetworkCapabilities capabilities = network == null
            ? null
            : connectivityManager.getNetworkCapabilities(network);
        if (capabilities == null) return "none";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
        return "other";
    }

    private void appendHeartbeatLog(String line) {
        try {
            File logFile = new File(getFilesDir(), "kds-heartbeat.log");
            if (logFile.exists() && logFile.length() > 262_144) {
                File previous = new File(getFilesDir(), "kds-heartbeat.log.1");
                if (previous.exists()) previous.delete();
                if (!logFile.renameTo(previous)) logFile.delete();
            }
            try (FileOutputStream output = new FileOutputStream(logFile, true)) {
                output.write((line + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception error) {
            Log.w("ScanakiHeartbeat", "Could not append local heartbeat log", error);
        }
    }

    private String safeDetail(String value) {
        if (value == null || value.trim().isEmpty()) return "No detail";
        String normalized = value.replaceAll("[\\r\\n]+", " ").trim();
        return normalized.length() <= 500 ? normalized : normalized.substring(0, 500);
    }

    private void showHeartbeatFailure() {
        runOnUiThread(() -> connectionBanner.setVisibility(View.VISIBLE));
    }

    private void hideHeartbeatFailure() {
        runOnUiThread(() -> connectionBanner.setVisibility(View.GONE));
    }

    private synchronized void requestFrontendUpdateCheck() {
        long now = System.currentTimeMillis();
        if (now - lastFrontendUpdateCheckAt < FRONTEND_UPDATE_CHECK_INTERVAL_MS) {
            return;
        }
        lastFrontendUpdateCheckAt = now;
        runOnUiThread(() -> {
            if (webView == null || showingOfflinePage) {
                return;
            }
            webView.evaluateJavascript(
                "(async()=>{try{" +
                "const html=await fetch('/?scanaki_update_check='+Date.now()," +
                "{cache:'no-store',credentials:'same-origin'}).then(r=>r.text());" +
                "const next=(html.match(/<script[^>]+src=[\"']([^\"']*main-[^\"']+\\.js)/i)||[])[1]||'';" +
                "const current=Array.from(document.scripts).map(s=>s.src).find(src=>/main-[^/]+\\.js/.test(src))||'';" +
                "if(next&&current&&!current.endsWith(next)){window.location.reload();return 'reloaded';}" +
                "return 'current';}catch(e){return 'error';}})()",
                null
            );
        });
    }

    private void enterImmersiveMode() {
        View decorView = getWindow().getDecorView();
        if (!decorView.isAttachedToWindow()) {
            decorView.post(this::enterImmersiveMode);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = decorView.getWindowInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
        } else {
            decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            );
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enterImmersiveMode();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onPause() {
        stopNativeHeartbeat();
        CookieManager.getInstance().flush();
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersiveMode();
        webView.onResume();
        if (hasResumedOnce && hasInternetConnection() && !showingOfflinePage) {
            webView.reload();
        }
        hasResumedOnce = true;
        startNativeHeartbeat();
        if (!hasInternetConnection()) {
            attemptNetworkRecovery();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onDestroy() {
        stopNativeHeartbeat();
        if (networkCallback != null) {
            connectivityManager.unregisterNetworkCallback(networkCallback);
        }
        releaseCellularFallback();
        webView.stopLoading();
        webView.destroy();
        super.onDestroy();
    }
}
