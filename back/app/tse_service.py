"""German TSE (KassenSichV) transaction signing — preparation path.

Prefer cloud certified TSE for SaaS (see docs/0072-tse-fiscal-compliance.md).
Local stub signatures are for test mode only; live is gated. Separate from VeriFactu.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import urlencode

from fastapi import HTTPException
from sqlmodel import Session, col, select

from app import models
from app.fiscal_invoice_service import order_fiscal_amount_cents
from app.settings import settings
from app.tse_providers import LIVE_OK_STATUSES, live_credentials_ready, sign_tse_transaction

logger = logging.getLogger(__name__)

STUB_SCHEMA = "pos.tse.stub.v1"
DSFINVK_SCHEMA = "pos.dsfinvk.stub.v1"

_PAID_STATUSES = frozenset(
    {
        models.OrderStatus.paid,
        models.OrderStatus.completed,
    }
)


def live_mode_allowed() -> bool:
    unlock = bool(getattr(settings, "tse_live_unlock", False))
    return unlock and live_credentials_ready()


def assert_tse_mode_allowed(mode: str) -> None:
    if mode == "live" and not live_mode_allowed():
        raise HTTPException(
            status_code=400,
            detail=(
                "tse_mode live is blocked until TSE_LIVE_UNLOCK=true and "
                "certified TSE provider credentials are ready "
                "(TSE_PROVIDER=fiskaly_sign_de|generic|mock; "
                "see docs/0072-tse-fiscal-compliance.md and docs/0074-fiscal-certified-middleware.md)"
            ),
        )


def tse_enabled(tenant: models.Tenant) -> bool:
    mode = (getattr(tenant, "tse_mode", None) or "off").strip().lower()
    return mode in ("test", "live")


def get_sale_tse(
    session: Session, tenant_id: int, order_id: int
) -> models.TseTransaction | None:
    return session.exec(
        select(models.TseTransaction).where(
            models.TseTransaction.tenant_id == tenant_id,
            models.TseTransaction.order_id == order_id,
            models.TseTransaction.process_type == "sale",
        )
    ).first()


def get_latest_tse(
    session: Session, tenant_id: int, order_id: int
) -> models.TseTransaction | None:
    return session.exec(
        select(models.TseTransaction)
        .where(
            models.TseTransaction.tenant_id == tenant_id,
            models.TseTransaction.order_id == order_id,
        )
        .order_by(models.TseTransaction.id.desc())
    ).first()


def _tenant_serial(tenant: models.Tenant) -> str:
    raw = (getattr(tenant, "tse_serial_number", None) or "").strip()
    if raw:
        return raw[:128]
    # Deterministic stub serial for test — not a BSI-certified device id
    return f"STUB-TSE-T{tenant.id}"


def _canonical_stub_payload(
    *,
    tenant_id: int,
    order_id: int,
    process_type: str,
    amount_cents: int,
    counter: int,
    serial: str,
    time_start: datetime,
) -> str:
    ts = time_start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = {
        "schema": STUB_SCHEMA,
        "tenant_id": tenant_id,
        "order_id": order_id,
        "process_type": process_type,
        "amount_cents": amount_cents,
        "signature_counter": counter,
        "tse_serial": serial,
        "time_start": ts,
    }
    return json.dumps(body, sort_keys=True, separators=(",", ":"))


def _stub_sign(
    *,
    tenant_id: int,
    order_id: int,
    process_type: str,
    amount_cents: int,
    counter: int,
    serial: str,
    time_start: datetime,
) -> str:
    raw = _canonical_stub_payload(
        tenant_id=tenant_id,
        order_id=order_id,
        process_type=process_type,
        amount_cents=amount_cents,
        counter=counter,
        serial=serial,
        time_start=time_start,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _build_qr_content(
    *,
    serial: str,
    counter: int,
    signature: str,
    time_start: datetime,
    amount_cents: int,
    process_type: str,
) -> str:
    """KassenSichV-oriented QR payload shape (stub). Real providers supply official format."""
    ts = time_start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return urlencode(
        {
            "v": "SatisfechoTSEStub1",
            "sig": signature[:64],
            "sn": serial,
            "c": str(counter),
            "t": ts,
            "a": f"{amount_cents / 100:.2f}",
            "p": process_type,
        }
    )


def tse_transaction_public_dict(row: models.TseTransaction) -> dict[str, Any]:
    return {
        "id": row.id,
        "order_id": row.order_id,
        "process_type": row.process_type,
        "mode": row.mode,
        "tse_serial": row.tse_serial,
        "signature_counter": row.signature_counter,
        "signature_value": row.signature_value,
        "qr_content": row.qr_content,
        "process_data": row.process_data,
        "transaction_number": row.transaction_number,
        "certificate_serial": row.certificate_serial,
        "time_start": row.time_start.isoformat() if row.time_start else None,
        "time_end": row.time_end.isoformat() if row.time_end else None,
        "amount_cents": row.amount_cents,
        "submission_status": row.submission_status,
        "storno_of_tse_transaction_id": row.storno_of_tse_transaction_id,
        "disclaimer": (
            "TSE record via configured provider - not a claim of BSI certification by Scanaki alone. "
            "See docs/0072-tse-fiscal-compliance.md and docs/0074-fiscal-certified-middleware.md"
        ),
    }


def receipt_fields_dict(row: models.TseTransaction | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "tse_serial": row.tse_serial,
        "signature_counter": row.signature_counter,
        "signature_value": row.signature_value,
        "qr_content": row.qr_content,
        "time_start": row.time_start.isoformat() if row.time_start else None,
        "time_end": row.time_end.isoformat() if row.time_end else None,
        "process_type": row.process_type,
        "transaction_number": row.transaction_number,
    }


def _allocate_counter(session: Session, tenant: models.Tenant) -> tuple[models.Tenant, int]:
    locked = session.exec(
        select(models.Tenant).where(models.Tenant.id == tenant.id).with_for_update()
    ).first()
    if not locked:
        raise HTTPException(status_code=404, detail="Tenant not found")
    counter = int(getattr(locked, "tse_signature_counter", None) or 1)
    locked.tse_signature_counter = counter + 1
    if not (getattr(locked, "tse_serial_number", None) or "").strip():
        locked.tse_serial_number = _tenant_serial(locked)
    session.add(locked)
    session.flush()
    return locked, counter


def issue_or_get_sale(
    session: Session,
    tenant: models.Tenant,
    order: models.Order,
) -> models.TseTransaction | None:
    """Create or return TSE sale for a paid order when tse_mode is test/live. No-op if off."""
    mode = (getattr(tenant, "tse_mode", None) or "off").strip().lower()
    if mode == "off":
        return None
    if mode not in ("test", "live"):
        raise HTTPException(status_code=400, detail="Invalid tse_mode")
    if mode == "live":
        assert_tse_mode_allowed("live")

    existing = get_sale_tse(session, tenant.id, order.id)  # type: ignore[arg-type]
    if existing:
        return existing

    if order.status not in _PAID_STATUSES and not order.paid_at:
        raise HTTPException(
            status_code=400,
            detail="Order must be paid or completed before TSE sale signing",
        )
    if order.status == models.OrderStatus.cancelled:
        raise HTTPException(status_code=400, detail="Cannot sign TSE sale for cancelled order")

    amount = order_fiscal_amount_cents(session, order)
    now = datetime.now(timezone.utc)
    tenant_locked, counter = _allocate_counter(session, tenant)
    serial = _tenant_serial(tenant_locked)
    signature = _stub_sign(
        tenant_id=tenant_locked.id,  # type: ignore[arg-type]
        order_id=order.id,  # type: ignore[arg-type]
        process_type="sale",
        amount_cents=amount,
        counter=counter,
        serial=serial,
        time_start=now,
    )
    qr = _build_qr_content(
        serial=serial,
        counter=counter,
        signature=signature,
        time_start=now,
        amount_cents=amount,
        process_type="sale",
    )
    process_data = f"Beleg^0.00_0.00_0.00_0.00_{amount / 100:.2f}^Bar"
    cert_serial = f"CERT-STUB-{serial}"[:128]

    req = {
        "schema": STUB_SCHEMA,
        "process_type": "sale",
        "order_id": order.id,
        "amount_cents": amount,
        "tse_serial": serial,
        "signature_counter": counter,
    }
    provider = sign_tse_transaction(
        {
            **req,
            "tenant_id": tenant_locked.id,
            "client_id": getattr(tenant_locked, "tse_client_id", None),
            "mode": mode,
        },
        tenant_locked,
        mode=mode,
    )
    if provider.get("signature"):
        signature = str(provider["signature"])[:512]
    if provider.get("qr_content"):
        qr = str(provider["qr_content"])[:2000]
    if provider.get("tse_serial"):
        serial = str(provider["tse_serial"])[:128]
    if provider.get("certificate_serial"):
        cert_serial = str(provider["certificate_serial"])[:128]
    if provider.get("signature_counter") is not None:
        counter = int(provider["signature_counter"])

    status = str(provider.get("status") or "local_stub")
    if mode == "live" and status not in LIVE_OK_STATUSES:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Certified TSE provider rejected or unreachable live signing "
                f"(status={status}). Fix TSE credentials / connectivity and retry. "
                f"See docs/0074-fiscal-certified-middleware.md"
            ),
        )

    submission = "local_stub"
    if provider.get("channel") in ("provider", "mock", "fiskaly_sign_de"):
        submission = status

    row = models.TseTransaction(
        tenant_id=tenant_locked.id,  # type: ignore[arg-type]
        order_id=order.id,  # type: ignore[arg-type]
        process_type="sale",
        mode=mode,
        tse_serial=serial,
        signature_counter=counter,
        signature_value=signature,
        qr_content=qr,
        process_data=process_data,
        transaction_number=counter,
        certificate_serial=cert_serial,
        time_start=now,
        time_end=now,
        amount_cents=amount,
        request_payload=req,
        response_payload=provider,
        submission_status=submission,
    )
    session.add(row)
    session.flush()
    return row


def issue_storno_for_sale(
    session: Session,
    tenant: models.Tenant,
    order: models.Order,
) -> models.TseTransaction | None:
    """Create storno when undoing a paid order that had a TSE sale. No-op if TSE off or no sale."""
    mode = (getattr(tenant, "tse_mode", None) or "off").strip().lower()
    if mode not in ("test", "live"):
        return None
    if mode == "live":
        assert_tse_mode_allowed("live")

    sale = get_sale_tse(session, tenant.id, order.id)  # type: ignore[arg-type]
    if not sale:
        return None

    existing_storno = session.exec(
        select(models.TseTransaction).where(
            models.TseTransaction.tenant_id == tenant.id,
            models.TseTransaction.storno_of_tse_transaction_id == sale.id,
            models.TseTransaction.process_type == "storno",
        )
    ).first()
    if existing_storno:
        return existing_storno

    amount = int(sale.amount_cents or 0)
    now = datetime.now(timezone.utc)
    tenant_locked, counter = _allocate_counter(session, tenant)
    serial = _tenant_serial(tenant_locked)
    signature = _stub_sign(
        tenant_id=tenant_locked.id,  # type: ignore[arg-type]
        order_id=order.id,  # type: ignore[arg-type]
        process_type="storno",
        amount_cents=amount,
        counter=counter,
        serial=serial,
        time_start=now,
    )
    qr = _build_qr_content(
        serial=serial,
        counter=counter,
        signature=signature,
        time_start=now,
        amount_cents=amount,
        process_type="storno",
    )
    cert_serial = f"CERT-STUB-{serial}"[:128]
    req = {
        "schema": STUB_SCHEMA,
        "process_type": "storno",
        "order_id": order.id,
        "storno_of": sale.id,
        "amount_cents": amount,
        "signature_counter": counter,
    }
    provider = sign_tse_transaction(
        {**req, "tenant_id": tenant_locked.id, "mode": mode},
        tenant_locked,
        mode=mode,
    )
    if provider.get("signature"):
        signature = str(provider["signature"])[:512]
    if provider.get("qr_content"):
        qr = str(provider["qr_content"])[:2000]
    if provider.get("tse_serial"):
        serial = str(provider["tse_serial"])[:128]
    if provider.get("certificate_serial"):
        cert_serial = str(provider["certificate_serial"])[:128]

    status = str(provider.get("status") or "local_stub")
    if mode == "live" and status not in LIVE_OK_STATUSES:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Certified TSE provider rejected or unreachable live storno "
                f"(status={status}). See docs/0074-fiscal-certified-middleware.md"
            ),
        )

    submission = "local_stub"
    if provider.get("channel") in ("provider", "mock", "fiskaly_sign_de"):
        submission = status

    row = models.TseTransaction(
        tenant_id=tenant_locked.id,  # type: ignore[arg-type]
        order_id=order.id,  # type: ignore[arg-type]
        process_type="storno",
        mode=mode,
        tse_serial=serial,
        signature_counter=counter,
        signature_value=signature,
        qr_content=qr,
        process_data=f"Storno^{sale.transaction_number}",
        transaction_number=counter,
        certificate_serial=cert_serial,
        time_start=now,
        time_end=now,
        amount_cents=amount,
        request_payload=req,
        response_payload=provider,
        submission_status=submission,
        storno_of_tse_transaction_id=sale.id,
    )
    session.add(row)
    session.flush()
    return row


def maybe_sign_sale_after_paid(session: Session, order: models.Order) -> None:
    """Best-effort TSE sale after order reaches paid. Logs and swallows errors to not block payment."""
    try:
        tenant = session.get(models.Tenant, order.tenant_id)
        if not tenant or not tse_enabled(tenant):
            return
        issue_or_get_sale(session, tenant, order)
        session.commit()
    except HTTPException:
        logger.warning("TSE sale skipped for order_id=%s", order.id, exc_info=True)
        session.rollback()
    except Exception:
        logger.exception("TSE sale failed for order_id=%s", order.id)
        try:
            session.rollback()
        except Exception:
            pass


def maybe_sign_storno_after_unmark(session: Session, order: models.Order) -> None:
    try:
        tenant = session.get(models.Tenant, order.tenant_id)
        if not tenant or not tse_enabled(tenant):
            return
        issue_storno_for_sale(session, tenant, order)
        session.commit()
    except HTTPException:
        logger.warning("TSE storno skipped for order_id=%s", order.id, exc_info=True)
        session.rollback()
    except Exception:
        logger.exception("TSE storno failed for order_id=%s", order.id)
        try:
            session.rollback()
        except Exception:
            pass


def dsfinvk_export_stub(
    session: Session,
    tenant: models.Tenant,
    from_date: date,
    to_date: date,
) -> dict[str, Any]:
    """Date-range export stub for audit. Not a complete official DSFinV-K ZIP package."""
    if from_date > to_date:
        raise HTTPException(status_code=400, detail="from must be on or before to")
    start = datetime(from_date.year, from_date.month, from_date.day, tzinfo=timezone.utc)
    end = datetime(to_date.year, to_date.month, to_date.day, 23, 59, 59, tzinfo=timezone.utc)
    rows = list(
        session.exec(
            select(models.TseTransaction)
            .where(models.TseTransaction.tenant_id == tenant.id)
            .where(models.TseTransaction.time_start >= start)
            .where(models.TseTransaction.time_start <= end)
            .order_by(col(models.TseTransaction.time_start), col(models.TseTransaction.id))
        ).all()
    )
    return {
        "schema": DSFINVK_SCHEMA,
        "disclaimer": (
            "Stub DSFinV-K-oriented export — not a certified DSFinV-K package. "
            "Have a German tax advisor review before relying on this for audits."
        ),
        "tenant_id": tenant.id,
        "fiscal_country": getattr(tenant, "fiscal_country", None),
        "tse_mode": getattr(tenant, "tse_mode", "off"),
        "tse_serial": _tenant_serial(tenant),
        "from": from_date.isoformat(),
        "to": to_date.isoformat(),
        "transactions": [tse_transaction_public_dict(r) for r in rows],
        "count": len(rows),
    }
