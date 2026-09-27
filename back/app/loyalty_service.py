"""Club loyalty: earn on paid orders, redeem at checkout, append-only ledger (#327)."""

from __future__ import annotations

import calendar
import secrets
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlmodel import Session, select

from . import models


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _valid_birthday(month: int | None, day: int | None) -> tuple[int, int] | None:
    """Return (month, day) or None if both omitted; raise 400 if invalid/partial."""
    if month is None and day is None:
        return None
    if month is None or day is None:
        raise HTTPException(status_code=400, detail="birthday_month and birthday_day must be set together")
    m, d = int(month), int(day)
    if m < 1 or m > 12 or d < 1 or d > 31:
        raise HTTPException(status_code=400, detail="Invalid birthday month/day")
    # Allow Feb 29; award on Feb 28 in non-leap years.
    max_day = 29 if m == 2 else calendar.monthrange(2024 if m == 2 else 2021, m)[1]
    if d > max_day:
        raise HTTPException(status_code=400, detail="Invalid birthday month/day")
    return m, d


def get_program(session: Session, tenant_id: int) -> models.LoyaltyProgram | None:
    return session.exec(
        select(models.LoyaltyProgram).where(models.LoyaltyProgram.tenant_id == tenant_id)
    ).first()


def get_or_create_program(session: Session, tenant_id: int) -> models.LoyaltyProgram:
    program = get_program(session, tenant_id)
    if program:
        return program
    program = models.LoyaltyProgram(tenant_id=tenant_id)
    session.add(program)
    session.flush()
    return program


def program_to_dict(program: models.LoyaltyProgram) -> dict:
    return {
        "id": program.id,
        "tenant_id": program.tenant_id,
        "enabled": program.enabled,
        "program_name": program.program_name,
        "mode": program.mode,
        "earn_units_per_order": program.earn_units_per_order,
        "redemption_threshold": program.redemption_threshold,
        "reward_discount_cents": program.reward_discount_cents,
        "birthday_bonus_units": int(getattr(program, "birthday_bonus_units", 0) or 0),
        "vip_silver_min_lifetime_units": int(
            getattr(program, "vip_silver_min_lifetime_units", 0) or 0
        ),
        "vip_gold_min_lifetime_units": int(
            getattr(program, "vip_gold_min_lifetime_units", 0) or 0
        ),
        "referral_bonus_units": int(getattr(program, "referral_bonus_units", 0) or 0),
        "referral_invitee_bonus_units": int(
            getattr(program, "referral_invitee_bonus_units", 0) or 0
        ),
        "wallet_passes_enabled": bool(getattr(program, "wallet_passes_enabled", True)),
        "created_at": program.created_at.isoformat() if program.created_at else None,
        "updated_at": program.updated_at.isoformat() if program.updated_at else None,
    }


def vip_tier_for_lifetime(
    program: models.LoyaltyProgram | None,
    lifetime_earn_units: int,
) -> str | None:
    """Return 'gold', 'silver', or None from lifetime earn vs program thresholds.

    VIP uses lifetime earn (positive earn ledger units), not current balance — redeeming
    does not demote. Gold wins when both thresholds are met; 0 disables that tier.
    """
    if not program:
        return None
    lifetime = max(0, int(lifetime_earn_units or 0))
    gold_min = int(getattr(program, "vip_gold_min_lifetime_units", 0) or 0)
    silver_min = int(getattr(program, "vip_silver_min_lifetime_units", 0) or 0)
    if gold_min > 0 and lifetime >= gold_min:
        return "gold"
    if silver_min > 0 and lifetime >= silver_min:
        return "silver"
    return None


