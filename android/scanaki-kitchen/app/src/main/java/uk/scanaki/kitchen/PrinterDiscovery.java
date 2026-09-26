package uk.scanaki.kitchen;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import java.net.Inet4Address;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** User-initiated, zero-payload TCP discovery, bound to a local Wi-Fi/Ethernet network. */
final class PrinterDiscovery implements AutoCloseable {
    interface Listener {
        void found(String address);
        void finished(String message);
    }
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService workers = Executors.newFixedThreadPool(8);
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final AtomicBoolean denied = new AtomicBoolean();
    private final AtomicInteger found = new AtomicInteger();
    private final Listener listener;

    PrinterDiscovery(Context context, Listener listener) {
        this.listener = listener;
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        Network selected = null;
        LinkAddress address = null;
        if (manager != null) for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            LinkProperties properties = manager.getLinkProperties(network);
            if (capabilities == null || properties == null || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                || !(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) continue;
            for (LinkAddress candidate : properties.getLinkAddresses()) {
                if (candidate.getAddress() instanceof Inet4Address && candidate.getAddress().isSiteLocalAddress()) {
                    selected = network; address = candidate; break;
                }
            }
            if (selected != null) break;
        }
        if (selected == null) { finish("Connect to the printer's Wi-Fi or Ethernet network, then try again."); return; }
        final Network network = selected;
        final boolean limited = address.getPrefixLength() < 24;
        final List<String> hosts = PrinterSubnet.hosts(address.getAddress().getAddress(), address.getPrefixLength());
        if (hosts.isEmpty()) { finish("No discoverable hosts on this network. Enter the printer address manually."); return; }
        AtomicInteger remaining = new AtomicInteger(hosts.size());
        for (String host : hosts) workers.execute(() -> {
            Socket socket = null;
            try {
                if (cancelled.get()) return;
                socket = network.getSocketFactory().createSocket();
                sockets.add(socket);
                if (cancelled.get()) return;
                socket.connect(new InetSocketAddress(host, 9100), 450);
                // Do not write, query printer status, or send a test page.
                found.incrementAndGet();
                main.post(() -> { if (!cancelled.get()) listener.found(host); });
            } catch (SecurityException error) {
                denied.set(true);
            } catch (Exception unavailable) {
                // Closed ports, isolated guests and offline devices are not candidates.
            } finally {
                if (socket != null) {
                    sockets.remove(socket);
                    try { socket.close(); } catch (Exception ignored) { }
                }
                if (remaining.decrementAndGet() == 0) {
                    String message = denied.get() ? "Android blocked network access. Check network permissions."
                        : found.get() == 0 ? "No port-9100 printers found. Check printer power and staff Wi-Fi, or enter the address manually."
                        : "Found " + found.get() + " printer candidate(s). Select an address below.";
                    if (limited) message += " This large network was limited to the tablet's /24 segment.";
                    finish(message);
                }
            }
        });
    }
    private void finish(String message) {
        workers.shutdown();
        main.post(() -> { if (!cancelled.get()) listener.finished(message); });
    }
    @Override public void close() {
        cancelled.set(true);
        workers.shutdownNow();
        for (Socket socket : sockets) try { socket.close(); } catch (Exception ignored) { }
        sockets.clear();
    }
}
