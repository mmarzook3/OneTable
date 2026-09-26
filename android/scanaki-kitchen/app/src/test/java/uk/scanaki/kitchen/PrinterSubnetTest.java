package uk.scanaki.kitchen;

import java.net.InetAddress;
import java.util.List;

public final class PrinterSubnetTest {
    private static void check(boolean condition) { if (!condition) throw new AssertionError("Subnet guard failed"); }
    private static List<String> hosts(String ip, int prefix) throws Exception {
        return PrinterSubnet.hosts(InetAddress.getByName(ip).getAddress(), prefix);
    }
    public static void main(String[] args) throws Exception {
        List<String> lan = hosts("192.168.55.145", 24);
        check(lan.size() == 253 && lan.contains("192.168.55.20"));
        check(!lan.contains("192.168.55.0") && !lan.contains("192.168.55.255") && !lan.contains("192.168.55.145"));
        check(hosts("10.20.30.40", 8).size() == 253 && hosts("10.20.30.40", 8).stream().allMatch(ip -> ip.startsWith("10.20.30.")));
        check(hosts("172.16.1.9", 30).equals(List.of("172.16.1.10")));
        check(hosts("192.168.1.10", 31).isEmpty() && hosts("192.168.1.10", 32).isEmpty());
        for (String forbidden : List.of("8.8.8.8", "127.0.0.1", "169.254.1.1", "172.15.1.1", "172.32.1.1", "192.169.1.1", "::1")) {
            try { hosts(forbidden, 24); throw new AssertionError("Non-private address accepted"); }
            catch (IllegalArgumentException expected) { }
        }
        for (int prefix : new int[]{-1, 33}) {
            try { hosts("10.1.2.3", prefix); throw new AssertionError("Invalid prefix accepted"); }
            catch (IllegalArgumentException expected) { }
        }
        System.out.println("PrinterSubnetTest: private range, bounds, subnet and exclusion checks passed");
    }
}