def membership_to_dict(
    membership: models.LoyaltyMembership,
    *,
    include_token: bool = False,
    program: models.LoyaltyProgram | None = None,
) -> dict:
    lifetime = int(getattr(membership, "lifetime_earn_units", 0) or 0)
    data = {
        "id": membership.id,
        "tenant_id": membership.tenant_id,
        "program_id": membership.program_id,
        "billing_customer_id": membership.billing_customer_id,
        "display_name": membership.display_name,
        "email": membership.email,
        "phone": membership.phone,
        "balance": membership.balance,
        "lifetime_earn_units": lifetime,
        "vip_tier": vip_tier_for_lifetime(program, lifetime),
        "referral_code": getattr(membership, "referral_code", None),
        "referred_by_membership_id": getattr(membership, "referred_by_membership_id", None),
        "birthday_month": getattr(membership, "birthday_month", None),
        "birthday_day": getattr(membership, "birthday_day", None),
        "birthday_bonus_year": getattr(membership, "birthday_bonus_year", None),
        "joined_at": membership.joined_at.isoformat() if membership.joined_at else None,
        "updated_at": membership.updated_at.isoformat() if membership.updated_at else None,
    }
    if include_token:
        data["member_token"] = membership.member_token
    return data


def ledger_to_dict(entry: models.LoyaltyLedgerEntry) -> dict:
    return {
        "id": entry.id,
        "tenant_id": entry.tenant_id,
        "membership_id": entry.membership_id,
        "entry_type": entry.entry_type,
        "units": entry.units,
        "balance_after": entry.balance_after,
        "order_id": entry.order_id,
        "note": entry.note,
        "created_by_user_id": entry.created_by_user_id,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
    }


def _new_member_token() -> str:
    return secrets.token_urlsafe(24)


def _new_referral_code() -> str:
    return secrets.token_urlsafe(12)[:16]


def _apply_ledger(
    session: Session,
    *,
    membership: models.LoyaltyMembership,
    entry_type: str,
    units: int,
    order_id: int | None = None,
    note: str | None = None,
    created_by_user_id: int | None = None,
) -> models.LoyaltyLedgerEntry:
    """Append a ledger row and update cached balance. `units` is signed (earn +, redeem -)."""
    new_balance = membership.balance + units
    if new_balance < 0:
        raise HTTPException(status_code=400, detail="Loyalty balance cannot go negative")
    membership.balance = new_balance
    # Lifetime earn tracks positive earn only (VIP); redeem/adjust do not change it.
    if entry_type == "earn" and units > 0:
        membership.lifetime_earn_units = int(getattr(membership, "lifetime_earn_units", 0) or 0) + units
    membership.updated_at = _now()
    entry = models.LoyaltyLedgerEntry(
        tenant_id=membership.tenant_id,
        membership_id=membership.id,  # type: ignore[arg-type]
        entry_type=entry_type,
        units=units,
        balance_after=new_balance,
        order_id=order_id,
        note=note,
        created_by_user_id=created_by_user_id,
    )
    session.add(membership)
    session.add(entry)
    session.flush()
    # Best-effort wallet push (Apple tag/APNs + Google PATCH); never fail the ledger.
    try:
        from . import loyalty_wallet

        program = session.get(models.LoyaltyProgram, membership.program_id)
        loyalty_wallet.notify_balance_changed(
            session, membership=membership, program=program
        )
    except Exception:
        pass
    return entry


def _find_referrer(
    session: Session,
    *,
    tenant_id: int,
    referral_code: str | None,
) -> models.LoyaltyMembership | None:
    code = (referral_code or "").strip()
    if not code:
        return None
    return session.exec(
        select(models.LoyaltyMembership).where(
            models.LoyaltyMembership.tenant_id == tenant_id,
            models.LoyaltyMembership.referral_code == code,
        )
    ).first()


