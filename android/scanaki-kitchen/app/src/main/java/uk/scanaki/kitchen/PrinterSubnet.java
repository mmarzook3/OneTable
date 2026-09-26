package uk.scanaki.kitchen;

import java.util.ArrayList;
import java.util.List;

/** Bounded private IPv4 discovery; never expands beyond the attached subnet. */
public final class PrinterSubnet {
    private PrinterSubnet() { }
    public static List<String> hosts(byte[] address, int prefix) {
        if (address.length != 4 || prefix < 0 || prefix > 32) throw new IllegalArgumentException("IPv4 subnet required");
        int a = address[0] & 255, b = address[1] & 255;
        if (!(a == 10 || a == 192 && b == 168 || a == 172 && b >= 16 && b <= 31)) {
            throw new IllegalArgumentException("Private LAN required");
        }
        List<String> hosts = new ArrayList<>();
        if (prefix >= 31) return hosts;
        int local = 0;
        for (byte octet : address) local = (local << 8) | (octet & 255);
        int boundedPrefix = Math.max(24, prefix);
        int mask = -1 << (32 - boundedPrefix);
        int base = local & mask;
        int count = 1 << (32 - boundedPrefix);
        for (int offset = 1; offset < count - 1; offset++) {
            int candidate = base + offset;
            if (candidate == local) continue;
            hosts.add(((candidate >>> 24) & 255) + "." + ((candidate >>> 16) & 255)
                + "." + ((candidate >>> 8) & 255) + "." + (candidate & 255));
        }
        return hosts;
    }
}
