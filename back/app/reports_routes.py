"""
Sales / Revenue Reports API

Uses existing order and order_item data. Only paid/completed orders;
excludes removed and cancelled items. For restaurant owner revenue analysis.
"""

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from io import BytesIO, StringIO
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from . import models
from .db import get_session
from .permissions import Permission, require_permission
from .rate_limits import admin_user_limit
from .report_export_i18n import report_export_labels
from .security import get_current_user
from .work_session_serialization import serialize_work_session

router = APIRouter()

# Order statuses we count as "revenue"
REVENUE_STATUSES = {models.OrderStatus.paid, models.OrderStatus.completed}
# Item statuses we exclude from revenue
EXCLUDED_ITEM_STATUSES = {models.OrderItemStatus.cancelled}


def _revenue_date(order: models.Order) -> datetime | None:
    """Date used for attributing revenue (paid_at if set, else created_at)."""
    return order.paid_at or order.created_at


def _in_range(d: datetime | None, from_date: date, to_date: date) -> bool:
    if not d:
        return False
    d_date = d.date() if hasattr(d, "date") else d
    return from_date <= d_date <= to_date


def _waiter_name_for_order_tips(session: Session, order: models.Order) -> str:
    """Waiter for tip attribution: stored tip_attributed_user_id, else table assignment."""
    tid = getattr(order, "tip_attributed_user_id", None)
    if tid:
        u = session.get(models.User, tid)
        if u and u.tenant_id == order.tenant_id:
            return u.full_name or u.email or str(tid)
    table = session.get(models.Table, order.table_id) if order.table_id is not None else None
    if table:
        waiter_id = table.assigned_waiter_id
        if waiter_id is None and table.floor_id:
            floor = session.get(models.Floor, table.floor_id)
            if floor:
                waiter_id = floor.default_waiter_id
        if waiter_id:
            u = session.get(models.User, waiter_id)
            return (u.full_name or u.email) if u else str(waiter_id)
    return "Unassigned"


def _get_revenue_items(
    session: Session,
    tenant_id: int,
    from_date: date,
    to_date: date,
    location_id: int | None = None,
):
    """Load orders and items that count toward revenue in the date range."""
    order_query = (
        select(models.Order)
        .where(models.Order.tenant_id == tenant_id)
        .where(models.Order.deleted_at.is_(None))
        .where(models.Order.status.in_([s.value for s in REVENUE_STATUSES]))
    )
    if location_id is not None:
        order_query = order_query.where(models.Order.location_id == location_id)
    orders = session.exec(order_query.order_by(models.Order.created_at.asc())).all()

    result = []
    for order in orders:
        rev_date = _revenue_date(order)
        if not _in_range(rev_date, from_date, to_date):
            continue
        items = session.exec(
            select(models.OrderItem)
            .where(models.OrderItem.order_id == order.id)
            .where(models.OrderItem.removed_by_customer == False)
            .where(models.OrderItem.status != models.OrderItemStatus.cancelled)
        ).all()
        table = session.get(models.Table, order.table_id) if order.table_id is not None else None
        waiter_id = None
        waiter_name = None
        if table:
            waiter_id = table.assigned_waiter_id
            if waiter_id is None and table.floor_id:
                floor = session.get(models.Floor, table.floor_id)
                if floor:
                    waiter_id = floor.default_waiter_id
            if waiter_id:
                u = session.get(models.User, waiter_id)
                waiter_name = (u.full_name or u.email) if u else str(waiter_id)
        table_name = table.name if table else "Unknown"
        for item in items:
            product = session.get(models.Product, item.product_id)
            category = (product.category or "Uncategorized") if product else "Uncategorized"
            subcategory = (product.subcategory or "") if product else ""
            unit_cost = getattr(item, "cost_cents", None) or 0
            revenue_cents = item.quantity * item.price_cents
            cost_cents = item.quantity * unit_cost
            result.append({
                "order_id": order.id,
                "date": rev_date,
                "table_id": order.table_id,
                "table_name": table_name,
                "location_id": order.location_id,
                "location_name": order.location_name_snapshot or "Legacy",
                "service_point_label": order.service_point_label_snapshot or table_name,
                "waiter_id": waiter_id,
                "waiter_name": waiter_name or "Unassigned",
                "product_id": item.product_id,
                "product_name": item.product_name,
                "category": category,
                "subcategory": subcategory,
                "quantity": item.quantity,
                "price_cents": item.price_cents,
                "cost_cents": cost_cents,
                "revenue_cents": revenue_cents,
                "profit_cents": revenue_cents - cost_cents,
            })
    return result