def _award_referral_on_join(
    session: Session,
    *,
    program: models.LoyaltyProgram,
    invitee: models.LoyaltyMembership,
    referrer: models.LoyaltyMembership,
) -> None:
    """Award referrer (and optional invitee bonus) once for this invitee membership."""
    if invitee.tenant_id != referrer.tenant_id:
        raise HTTPException(status_code=400, detail="Referral must be same restaurant")
    if invitee.id == referrer.id:
        raise HTTPException(status_code=400, detail="Self-referral is not allowed")
    if getattr(invitee, "referral_reward_granted", False):
        return

    note = f"Referral reward for membership {invitee.id}"
    existing = session.exec(
        select(models.LoyaltyLedgerEntry).where(
            models.LoyaltyLedgerEntry.tenant_id == invitee.tenant_id,
            models.LoyaltyLedgerEntry.entry_type == "earn",
            models.LoyaltyLedgerEntry.note == note,
        )
    ).first()
    if existing:
        invitee.referral_reward_granted = True
        session.add(invitee)
        return

    referrer_bonus = int(getattr(program, "referral_bonus_units", 0) or 0)
    invitee_bonus = int(getattr(program, "referral_invitee_bonus_units", 0) or 0)
    if referrer_bonus > 0:
        _apply_ledger(
            session,
            membership=referrer,
            entry_type="earn",
            units=referrer_bonus,
            note=note,
        )
    if invitee_bonus > 0:
        _apply_ledger(
            session,
            membership=invitee,
            entry_type="earn",
            units=invitee_bonus,
            note=f"Referral welcome bonus (from membership {referrer.id})",
        )
    invitee.referral_reward_granted = True
    invitee.referred_by_membership_id = referrer.id
    session.add(invitee)
    session.flush()


def join_program(
    session: Session,
    *,
    tenant_id: int,
    display_name: str,
    email: str | None = None,
    phone: str | None = None,
    billing_customer_id: int | None = None,
    birthday_month: int | None = None,
    birthday_day: int | None = None,
    referral_code: str | None = None,
) -> models.LoyaltyMembership:
    program = get_program(session, tenant_id)
    if not program or not program.enabled:
        raise HTTPException(status_code=404, detail="Loyalty program is not enabled")
    name = (display_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="display_name is required")
    if not email and not phone:
        raise HTTPException(status_code=400, detail="email or phone is required")
    bday = _valid_birthday(birthday_month, birthday_day)
    referrer = _find_referrer(session, tenant_id=tenant_id, referral_code=referral_code)
    if referral_code and (referral_code or "").strip() and not referrer:
        raise HTTPException(status_code=400, detail="Invalid referral code")

    if email:
        existing = session.exec(
            select(models.LoyaltyMembership).where(
                models.LoyaltyMembership.tenant_id == tenant_id,
                models.LoyaltyMembership.email == email,
            )
        ).first()
        if existing:
            if bday and (
                getattr(existing, "birthday_month", None) is None
                or getattr(existing, "birthday_day", None) is None
            ):
                existing.birthday_month, existing.birthday_day = bday
                existing.updated_at = _now()
                session.add(existing)
                session.flush()
            # Returning member: do not award referral again.
            return existing
    if phone:
        existing = session.exec(
            select(models.LoyaltyMembership).where(
                models.LoyaltyMembership.tenant_id == tenant_id,
                models.LoyaltyMembership.phone == phone,
            )
        ).first()
        if existing:
            if bday and (
                getattr(existing, "birthday_month", None) is None
                or getattr(existing, "birthday_day", None) is None
            ):
                existing.birthday_month, existing.birthday_day = bday
                existing.updated_at = _now()
                session.add(existing)
                session.flush()
            return existing

    if referrer and (
        (email and referrer.email and email.lower() == (referrer.email or "").lower())
        or (phone and referrer.phone and phone == referrer.phone)
    ):
        raise HTTPException(status_code=400, detail="Self-referral is not allowed")

    membership = models.LoyaltyMembership(
        tenant_id=tenant_id,
        program_id=program.id,  # type: ignore[arg-type]
        billing_customer_id=billing_customer_id,
        display_name=name[:200],
        email=email,
        phone=phone,
        member_token=_new_member_token(),
        referral_code=_new_referral_code(),
        balance=0,
        lifetime_earn_units=0,
        birthday_month=bday[0] if bday else None,
        birthday_day=bday[1] if bday else None,
        referred_by_membership_id=referrer.id if referrer else None,
    )
    session.add(membership)
    session.flush()

    if referrer and (
        int(getattr(program, "referral_bonus_units", 0) or 0) > 0
        or int(getattr(program, "referral_invitee_bonus_units", 0) or 0) > 0
    ):
        _award_referral_on_join(
            session, program=program, invitee=membership, referrer=referrer
        )
    elif referrer:
        # Track referrer even when bonuses are 0 (settings may enable later — no retro award).
        membership.referral_reward_granted = True
        session.add(membership)
        session.flush()

    return membership


