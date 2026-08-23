"""Read-only Scanaki payment/kitchen integrity check for monitoring and deploys."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlmodel import Session

from app.db import engine


def run() -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=15)
    with Session(engine) as session:
        rows = session.execute(
            text(
                """
                SELECT id, payment_state, paid_at, kitchen_released_at
                FROM "order"
                WHERE requires_prepayment = true
                  AND deleted_at IS NULL
                  AND (
                    (payment_state = 'succeeded' AND (paid_at IS NULL OR kitchen_released_at IS NULL))
                    OR (kitchen_released_at IS NOT NULL AND (paid_at IS NULL OR payment_state <> 'succeeded'))
                    OR (payment_state IN ('created', 'awaiting_payment', 'processing')
                        AND created_at < :cutoff)
                  )
                ORDER BY id
                """
            ),
            {"cutoff": cutoff},
        ).fetchall()
    if rows:
        print("Payment reconciliation requires attention:", file=sys.stderr)
        for row in rows:
            print(
                f"order={row[0]} state={row[1]} paid_at={row[2]} released_at={row[3]}",
                file=sys.stderr,
            )
        raise SystemExit(1)
    print("Payment reconciliation OK")


if __name__ == "__main__":
    run()