def _build_report_payload(
    tenant_id: int,
    session: Session,
    from_date: date,
    to_date: date,
    location_id: int | None = None,
) -> dict:
    """Build full report dict for a tenant and date range."""
    if from_date > to_date:
        from_date, to_date = to_date, from_date
    rows = _get_revenue_items(session, tenant_id, from_date, to_date, location_id)

    tips_by_day: dict[str, int] = defaultdict(int)
    tips_by_waiter: dict[str, int] = defaultdict(int)
    total_tips_cents = 0
    orders_for_tips = session.exec(
        select(models.Order)
        .where(models.Order.tenant_id == tenant_id)
        .where(models.Order.deleted_at.is_(None))
        .where(models.Order.status.in_([s.value for s in REVENUE_STATUSES]))
    ).all()
    for order in orders_for_tips:
        if location_id is not None and order.location_id != location_id:
            continue
        rev_date = _revenue_date(order)
        if not _in_range(rev_date, from_date, to_date):
            continue
        tip = int(order.tip_amount_cents or 0)
        if tip <= 0:
            continue
        total_tips_cents += tip
        day = rev_date.strftime("%Y-%m-%d") if hasattr(rev_date, "strftime") else str(rev_date)[:10]
        tips_by_day[day] += tip
        wn = _waiter_name_for_order_tips(session, order)
        tips_by_waiter[wn] += tip

    # Summary by day
    by_day_agg: dict[str, dict] = defaultdict(
        lambda: {"revenue_cents": 0, "cost_cents": 0, "profit_cents": 0, "order_count": set()}
    )
    for r in rows:
        day = r["date"].strftime("%Y-%m-%d") if hasattr(r["date"], "strftime") else str(r["date"])[:10]
        by_day_agg[day]["revenue_cents"] += r["revenue_cents"]
        by_day_agg[day]["cost_cents"] += r["cost_cents"]
        by_day_agg[day]["profit_cents"] += r["profit_cents"]
        by_day_agg[day]["order_count"].add(r["order_id"])
    summary_daily = [
        {
            "date": d,
            "revenue_cents": data["revenue_cents"],
            "cost_cents": data["cost_cents"],
            "profit_cents": data["profit_cents"],
            "order_count": len(data["order_count"]),
            "tips_cents": tips_by_day.get(d, 0),
        }
        for d, data in sorted(by_day_agg.items())
    ]
    total_revenue_cents = sum(r["revenue_cents"] for r in rows)
    total_cost_cents = sum(r["cost_cents"] for r in rows)
    total_profit_cents = total_revenue_cents - total_cost_cents
    total_orders = len(set(r["order_id"] for r in rows))

    # By product
    by_product: dict[tuple[int, str], dict] = defaultdict(
        lambda: {"quantity": 0, "revenue_cents": 0, "cost_cents": 0, "profit_cents": 0, "category": ""}
    )
    for r in rows:
        key = (r["product_id"], r["product_name"])
        by_product[key]["quantity"] += r["quantity"]
        by_product[key]["revenue_cents"] += r["revenue_cents"]
        by_product[key]["cost_cents"] += r["cost_cents"]
        by_product[key]["profit_cents"] += r["profit_cents"]
        if not by_product[key]["category"]:
            by_product[key]["category"] = r.get("category") or "Uncategorized"
    by_product_list = [
        {
            "product_id": k[0],
            "product_name": k[1],
            "category": v["category"],
            "quantity": v["quantity"],
            "revenue_cents": v["revenue_cents"],
            "cost_cents": v["cost_cents"],
            "profit_cents": v["profit_cents"],
        }
        for k, v in sorted(by_product.items(), key=lambda x: -x[1]["revenue_cents"])
    ]

    # By category
    by_category: dict[str, dict] = defaultdict(
        lambda: {"quantity": 0, "revenue_cents": 0, "cost_cents": 0, "profit_cents": 0}
    )
    for r in rows:
        c = r["category"] or "Uncategorized"
        by_category[c]["quantity"] += r["quantity"]
        by_category[c]["revenue_cents"] += r["revenue_cents"]
        by_category[c]["cost_cents"] += r["cost_cents"]
        by_category[c]["profit_cents"] += r["profit_cents"]
    by_category_list = [
        {
            "category": k,
            "quantity": v["quantity"],
            "revenue_cents": v["revenue_cents"],
            "cost_cents": v["cost_cents"],
            "profit_cents": v["profit_cents"],
        }
        for k, v in sorted(by_category.items(), key=lambda x: -x[1]["revenue_cents"])
    ]

    # By table
    by_table: dict[str, dict] = defaultdict(lambda: {"revenue_cents": 0, "cost_cents": 0, "profit_cents": 0, "order_count": set()})
    for r in rows:
        t = r["table_name"]
        by_table[t]["revenue_cents"] += r["revenue_cents"]
        by_table[t]["cost_cents"] += r["cost_cents"]
        by_table[t]["profit_cents"] += r["profit_cents"]
        by_table[t]["order_count"].add(r["order_id"])
    by_table_list = [
        {
            "table_name": k,
            "revenue_cents": v["revenue_cents"],
            "cost_cents": v["cost_cents"],
            "profit_cents": v["profit_cents"],
            "order_count": len(v["order_count"]),
        }
        for k, v in sorted(by_table.items(), key=lambda x: -x[1]["revenue_cents"])
    ]

    by_location: dict[tuple[int | None, str], dict[str, Any]] = defaultdict(
        lambda: {"revenue_cents": 0, "order_ids": set(), "quantity": 0}
    )
    for row in rows:
        key = (row.get("location_id"), row.get("location_name") or "Legacy")
        by_location[key]["revenue_cents"] += row["revenue_cents"]
        by_location[key]["order_ids"].add(row["order_id"])
        by_location[key]["quantity"] += row["quantity"]
    by_location_list = [
        {
            "location_id": key[0],
            "location_name": key[1],
            "revenue_cents": value["revenue_cents"],
            "order_count": len(value["order_ids"]),
            "quantity": value["quantity"],
            "average_order_value_cents": (
                round(value["revenue_cents"] / len(value["order_ids"]))
                if value["order_ids"] else 0
            ),
        }
        for key, value in sorted(by_location.items(), key=lambda item: item[0][1])
    ]

    # By waiter
    by_waiter: dict[str, dict] = defaultdict(
        lambda: {"revenue_cents": 0, "cost_cents": 0, "profit_cents": 0, "order_count": set()}
    )
    for r in rows:
        w = r["waiter_name"]
        by_waiter[w]["revenue_cents"] += r["revenue_cents"]
        by_waiter[w]["cost_cents"] += r["cost_cents"]
        by_waiter[w]["profit_cents"] += r["profit_cents"]
        by_waiter[w]["order_count"].add(r["order_id"])
    by_waiter_list = [
        {
            "waiter_name": k,
            "revenue_cents": v["revenue_cents"],
            "cost_cents": v["cost_cents"],
            "profit_cents": v["profit_cents"],
            "order_count": len(v["order_count"]),
            "tips_cents": tips_by_waiter.get(k, 0),
        }
        for k, v in sorted(by_waiter.items(), key=lambda x: -x[1]["revenue_cents"])
    ]

    # Reservations in date range (by reservation_date); source = public (token set) vs staff (no token); by status
    reservations = session.exec(
        select(models.Reservation)
        .where(models.Reservation.tenant_id == tenant_id)
        .where(models.Reservation.reservation_date >= from_date)
        .where(models.Reservation.reservation_date <= to_date)
    ).all()
    total_reservations = len(reservations)
    by_source: dict[str, int] = defaultdict(int)
    by_status: dict[str, int] = defaultdict(int)
    for r in reservations:
        source = "public" if r.token else "staff"
        by_source[source] += 1
        by_status[r.status.value] += 1

    # Overbooking: count slots (date, time) in range where reserved_guests > total_seats or reserved_parties > total_tables
    tables = session.exec(select(models.Table).where(models.Table.tenant_id == tenant_id)).all()
    total_seats = sum(t.seat_count for t in tables)
    total_tables = len(tables)
    active_reservations = [r for r in reservations if r.status in (models.ReservationStatus.booked, models.ReservationStatus.seated)]
    slot_aggregates: dict[tuple[date, time], tuple[int, int]] = defaultdict(lambda: (0, 0))  # (guests, parties)
    for r in active_reservations:
        key = (r.reservation_date, r.reservation_time)
        g, p = slot_aggregates[key]
        slot_aggregates[key] = (g + r.party_size, p + 1)
    overbooking_slots_count = sum(
        1 for (g, p) in slot_aggregates.values() if g > total_seats or p > total_tables
    )

    reservations_summary = {
        "total": total_reservations,
        "by_source": [
            {"source": k, "count": v} for k, v in sorted(by_source.items(), key=lambda x: -x[1])
        ],
        "by_status": [
            {"status": k, "count": v} for k, v in sorted(by_status.items(), key=lambda x: -x[1])
        ],
        "overbooking_slots_count": overbooking_slots_count,
    }

    average_revenue_per_order_cents = (
        total_revenue_cents // total_orders if total_orders else 0
    )
    return {
        "from_date": from_date.isoformat(),
        "to_date": to_date.isoformat(),
        "summary": {
            "total_revenue_cents": total_revenue_cents,
            "total_cost_cents": total_cost_cents,
            "total_profit_cents": total_profit_cents,
            "total_tips_cents": total_tips_cents,
            "total_orders": total_orders,
            "average_revenue_per_order_cents": average_revenue_per_order_cents,
            "daily": summary_daily,
        },
        "reservations": reservations_summary,
        "by_product": by_product_list,
        "by_category": by_category_list,
        "by_table": by_table_list,
        "by_location": by_location_list,
        "by_waiter": by_waiter_list,
    }