def _is_birthday_today(membership: models.LoyaltyMembership, when: datetime) -> bool:
    month = getattr(membership, "birthday_month", None)
    day = getattr(membership, "birthday_day", None)
    if not month or not day:
        return False
    today = when.astimezone(timezone.utc).date()
    if month == 2 and day == 29 and not calendar.isleap(today.year):
        return today.month == 2 and today.day == 28
    return today.month == month and today.day == day


def _birthday_bonus_pending(
    program: models.LoyaltyProgram,
    membership: models.LoyaltyMembership,
    order: models.Order,
) -> tuple[int, int] | None:
    """Return (bonus_units, year) if a birthday bonus should be awarded; else None."""
    bonus = int(getattr(program, "birthday_bonus_units", 0) or 0)
    if bonus <= 0:
        return None
    paid_at = order.paid_at or _now()
    if not _is_birthday_today(membership, paid_at):
        return None
    year = paid_at.astimezone(timezone.utc).year
    if getattr(membership, "birthday_bonus_year", None) == year:
        return None
    return bonus, year


def maybe_award_birthday_bonus_standalone(
    session: Session,
    *,
    program: models.LoyaltyProgram,
    membership: models.LoyaltyMembership,
    order: models.Order,
) -> models.LoyaltyLedgerEntry | None:
    """Award birthday bonus with order_id=NULL (unique earn-per-order index allows only one earn/order)."""
    pending = _birthday_bonus_pending(program, membership, order)
    if not pending:
        return None
    bonus, year = pending
    note = f"Birthday bonus {year}"
    existing = session.exec(
        select(models.LoyaltyLedgerEntry).where(
            models.LoyaltyLedgerEntry.membership_id == membership.id,
            models.LoyaltyLedgerEntry.entry_type == "earn",
            models.LoyaltyLedgerEntry.note == note,
        )
    ).first()
    if existing:
        membership.birthday_bonus_year = year
        session.add(membership)
        return existing
    entry = _apply_ledger(
        session,
        membership=membership,
        entry_type="earn",
        units=bonus,
        order_id=None,
        note=note,
    )
    membership.birthday_bonus_year = year
    session.add(membership)
    session.flush()
    return entry


