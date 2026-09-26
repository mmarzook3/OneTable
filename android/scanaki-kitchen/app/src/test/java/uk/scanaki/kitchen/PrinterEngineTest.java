package uk.scanaki.kitchen;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Standalone Java 17 tests; assertions are explicit and do not require -ea. */
public final class PrinterEngineTest {
    private static final class Fixture implements PrinterEngine.Queue,
            PrinterEngine.Transport, PrinterEngine.Journal, PrinterEngine.Status {
        final Map<Long, Boolean> records = new LinkedHashMap<>();
        final List<PrinterEngine.Job> owned = new ArrayList<>();
        final List<String> acknowledgements = new ArrayList<>();
        final List<String> events = new ArrayList<>();
        PrinterEngine.Job next = new PrinterEngine.Job(7, "PRIVATE ticket");
        int sends;
        int claims;
        boolean offline;
        boolean failSend;
        boolean failFalseSave;
        boolean failTrueSave;
        boolean failRemove;
        boolean loseAck;
        boolean loseClaim;
        byte[] bytes;

        PrinterEngine engine() { return new PrinterEngine(this, this, this, this); }
        public List<PrinterEngine.Job> claimed() { return new ArrayList<>(owned); }
        public PrinterEngine.Job claim() throws Exception {
            claims++;
            PrinterEngine.Job result = next;
            next = null;
            if (result != null) owned.add(result);
            if (loseClaim) { loseClaim = false; throw new Exception("private claim detail"); }
            return result;
        }
        public void complete(long id, boolean done) throws Exception {
            acknowledgements.add(id + ":" + done);
            owned.removeIf(job -> job.id == id);
            if (loseAck) { loseAck = false; throw new Exception("private ack detail"); }
        }
        public void probe() throws Exception {
            if (offline) throw new Exception("private network detail");
        }
        public void send(byte[] data) throws Exception {
            check(Boolean.FALSE.equals(records.get(7L)), "durable false before socket write");
            sends++;
            bytes = data;
            if (failSend) throw new Exception("private socket detail");
        }
        public Map<Long, Boolean> pending() { return new LinkedHashMap<>(records); }
        public void save(long id, boolean sent) throws Exception {
            if ((!sent && failFalseSave) || (sent && failTrueSave)) {
                throw new Exception("private storage detail");
            }
            records.put(id, sent);
        }
        public void remove(long id) throws Exception {
            if (failRemove) throw new Exception("private removal detail");
            records.remove(id);
        }
        public void update(String text) {
            check(!text.contains("PRIVATE") && !text.contains("private"), "status privacy");
            events.add(text);
        }
    }

    private interface Action { void run() throws Exception; }
    private static void fails(Action action) throws Exception {
        try { action.run(); } catch (Exception expected) { return; }
        throw new AssertionError("Expected failure");
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        successAndRender();
        offline();
        failedSend();
        lostAcknowledgement();
        recoveredClaims();
        persistenceBeforeSend();
        persistenceAfterSend();
        lostClaim();
        failedRemoval();
        failedSendAndAck();
        System.out.println("PrinterEngineTest: 10 scenarios passed");
    }

    private static void successAndRender() throws Exception {
        Fixture f = new Fixture();
        f.engine().tick();
        check(f.sends == 1 && f.claims == 1, "one send and claim per tick");
        check(f.acknowledgements.equals(List.of("7:true")), "success acknowledged");
        check(f.records.isEmpty(), "remove after ack");
        byte[] b = PrinterEngine.render("A\u001b\u001d\u0000\u007f\u0085\r\n\t\u00a3");
        check(b[0] == 27 && b[1] == '@', "initialize");
        check(b[2] == 'A' && b[3] == 10 && b[4] == 9 && (b[5] & 255) == 156,
                "sanitized CP437 text");
        check(b.length == 12 && b[6] == 10 && b[7] == 10 && b[8] == 10
                && b[9] == 29 && b[10] == 'V' && b[11] == 0, "feed and full cut");
    }

    private static void offline() throws Exception {
        Fixture f = new Fixture();
        f.offline = true;
        fails(() -> f.engine().tick());
        check(f.claims == 0 && f.sends == 0 && f.records.isEmpty(), "offline never claims");
    }

    private static void failedSend() throws Exception {
        Fixture f = new Fixture();
        f.failSend = true;
        f.engine().tick();
        f.engine().tick();
        check(f.sends == 1 && f.acknowledgements.equals(List.of("7:false")), "no partial retry");
    }

    private static void lostAcknowledgement() throws Exception {
        Fixture f = new Fixture();
        f.loseAck = true;
        fails(() -> f.engine().tick());
        check(Boolean.TRUE.equals(f.records.get(7L)) && f.owned.isEmpty(), "lost ack persisted");
        f.engine().tick();
        check(f.sends == 1 && f.acknowledgements.equals(List.of("7:true", "7:true")),
                "done acknowledgement retried without bytes");
    }

    private static void recoveredClaims() throws Exception {
        Fixture f = new Fixture();
        f.next = null;
        f.records.put(1L, true);
        f.records.put(2L, false);
        f.owned.add(new PrinterEngine.Job(1, "PRIVATE"));
        f.owned.add(new PrinterEngine.Job(2, "PRIVATE"));
        f.owned.add(new PrinterEngine.Job(3, "PRIVATE"));
        f.engine().tick();
        check(f.sends == 0 && f.records.isEmpty(), "crash recovery never sends");
        check(f.acknowledgements.equals(List.of("1:true", "2:false", "3:false")),
                "known true done, false and unknown failed");
    }

    private static void persistenceBeforeSend() throws Exception {
        Fixture f = new Fixture();
        f.failFalseSave = true;
        fails(() -> f.engine().tick());
        check(f.sends == 0 && f.acknowledgements.isEmpty(), "no send without persistence");
        f.failFalseSave = false;
        f.engine().tick();
        check(f.sends == 0 && f.acknowledgements.equals(List.of("7:false")), "unknown fails closed");
    }

    private static void persistenceAfterSend() throws Exception {
        Fixture f = new Fixture();
        f.failTrueSave = true;
        fails(() -> f.engine().tick());
        check(f.sends == 1 && Boolean.FALSE.equals(f.records.get(7L)), "false retained after send");
        f.failTrueSave = false;
        f.engine().tick();
        check(f.sends == 1 && f.acknowledgements.equals(List.of("7:false")), "never resend uncertain");
    }

    private static void lostClaim() throws Exception {
        Fixture f = new Fixture();
        f.loseClaim = true;
        fails(() -> f.engine().tick());
        f.engine().tick();
        check(f.sends == 0 && f.acknowledgements.equals(List.of("7:false")), "lost claim fails closed");
    }

    private static void failedRemoval() throws Exception {
        Fixture f = new Fixture();
        f.failRemove = true;
        fails(() -> f.engine().tick());
        f.failRemove = false;
        f.engine().tick();
        check(f.sends == 1 && f.records.isEmpty()
                && f.acknowledgements.equals(List.of("7:true", "7:true")), "remove failure ack only");
    }

    private static void failedSendAndAck() throws Exception {
        Fixture f = new Fixture();
        f.failSend = true;
        f.loseAck = true;
        fails(() -> f.engine().tick());
        check(Boolean.FALSE.equals(f.records.get(7L)), "failed ack leaves false");
        f.engine().tick();
        check(f.sends == 1 && f.acknowledgements.equals(List.of("7:false", "7:false")),
                "failed ack retries without bytes");
    }
}
