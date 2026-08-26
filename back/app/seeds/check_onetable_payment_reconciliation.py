"""Read-only Scanaki payment/kitchen integrity check for monitoring and deploys."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlmodel import Session

from app.db import engine


_RECONCILIATION_SQL = text(
    """
    SELECT id, payment_state, paid_at, kitchen_released_at
    FROM "order"
    WHERE requires_prepayment = true
      AND deleted_at IS NULL
      AND (
        (payment_state IN ('succeeded', 'refunded')
            AND (paid_at IS NULL OR kitchen_released_at IS NULL))
        OR (kitchen_released_at IS NOT NULL
            AND (paid_at IS NULL OR payment_state NOT IN ('succeeded', 'refunded')))
        OR (payment_state IN ('created', 'awaiting_payment', 'processing')
            AND created_at < :cutoff)
      )
    ORDER BY id
    """
)


def reconciliation_issues(
    session: Session,
    *,
    cutoff: datetime | None = None,
) -> list:
    effective_cutoff = cutoff or datetime.now(timezone.utc) - timedelta(minutes=15)
    return list(
        session.execute(
            _RECONCILIATION_SQL,
            {"cutoff": effective_cutoff},
        ).fetchall()
    )


def run() -> None:
    with Session(engine) as session:
        rows = reconciliation_issues(session)
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
