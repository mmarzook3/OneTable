package uk.scanaki.kitchen;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Conservative, at-most-once byte submission. A successful socket write is not
 * proof of physical printing. An interrupted or uncertain submission fails closed.
 * Use one engine and one durable journal per cloud agent; do not run competing ticks.
 */
public final class PrinterEngine {
    public interface Queue {
        /** Only jobs already claimed by this agent. */
        List<Job> claimed() throws Exception;
        /** Claims at most one job; null means no work. */
        Job claim() throws Exception;
        /** Must tolerate a repeated acknowledgement after a lost response. */
        void complete(long id, boolean done) throws Exception;
    }

    public interface Transport {
        /** Checks availability without submitting ticket bytes. */
        void probe() throws Exception;
        /** One submission only; implementations must not retry partial writes. */
        void send(byte[] data) throws Exception;
    }

    public interface Journal {
        /** IDs and send outcomes only, never ticket text. */
        Map<Long, Boolean> pending() throws Exception;
        /** Atomic durable replacement; false denotes uncertain/not confirmed sent. */
        void save(long id, boolean sent) throws Exception;
        /** Durable removal, only after a successful acknowledgement. */
        void remove(long id) throws Exception;
    }

    public interface Status {
        void update(String text);
    }

    public static final class Job {
        public final long id;
        public final String text;

        public Job(long id, String text) {
            this.id = id;
            this.text = Objects.requireNonNull(text, "text");
        }
    }

    private final Queue queue;
    private final Transport transport;
    private final Journal journal;
    private final Status status;

    public PrinterEngine(Queue queue, Transport transport, Journal journal, Status status) {
        this.queue = Objects.requireNonNull(queue, "queue");
        this.transport = Objects.requireNonNull(transport, "transport");
        this.journal = Objects.requireNonNull(journal, "journal");
        this.status = Objects.requireNonNull(status, "status");
    }

    public synchronized void tick() throws Exception {
        try {
            // Never render or send recovered jobs, even when their payload is available.
            Map<Long, Boolean> pending = new LinkedHashMap<>(journal.pending());
            for (Job job : queue.claimed()) {
                if (!pending.containsKey(job.id)) {
                    journal.save(job.id, false);
                    pending.put(job.id, false);
                }
            }
            for (Map.Entry<Long, Boolean> entry : pending.entrySet()) {
                status.update("Recovering printer acknowledgement");
                acknowledge(entry.getKey(), Boolean.TRUE.equals(entry.getValue()));
            }

            // Do not claim new cloud work while the local printer is unreachable.
            status.update("Checking printer connection");
            transport.probe();
            Job job = queue.claim();
            if (job == null) {
                status.update("Printer ready");
                return;
            }

            journal.save(job.id, false);
            byte[] data = render(job.text);
            status.update("Sending ticket");
            try {
                transport.send(data);
            } catch (Exception sendFailure) {
                // Partial writes are possible: never retry the bytes.
                status.update("Ticket delivery uncertain; manual reprint may be needed");
                acknowledge(job.id, false);
                return;
            }

            // If this fails, keep the durable false marker and fail closed on recovery.
            journal.save(job.id, true);
            acknowledge(job.id, true);
            status.update("Ticket sent to printer");
        } catch (Exception failure) {
            status.update("Printer unavailable or acknowledgement pending; retrying safely");
            throw failure;
        }
    }

    private void acknowledge(long id, boolean done) throws Exception {
        queue.complete(id, done);
        journal.remove(id);
    }

    /** Removes control characters, including ESC/POS command introducers. */
    public static String sanitize(String text) {
        Objects.requireNonNull(text, "text");
        StringBuilder safe = new StringBuilder(text.length());
        text.codePoints().forEach(codePoint -> {
            if (codePoint == '\n' || codePoint == '\t' || !Character.isISOControl(codePoint)) {
                safe.appendCodePoint(codePoint);
            }
        });
        return safe.toString();
    }

    /** CP437 text with initialize, three feed lines, and GS V 0 full cut. */
    public static byte[] render(String text) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.write(0x1b);
        bytes.write('@');
        byte[] encoded = sanitize(text).getBytes(Charset.forName("IBM437"));
        bytes.write(encoded, 0, encoded.length);
        bytes.write('\n');
        bytes.write('\n');
        bytes.write('\n');
        bytes.write(0x1d);
        bytes.write('V');
        bytes.write(0);
        return bytes.toByteArray();
    }
}