@router.get("/sales")
@admin_user_limit()
def get_sales_reports(
    request: Request,
    response: Response,
    current_user: Annotated[models.User, Depends(require_permission(Permission.REPORT_READ))],
    session: Session = Depends(get_session),
    from_date: date = Query(..., description="Start date (YYYY-MM-DD)"),
    to_date: date = Query(..., description="End date (YYYY-MM-DD)"),
    location_id: int | None = Query(default=None),
) -> dict:
    """Combined sales report for the given date range. Uses paid/completed orders only."""
    if location_id is not None:
        location = session.get(models.TenantLocation, location_id)
        if location is None or location.tenant_id != current_user.tenant_id:
            raise HTTPException(status_code=404, detail="Location not found")
    return _build_report_payload(
        current_user.tenant_id, session, from_date, to_date, location_id
    )


def _csv_stream(rows: list[dict], keys: list[str], header_row: list[str]) -> bytes:
    import csv

    # csv.writer requires a text stream; BytesIO expects bytes and raises TypeError.
    buf = StringIO()
    writer = csv.writer(buf)
    writer.writerow(header_row)
    for r in rows:
        writer.writerow([r.get(k, "") for k in keys])
    # utf-8-sig so Excel recognizes UTF-8 when headers contain non-ASCII (localized exports).
    return buf.getvalue().encode("utf-8-sig")


