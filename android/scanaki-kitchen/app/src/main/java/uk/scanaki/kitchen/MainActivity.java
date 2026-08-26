package uk.scanaki.kitchen;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
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

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
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
    private static final String DEVICE_KEY_STORAGE = "native_kds_device_key";
    private static final long HEARTBEAT_INTERVAL_SECONDS = 10;
    private static final Set<String> ALLOWED_HOSTS = Set.of("scanaki.uk", "www.scanaki.uk");

    private WebView webView;
    private ProgressBar progressBar;
    private TextView connectionBanner;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private ScheduledExecutorService heartbeatExecutor;
    private String deviceKey;
    private boolean showingOfflinePage;
    private boolean networkWasLost;

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
                    synchroniseDeviceKey(view);
                }
                if (isAllowedUri(uri) && shouldReturnToKitchen(uri.getPath())) {
                    view.loadUrl(KDS_URL);
                }
            }

            @Override
            public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                WebResourceError error
            ) {
                if (request.isForMainFrame()) {
                    showOfflinePage();
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
                runOnUiThread(() -> {
                    if (networkWasLost || showingOfflinePage) {
                        networkWasLost = false;
                        showingOfflinePage = false;
                        webView.loadUrl(KDS_URL);
                    }
                    requestImmediateHeartbeat();
                });
            }

            @Override
            public void onLost(Network network) {
                runOnUiThread(() -> {
                    if (!hasInternetConnection()) {
                        networkWasLost = true;
                        showOfflinePage();
                    }
                });
            }
        };
        connectivityManager.registerNetworkCallback(request, networkCallback);
        if (!hasInternetConnection()) {
            networkWasLost = true;
            showOfflinePage();
        }
    }

    private boolean hasInternetConnection() {
        Network network = connectivityManager.getActiveNetwork();
        if (network == null) {
            return false;
        }
        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
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
        view.evaluateJavascript(
            "localStorage.getItem('one-table-kds-device-key') || ''",
            value -> {
                String webKey = value == null ? "" : value.replace("\"", "").trim();
                if (isValidDeviceKey(webKey)) {
                    deviceKey = webKey;
                    getPreferences(MODE_PRIVATE)
                        .edit()
                        .putString(DEVICE_KEY_STORAGE, webKey)
                        .apply();
                } else {
                    view.evaluateJavascript(
                        "localStorage.setItem('one-table-kds-device-key','" + deviceKey + "')",
                        null
                    );
                }
            }
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
        if (!hasInternetConnection()) {
            showHeartbeatFailure();
            return;
        }
        String cookies = CookieManager.getInstance().getCookie("https://scanaki.uk/");
        if (cookies == null || !cookies.contains("access_token=")) {
            hideHeartbeatFailure();
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
                hideHeartbeatFailure();
            } else if (status == 401 || status == 403) {
                hideHeartbeatFailure();
            } else {
                showHeartbeatFailure();
            }
        } catch (Exception ignored) {
            showHeartbeatFailure();
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void showHeartbeatFailure() {
        runOnUiThread(() -> connectionBanner.setVisibility(View.VISIBLE));
    }

    private void hideHeartbeatFailure() {
        runOnUiThread(() -> connectionBanner.setVisibility(View.GONE));
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
        startNativeHeartbeat();
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
        webView.stopLoading();
        webView.destroy();
        super.onDestroy();
    }
}
