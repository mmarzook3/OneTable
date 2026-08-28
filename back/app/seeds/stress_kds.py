"""Controlled KDS capacity test with explicit tenant confirmation.

Run inside the backend container. The tool never creates orders; status-update stages are
restricted to rows whose idempotency key starts with Scanaki's stress-test prefixes.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import timedelta
import json
import statistics
import time
from uuid import uuid4

import httpx
from sqlmodel import Session, select

from app import models, security
from app.db import engine
from app.kds_feed_cache import invalidate_kds_feed


STRESS_PREFIXES = ("scanaki-load30-", "scanaki-load100-", "scanaki-stress-")


def _p95(values: list[int]) -> int:
    ordered = sorted(values)
    return ordered[max(0, int(len(ordered) * 0.95) - 1)] if ordered else 0


async def _request(client: httpx.AsyncClient, method: str, path: str, **kwargs) -> dict:
    started = time.perf_counter()
    try:
        response = await client.request(method, path, **kwargs)
        return {
            "status": response.status_code,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "bytes": len(response.content),
        }
    except Exception as exc:
        return {
            "status": 0,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "error": f"{type(exc).__name__}: {exc}",
            "bytes": 0,
        }


def _summary(rows: list[dict]) -> dict:
    statuses: dict[int, int] = {}
    for row in rows:
        statuses[row["status"]] = statuses.get(row["status"], 0) + 1
    durations = [int(row["duration_ms"]) for row in rows]
    return {
        "count": len(rows),
        "statuses": statuses,
        "median_ms": round(statistics.median(durations)) if durations else 0,
        "p95_ms": _p95(durations),
        "max_ms": max(durations, default=0),
        "max_bytes": max((int(row.get("bytes", 0)) for row in rows), default=0),
    }


async def _run(args: argparse.Namespace) -> dict:
    with Session(engine) as session:
        tenant = session.get(models.Tenant, args.tenant_id)
        if tenant is None or tenant.name != args.confirm_tenant_name:
            raise SystemExit("Tenant confirmation did not match; refusing stress test")
        user = session.exec(
            select(models.User).where(
                models.User.tenant_id == tenant.id,
                models.User.role == models.UserRole.kitchen,
            )
        ).first()
        device = session.exec(
            select(models.KitchenDevice)
            .where(
                models.KitchenDevice.tenant_id == tenant.id,
                models.KitchenDevice.revoked_at.is_(None),
            )
            .order_by(models.KitchenDevice.last_seen_at.desc())
        ).first()
        stress_orders = session.exec(
            select(models.Order)
            .where(
                models.Order.tenant_id == tenant.id,
                models.Order.deleted_at.is_(None),
                models.Order.public_idempotency_key.is_not(None),
            )
            .order_by(models.Order.id)
        ).all()
        stress_order_ids = [
            row.id
            for row in stress_orders
            if row.id is not None
            and any((row.public_idempotency_key or "").startswith(prefix) for prefix in STRESS_PREFIXES)
        ][: args.status_orders]
    if user is None or device is None:
        raise SystemExit("Kitchen user/device is required")

    token = security.create_access_token(
        {
            "sub": user.email,
            "tenant_id": user.tenant_id,
            "provider_id": None,
            "token_version": user.token_version,
        },
        expires_delta=timedelta(minutes=30),
    )
    prefix = args.api_prefix.rstrip("/")
    feed_path = f"{prefix}/orders/kitchen-feed"
    heartbeat_path = f"{prefix}/tenant/kitchen-devices/pulse"
    status_path = lambda order_id: f"{prefix}/orders/{order_id}/kitchen-status"
    run_key = uuid4().hex[:12]
    heartbeat_payloads = [
        {
            "device_key": f"stress_{args.tenant_id}_{run_key}_{index:02d}",
            "name": f"Capacity test device {index + 1}",
            "display_route": "kitchen",
        }
        for index in range(args.heartbeats)
    ]
    report: dict = {
        "tenant_id": args.tenant_id,
        "tenant_name": args.confirm_tenant_name,
        "base_url": args.base_url,
        "tiers": [],
        "status_order_count": len(stress_order_ids),
    }
    limits = httpx.Limits(max_connections=max(args.tiers) + args.heartbeats + 20)
    async with httpx.AsyncClient(
        base_url=args.base_url.rstrip("/"),
        headers={"Authorization": f"Bearer {token}"},
        timeout=args.timeout,
        limits=limits,
    ) as client:
        for tier in args.tiers:
            # Each tier models all displays reconnecting immediately after an
            # order update, not an artificially warm-cache happy path.
            invalidate_kds_feed(args.tenant_id)
            rows = await asyncio.gather(
                *[_request(client, "GET", feed_path) for _ in range(tier)],
                *[
                    _request(client, "POST", heartbeat_path, json=payload)
                    for payload in heartbeat_payloads
                ],
            )
            feed_rows = rows[:tier]
            heartbeat_rows = rows[tier:]
            report["tiers"].append(
                {
                    "concurrency": tier,
                    "feed": _summary(feed_rows),
                    "heartbeat": _summary(heartbeat_rows),
                }
            )
            await asyncio.sleep(args.tier_pause)

        if stress_order_ids:
            mixed = await asyncio.gather(
                *[
                    _request(
                        client,
                        "PUT",
                        status_path(order_id),
                        json={"status": "preparing"},
                    )
                    for order_id in stress_order_ids
                ],
                *[_request(client, "GET", feed_path) for _ in range(args.mixed_feeds)],
                *[
                    _request(client, "POST", heartbeat_path, json=payload)
                    for payload in heartbeat_payloads
                ],
            )
            update_count = len(stress_order_ids)
            report["mixed"] = {
                "updates": _summary(mixed[:update_count]),
                "feeds": _summary(mixed[update_count : update_count + args.mixed_feeds]),
                "heartbeats": _summary(mixed[update_count + args.mixed_feeds :]),
            }
            await asyncio.gather(
                *[
                    _request(
                        client,
                        "PUT",
                        status_path(order_id),
                        json={"status": "pending"},
                    )
                    for order_id in stress_order_ids
                ]
            )

    with Session(engine) as session:
        temporary_keys = [payload["device_key"] for payload in heartbeat_payloads]
        temporary_devices = session.exec(
            select(models.KitchenDevice).where(
                models.KitchenDevice.tenant_id == args.tenant_id,
                models.KitchenDevice.device_key.in_(temporary_keys),
            )
        ).all()
        for row in temporary_devices:
            session.delete(row)
        session.commit()

    failures: list[str] = []
    for row in report["tiers"]:
        if set(row["feed"]["statuses"]) != {200}:
            failures.append(f"feed tier {row['concurrency']} returned non-200")
        if set(row["heartbeat"]["statuses"]) != {200}:
            failures.append(f"heartbeat tier {row['concurrency']} returned non-200")
        if row["feed"]["p95_ms"] > args.max_feed_p95_ms:
            failures.append(f"feed tier {row['concurrency']} p95 exceeded threshold")
        if row["heartbeat"]["p95_ms"] > args.max_heartbeat_p95_ms:
            failures.append(f"heartbeat tier {row['concurrency']} p95 exceeded threshold")
    if report.get("mixed"):
        for key, threshold in (
            ("updates", args.max_status_p95_ms),
            ("feeds", args.max_feed_p95_ms),
            ("heartbeats", args.max_heartbeat_p95_ms),
        ):
            row = report["mixed"][key]
            if set(row["statuses"]) != {200} or row["p95_ms"] > threshold:
                failures.append(f"mixed {key} failed status/latency threshold")
    report["failures"] = failures
    report["passed"] = not failures
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--tenant-id", type=int, required=True)
    parser.add_argument("--confirm-tenant-name", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8020")
    parser.add_argument("--api-prefix", default="")
    parser.add_argument("--tiers", default="5,10,20,30")
    parser.add_argument("--heartbeats", type=int, default=5)
    parser.add_argument("--status-orders", type=int, default=30)
    parser.add_argument("--mixed-feeds", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--tier-pause", type=float, default=1)
    parser.add_argument("--max-feed-p95-ms", type=int, default=2500)
    parser.add_argument("--max-heartbeat-p95-ms", type=int, default=1000)
    parser.add_argument("--max-status-p95-ms", type=int, default=2000)
    args = parser.parse_args()
    if not args.apply:
        raise SystemExit("--apply is required")
    args.tiers = [int(value) for value in args.tiers.split(",") if value.strip()]
    report = asyncio.run(_run(args))
    print(json.dumps(report, indent=2, sort_keys=True))
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