def award_on_order_paid(session: Session, order: models.Order) -> models.LoyaltyLedgerEntry | None:
    """Award earn units once per paid order when a membership is linked. Safe to call repeatedly.

    Birthday bonus (once per year) is folded into the same earn row when possible so the
    unique (order_id, earn) index is respected; otherwise awarded as a standalone earn
    with order_id NULL (#327 / #331).
    """
    if not order or not order.id or not order.paid_at:
        return None
    if not order.loyalty_membership_id:
        return None

    program = get_program(session, order.tenant_id)
    if not program or not program.enabled:
        return None

    membership = session.get(models.LoyaltyMembership, order.loyalty_membership_id)
    if not membership or membership.tenant_id != order.tenant_id:
        return None

    # Sync birthday from linked billing customer when membership has none.
    if (
        membership.billing_customer_id
        and getattr(membership, "birthday_month", None) is None
        and getattr(membership, "birthday_day", None) is None
    ):
        bc = session.get(models.BillingCustomer, membership.billing_customer_id)
        if bc and bc.birth_date:
            membership.birthday_month = bc.birth_date.month
            membership.birthday_day = bc.birth_date.day
            session.add(membership)

    existing = session.exec(
        select(models.LoyaltyLedgerEntry).where(
            models.LoyaltyLedgerEntry.order_id == order.id,
            models.LoyaltyLedgerEntry.entry_type == "earn",
        )
    ).first()
    if existing:
        # Earn already recorded for this order; still try standalone birthday if pending.
        maybe_award_birthday_bonus_standalone(
            session, program=program, membership=membership, order=order
        )
        return existing

    units = int(program.earn_units_per_order or 0)
    note = "Auto-earn on paid order"
    pending = _birthday_bonus_pending(program, membership, order)
    if pending:
        bonus, year = pending
        units += bonus
        note = f"Auto-earn on paid order (+ birthday bonus {year})"
        membership.birthday_bonus_year = year
        session.add(membership)

    if units <= 0:
        if pending:
            return maybe_award_birthday_bonus_standalone(
                session, program=program, membership=membership, order=order
            )
        return None

    return _apply_ledger(
        session,
        membership=membership,
        entry_type="earn",
        units=units,
        order_id=order.id,
        note=note,
    )


def redeem_on_order(
    session: Session,
    *,
    order: models.Order,
    membership: models.LoyaltyMembership,
    created_by_user_id: int | None = None,
) -> dict:
    """Redeem one reward on an unpaid order. Sets loyalty_discount_cents (order-level via #322 helper)."""
    if order.tenant_id != membership.tenant_id:
        raise HTTPException(status_code=404, detail="Membership not found")
    from . import guest_payment_service
    guest_payment_service.assert_no_captured(session, order)
    if order.checkout_locked_at is not None:
        raise HTTPException(status_code=409, detail="Cancel the active checkout before changing its discount")
    if order.paid_at or order.status == models.OrderStatus.paid:
        raise HTTPException(status_code=400, detail="Cannot redeem on a paid order")
    if order.loyalty_units_redeemed and order.loyalty_units_redeemed > 0:
        raise HTTPException(status_code=400, detail="Loyalty reward already applied to this order")

    program = get_program(session, order.tenant_id)
    if not program or not program.enabled:
        raise HTTPException(status_code=404, detail="Loyalty program is not enabled")
    if membership.balance < program.redemption_threshold:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient balance (need {program.redemption_threshold})",
        )

    units = -program.redemption_threshold
    _apply_ledger(
        session,
        membership=membership,
        entry_type="redeem",
        units=units,
        order_id=order.id,
        note="Redeem reward at checkout",
        created_by_user_id=created_by_user_id,
    )
    order.loyalty_membership_id = membership.id
    order.loyalty_discount_cents = program.reward_discount_cents
    order.loyalty_units_redeemed = program.redemption_threshold
    session.add(order)
    session.flush()
    return {
        "order_id": order.id,
        "membership_id": membership.id,
        "units_redeemed": program.redemption_threshold,
        "discount_cents": program.reward_discount_cents,
        "balance": membership.balance,
    }


def adjust_balance(
    session: Session,
    *,
    membership: models.LoyaltyMembership,
    delta_units: int,
    note: str | None,
    created_by_user_id: int,
) -> models.LoyaltyLedgerEntry:
    if delta_units == 0:
        raise HTTPException(status_code=400, detail="delta_units must be non-zero")
    return _apply_ledger(
        session,
        membership=membership,
        entry_type="adjust",
        units=delta_units,
        note=(note or "Manual adjustment")[:500],
        created_by_user_id=created_by_user_id,
    )


def wallet_pass_status(program: models.LoyaltyProgram | None = None) -> dict:
    """Operational status for Apple/Google Wallet (certs required; see docs/0066)."""
    from . import loyalty_wallet

    return loyalty_wallet.wallet_pass_status(program)
