# Scanaki KDS capacity and resilience report

Date: 28 August 2026  
Production release tested: `fa617e913`  
Pilot tenant: The Yew Trees Pub  
Host: 2 vCPU, 7.8 GiB RAM

## Supported MVP capacity

The supported Scanaki MVP target is:

- 100 simultaneously active orders in one tenant;
- a 161 KB Kitchen display snapshot;
- 30 Kitchen display clients reconnecting at the same time;
- 30 simultaneous atomic order-status changes, 10 feed refreshes and 5 heartbeat pulses;
- one Kitchen action for an entire order, regardless of the number of line items.

The production test passed every supported threshold with HTTP 200 responses only:

| Cold-start displays | Feed p95 | Heartbeat p95 | Result |
|---:|---:|---:|---|
| 5 | 166 ms | 123 ms | Pass |
| 10 | 163 ms | 154 ms | Pass |
| 20 | 191 ms | 185 ms | Pass |
| 30 | 221 ms | 210 ms | Pass |

The realistic mixed workload also passed:

| Operation | Concurrency | p95 | Result |
|---|---:|---:|---|
| Atomic order status | 30 | 1,192 ms | Pass |
| KDS feed refresh | 10 | 1,297 ms | Pass |
| Priority heartbeat pulse | 5 | 844 ms | Pass |

## Tested headroom

The same 100-order, cold-cache production test was deliberately pushed beyond the MVP
support target. All requests still returned HTTP 200:

| Cold-start displays | Feed p95 | Heartbeat p95 | Result |
|---:|---:|---:|---|
| 50 | 477 ms | 418 ms | Pass |
| 75 | 1,001 ms | 936 ms | Pass |
| 100 | 1,118 ms | 1,075 ms | Functional headroom |

One hundred simultaneous displays is a tested resilience ceiling, not the commercial MVP
capacity commitment. It slightly exceeds the one-second heartbeat performance objective and
must be retested after material host, database, authentication or KDS changes.

## Failure discovered and corrected

Before the final fix, a 50-client cold reconnect held all 30 SQL connections while synchronous
cache waiters occupied the application thread pool. The feed and even the database-free pulse
were then delayed, and abandoned server work continued after client timeouts.

The permanent correction:

1. finishes the read-only authentication transaction before cache waiting;
2. makes cache waiters asynchronous so they do not occupy worker threads;
3. permits one request to build each tenant/limit feed snapshot;
4. lets all concurrent displays reuse that snapshot;
5. invalidates the snapshot immediately on every order update;
6. runs each stress tier with a deliberately cold cache so the harness cannot report a false
   warm-cache result.

## Existing protection and detection

- KDS screens use one atomic order-status API instead of one request per food line.
- Active-order queries are bounded and use a compact Kitchen-only response.
- Heartbeat pulses use signed JWT identity and Redis without consuming a SQL connection.
- The durable heartbeat records gaps and recoveries for Platform diagnostics.
- Three consecutive client pulse failures are required before showing an offline state.
- SQL pool saturation returns HTTP 503 with `Retry-After: 2` and code
  `DATABASE_POOL_BUSY` instead of an unbounded hang.
- Slow and failed requests log request ID, duration, route, client and SQL pool state.
- `/api/health/ready` checks both PostgreSQL and Redis.
- Five-minute operations checks cover containers, public liveness/readiness, payment
  reconciliation, backup age, TLS expiry and disk usage.
- Stopped Scanaki containers are restarted by the health check without touching other Docker
  projects.
- Production deployments are serialised with CI concurrency and a host lock, and refuse to
  build with less than 2 GiB available RAM.

## Regression command

Run only with an explicitly confirmed test tenant. The tool does not create orders and only
changes status on orders bearing a recognised Scanaki stress-test idempotency prefix.

```bash
docker compose --env-file config.env -f docker-compose.scanaki.yml exec -T back \
  python -m app.seeds.stress_kds \
  --apply \
  --tenant-id 1 \
  --confirm-tenant-name "The Yew Trees Pub" \
  --base-url http://127.0.0.1:8020
```

Acceptance thresholds are feed p95 at or below 2,500 ms, heartbeat p95 at or below 1,000 ms,
status-update p95 at or below 2,000 ms, and no non-200 response. Any failure produces a
non-zero exit code.

## Test-data disposition

After the test, all 100 active rows were verified as explicitly labelled simulation data. They
were moved through the normal completed/delivered state rather than deleted, preserving the
audit trail. The production tenant finished with zero active simulated orders.