@router.get("/export")
@admin_user_limit()
def export_report(
    request: Request,
    response: Response,
    current_user: Annotated[models.User, Depends(require_permission(Permission.REPORT_READ))],
    session: Session = Depends(get_session),
    from_date: date = Query(..., description="Start date (YYYY-MM-DD)"),
    to_date: date = Query(..., description="End date (YYYY-MM-DD)"),
    format: str = Query("csv", description="csv or xlsx"),
    report: str = Query("summary", description="summary, products, category, table, waiter"),
    lang: str | None = Query(None, description="UI language for headers (e.g. en, es, de)"),
    location_id: int | None = Query(default=None),
) -> StreamingResponse:
    """Export report as CSV or Excel. Same date range as reports."""
    if from_date > to_date:
        from_date, to_date = to_date, from_date
    if location_id is not None:
        location = session.get(models.TenantLocation, location_id)
        if location is None or location.tenant_id != current_user.tenant_id:
            raise HTTPException(status_code=404, detail="Location not found")
    data = _build_report_payload(
        current_user.tenant_id, session, from_date, to_date, location_id
    )
    L = report_export_labels(lang)

    if format.lower() == "xlsx":
        try:
            from openpyxl import Workbook
            from openpyxl.styles import Font, Alignment, PatternFill
        except ImportError:
            from fastapi import HTTPException
            raise HTTPException(500, "Excel export requires openpyxl")
        wb = Workbook()
        # Summary sheet
        ws = wb.active
        ws.title = L["sheet_summary"][:31]
        ws.append(
            [
                L["date"],
                L["revenue_cents"],
                L["cost_cents"],
                L["profit_cents"],
                L["tips_cents"],
                L["orders"],
            ]
        )
        for row in data["summary"]["daily"]:
            ws.append([
                row["date"],
                row["revenue_cents"],
                row.get("cost_cents", 0),
                row.get("profit_cents", 0),
                row.get("tips_cents", 0),
                row["order_count"],
            ])
        ws.append([])
        s = data["summary"]
        ws.append(
            [
                L["total"],
                s["total_revenue_cents"],
                s.get("total_cost_cents", 0),
                s.get("total_profit_cents", 0),
                s.get("total_tips_cents", 0),
                s["total_orders"],
            ]
        )
        # Reservations
        res = data.get("reservations", {})
        ws_res = wb.create_sheet(L["sheet_reservations"][:31])
        ws_res.append([L["source"], L["count"]])
        for row in res.get("by_source", []):
            sk = row["source"]
            src_label = L.get(f"source_{sk}", sk)
            ws_res.append([src_label, row["count"]])
        ws_res.append([])
        ws_res.append([L["status"], L["count"]])
        for row in res.get("by_status", []):
            st = row["status"]
            st_label = L.get(f"res_status_{st}", st)
            ws_res.append([st_label, row["count"]])
        ws_res.append([])
        ws_res.append([L["total"], res.get("total", 0)])
        # Products
        ws2 = wb.create_sheet(L["sheet_by_product"][:31])
        ws2.append(
            [
                L["product"],
                L["category"],
                L["quantity"],
                L["revenue_cents"],
                L["cost_cents"],
                L["profit_cents"],
            ]
        )
        for p in data["by_product"]:
            ws2.append([
                p["product_name"],
                p.get("category", ""),
                p["quantity"],
                p["revenue_cents"],
                p.get("cost_cents", 0),
                p.get("profit_cents", 0),
            ])
        # Category
        ws3 = wb.create_sheet(L["sheet_by_category"][:31])
        ws3.append(
            [
                L["category"],
                L["quantity"],
                L["revenue_cents"],
                L["cost_cents"],
                L["profit_cents"],
            ]
        )
        for c in data["by_category"]:
            ws3.append([
                c["category"],
                c["quantity"],
                c["revenue_cents"],
                c.get("cost_cents", 0),
                c.get("profit_cents", 0),
            ])
        # Table
        ws4 = wb.create_sheet(L["sheet_by_table"][:31])
        ws4.append(
            [
                L["table"],
                L["revenue_cents"],
                L["cost_cents"],
                L["profit_cents"],
                L["orders"],
            ]
        )
        for t in data["by_table"]:
            ws4.append([
                t["table_name"],
                t["revenue_cents"],
                t.get("cost_cents", 0),
                t.get("profit_cents", 0),
                t["order_count"],
            ])
        # Waiter
        ws5 = wb.create_sheet(L["sheet_by_waiter"][:31])
        ws5.append(
            [
                L["waiter"],
                L["revenue_cents"],
                L["cost_cents"],
                L["profit_cents"],
                L["tips_cents"],
                L["orders"],
            ]
        )
        for w in data["by_waiter"]:
            ws5.append([
                w["waiter_name"],
                w["revenue_cents"],
                w.get("cost_cents", 0),
                w.get("profit_cents", 0),
                w.get("tips_cents", 0),
                w["order_count"],
            ])
        buf = BytesIO()
        wb.save(buf)
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename=pos2-sales-{from_date}-{to_date}.xlsx"},
        )

    # CSV: single report type
    if report == "summary":
        rows = [
            {
                "date": r["date"],
                "revenue_cents": r["revenue_cents"],
                "cost_cents": r.get("cost_cents", 0),
                "profit_cents": r.get("profit_cents", 0),
                "tips_cents": r.get("tips_cents", 0),
                "order_count": r["order_count"],
            }
            for r in data["summary"]["daily"]
        ]
        keys = ["date", "revenue_cents", "cost_cents", "profit_cents", "tips_cents", "order_count"]
        header_row = [
            L["date"],
            L["revenue_cents"],
            L["cost_cents"],
            L["profit_cents"],
            L["tips_cents"],
            L["orders"],
        ]
    elif report == "products":
        rows = data["by_product"]
        keys = ["product_name", "category", "quantity", "revenue_cents", "cost_cents", "profit_cents"]
        header_row = [
            L["product"],
            L["category"],
            L["quantity"],
            L["revenue_cents"],
            L["cost_cents"],
            L["profit_cents"],
        ]
    elif report == "category":
        rows = data["by_category"]
        keys = ["category", "quantity", "revenue_cents", "cost_cents", "profit_cents"]
        header_row = [
            L["category"],
            L["quantity"],
            L["revenue_cents"],
            L["cost_cents"],
            L["profit_cents"],
        ]
    elif report == "table":
        rows = data["by_table"]
        keys = ["table_name", "revenue_cents", "cost_cents", "profit_cents", "order_count"]
        header_row = [
            L["table"],
            L["revenue_cents"],
            L["cost_cents"],
            L["profit_cents"],
            L["orders"],
        ]
    elif report == "waiter":
        rows = data["by_waiter"]
        keys = ["waiter_name", "revenue_cents", "cost_cents", "profit_cents", "tips_cents", "order_count"]
        header_row = [
            L["waiter"],
            L["revenue_cents"],
            L["cost_cents"],
            L["profit_cents"],
            L["tips_cents"],
            L["orders"],
        ]
    else:
        rows = data["summary"]["daily"]
        keys = ["date", "revenue_cents", "order_count"]
        header_row = [L["date"], L["revenue_cents"], L["orders"]]
    content = _csv_stream(rows, keys, header_row)
    return StreamingResponse(
        iter([content]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=pos2-sales-{report}-{from_date}-{to_date}.csv"},
    )


@router.get("/work-sessions")
@admin_user_limit()
def report_work_sessions(
    request: Request,
    response: Response,
    current_user: Annotated[models.User, Depends(require_permission(Permission.REPORT_READ))],
    session: Session = Depends(get_session),
    from_date: str = Query(..., description="Start date YYYY-MM-DD (UTC day)"),
    to_date: str = Query(..., description="End date YYYY-MM-DD (UTC day, inclusive)"),
    user_id: int | None = Query(None, description="Filter by staff user id (optional)"),
) -> list[dict]:
    """All tenant staff clock-in/out rows in range (by started_at, UTC). Owner and admin only."""
    if current_user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Tenant required")
    try:
        fd = datetime.strptime(from_date, "%Y-%m-%d").date()
        td = datetime.strptime(to_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format; use YYYY-MM-DD")
    if fd > td:
        raise HTTPException(status_code=400, detail="from_date must be <= to_date")
    start_utc = datetime.combine(fd, time.min, tzinfo=timezone.utc)
    end_exclusive = datetime.combine(td + timedelta(days=1), time.min, tzinfo=timezone.utc)
    q = (
        select(models.WorkSession)
        .where(models.WorkSession.tenant_id == current_user.tenant_id)
        .where(models.WorkSession.started_at >= start_utc)
        .where(models.WorkSession.started_at < end_exclusive)
    )
    if user_id is not None:
        q = q.where(models.WorkSession.user_id == user_id)
    rows = session.exec(q.order_by(models.WorkSession.started_at.desc())).all()
    out: list[dict] = []
    for ws in rows:
        u = session.get(models.User, ws.user_id)
        name = (u.full_name or u.email or "") if u else ""
        out.append(serialize_work_session(ws, name, session=session))
    return out


class WorkSessionAdjustBody(BaseModel):
    """Owner/admin manual correction of recorded times."""

    note: str = ""
    started_at: datetime | None = None
    ended_at: datetime | None = None


@router.get("/work-sessions/live")
@admin_user_limit()
def report_work_sessions_live(
    request: Request,
    response: Response,
    current_user: Annotated[models.User, Depends(require_permission(Permission.REPORT_READ))],
    session: Session = Depends(get_session),
) -> list[dict]:
    """Open clock sessions for the tenant (who is on-site / on break)."""
    if current_user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Tenant required")
    rows = session.exec(
        select(models.WorkSession)
        .where(models.WorkSession.tenant_id == current_user.tenant_id)
        .where(models.WorkSession.ended_at.is_(None))
        .order_by(models.WorkSession.started_at.asc())
    ).all()
    out: list[dict] = []
    for ws in rows:
        u = session.get(models.User, ws.user_id)
        name = (u.full_name or u.email or "") if u else ""
        d = serialize_work_session(ws, name, session=session)
        d["user_role"] = u.role.value if u else None
        out.append(d)
    return out


@router.post("/work-sessions/{work_session_id}/adjust")
@admin_user_limit()
def adjust_work_session_times(
    request: Request,
    response: Response,
    work_session_id: int,
    body: WorkSessionAdjustBody,
    current_user: Annotated[models.User, Depends(require_permission(Permission.REPORT_READ))],
    session: Session = Depends(get_session),
) -> dict:
    """Manual override of clock-in/out times (audit trail). Owner/admin via report permission."""
    if current_user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Tenant required")
    ws = session.exec(
        select(models.WorkSession).where(
            models.WorkSession.id == work_session_id,
            models.WorkSession.tenant_id == current_user.tenant_id,
        )
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Work session not found")
    if body.started_at is None and body.ended_at is None:
        raise HTTPException(status_code=400, detail="Provide started_at and/or ended_at")

    prev_s, prev_e = ws.started_at, ws.ended_at
    new_s = body.started_at if body.started_at is not None else ws.started_at
    new_e = body.ended_at if body.ended_at is not None else ws.ended_at
    if new_s is None:
        raise HTTPException(status_code=400, detail="started_at cannot be cleared")
    if new_e is not None and new_e < new_s:
        raise HTTPException(status_code=400, detail="ended_at must be on or after started_at")

    adj = models.WorkSessionAdjustment(
        tenant_id=ws.tenant_id,
        work_session_id=ws.id,
        actor_user_id=current_user.id,
        note=(body.note or "").strip(),
        previous_started_at=prev_s,
        previous_ended_at=prev_e,
        new_started_at=new_s,
        new_ended_at=new_e,
    )
    session.add(adj)
    ws.started_at = new_s
    ws.ended_at = new_e
    session.add(ws)
    session.commit()
    session.refresh(ws)
    u = session.get(models.User, ws.user_id)
    name = (u.full_name or u.email or "") if u else ""
    return serialize_work_session(ws, name, session=session)
