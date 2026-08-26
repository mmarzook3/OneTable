"""Product bulk import: JSON/CSV preview/confirm and optional vision extraction."""

from __future__ import annotations

import base64
import csv
import io
import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any

import requests
from pydantic import BaseModel, Field, ValidationError
from sqlmodel import Session, select

from . import models
from .category_codes import normalize_product_category
from .settings import settings

MAX_BULK_IMPORT_ROWS = 500
MAX_VISION_IMAGE_BYTES = 8 * 1024 * 1024  # 8MB for menu photo upload (not persisted)

# Canonical CSV headers for migration / cutover imports (see docs/0062-pos-migration-import.md).
CSV_REQUIRED_HEADERS = frozenset({"name"})
CSV_OPTIONAL_HEADERS = frozenset(
    {
        "price",
        "price_cents",
        "cost",
        "cost_cents",
        "category",
        "subcategory",
        "description",
        "ingredients",
    }
)
CSV_KNOWN_HEADERS = CSV_REQUIRED_HEADERS | CSV_OPTIONAL_HEADERS

# Common vendor / locale header aliases → canonical (casefold keys).
# Applied before the unknown-column check so staff CSV exports work without renaming.
CSV_HEADER_ALIASES: dict[str, str] = {
    # name
    "product": "name",
    "product_name": "name",
    "product name": "name",
    "item": "name",
    "item_name": "name",
    "item name": "name",
    "dish": "name",
    "dish_name": "name",
    "title": "name",
    "nombre": "name",
    "producto": "name",
    "plato": "name",
    "artikel": "name",
    "artikelname": "name",
    "bezeichnung": "name",
    "nom": "name",
    "produit": "name",
    # price
    "unit_price": "price",
    "unit price": "price",
    "sale_price": "price",
    "retail_price": "price",
    "amount": "price",
    "precio": "price",
    "preis": "price",
    "prix": "price",
    "pvp": "price",
    # price_cents
    "price in cents": "price_cents",
    "priceincents": "price_cents",
    # cost
    "unit_cost": "cost",
    "cost_price": "cost",
    "coste": "cost",
    "kosten": "cost",
    "cout": "cost",
    "coût": "cost",
    # category
    "cat": "category",
    "group": "category",
    "categoria": "category",
    "categoría": "category",
    "kategorie": "category",
    "categorie": "category",
    "catégorie": "category",
    # subcategory
    "sub_category": "subcategory",
    "sub category": "subcategory",
    "subcat": "subcategory",
    "subcategoria": "subcategory",
    "subcategoría": "subcategory",
    "unterkategorie": "subcategory",
    "sous-categorie": "subcategory",
    "sous_categorie": "subcategory",
    # description
    "desc": "description",
    "details": "description",
    "descripcion": "description",
    "descripción": "description",
    "beschreibung": "description",
    # ingredients
    "ingredient": "ingredients",
    "ingredientes": "ingredients",
    "zutaten": "ingredients",
    "ingredients_list": "ingredients",
}


class ProductBulkImportCsvRequest(BaseModel):
    """Staff CSV/TSV paste or file contents for preview (no writes)."""

    csv: str = Field(min_length=1, max_length=2_000_000)
    use_ai_mapping: bool = False


class ProductBulkImportItemIn(BaseModel):
    """Single product row from JSON import or vision extraction."""

    name: str = Field(max_length=256)
    price: float | None = None
    price_cents: int | None = None
    cost: float | None = None
    cost_cents: int | None = None
    category: str | None = Field(default=None, max_length=128)
    subcategory: str | None = Field(default=None, max_length=128)
    description: str | None = Field(default=None, max_length=4000)
    ingredients: str | None = Field(default=None, max_length=2000)


class ProductBulkImportRequest(BaseModel):
    items: list[ProductBulkImportItemIn] = Field(min_length=1, max_length=MAX_BULK_IMPORT_ROWS)


class ProductBulkImportPreviewRow(BaseModel):
    row_index: int
    name: str
    price_cents: int | None = None
    cost_cents: int | None = None
    category: str | None = None
    subcategory: str | None = None
    description: str | None = None
    ingredients: str | None = None
    valid: bool
    errors: list[str] = Field(default_factory=list)
    action: str  # "create" | "update" | "skip"
    existing_product_id: int | None = None


class ProductBulkImportPreviewSummary(BaseModel):
    total: int
    valid: int
    invalid: int
    create: int
    update: int


class ProductBulkImportPreviewResponse(BaseModel):
    items: list[ProductBulkImportPreviewRow]
    summary: ProductBulkImportPreviewSummary


class ProductBulkImportConfirmRequest(BaseModel):
    items: list[ProductBulkImportPreviewRow] = Field(min_length=1, max_length=MAX_BULK_IMPORT_ROWS)


class ProductBulkImportConfirmResult(BaseModel):
    created: int
    updated: int
    skipped: int
    product_ids: list[int]


def _normalize_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip()).casefold()


def _major_to_cents(value: float | None) -> int | None:
    if value is None:
        return None
    try:
        dec = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if dec < 0:
        return None
    return int((dec * 100).quantize(Decimal("1")))


def _resolve_price_cents(item: ProductBulkImportItemIn) -> tuple[int | None, list[str]]:
    errors: list[str] = []
    if item.price_cents is not None:
        if item.price_cents <= 0:
            errors.append("price_must_be_positive")
            return None, errors
        return int(item.price_cents), errors
    if item.price is not None:
        cents = _major_to_cents(item.price)
        if cents is None or cents <= 0:
            errors.append("price_must_be_positive")
            return None, errors
        return cents, errors
    errors.append("price_required")
    return None, errors


def _resolve_cost_cents(item: ProductBulkImportItemIn) -> tuple[int | None, list[str]]:
    if item.cost_cents is not None:
        if item.cost_cents < 0:
            return None, ["cost_must_be_non_negative"]
        return int(item.cost_cents), []
    if item.cost is not None:
        cents = _major_to_cents(item.cost)
        if cents is None or cents < 0:
            return None, ["cost_must_be_non_negative"]
        return cents, []
    return None, []


def _existing_by_name(session: Session, tenant_id: int) -> dict[str, models.Product]:
    products = session.exec(
        select(models.Product).where(models.Product.tenant_id == tenant_id)
    ).all()
    out: dict[str, models.Product] = {}
    for p in products:
        key = _normalize_name(p.name)
        if key and key not in out:
            out[key] = p
    return out


def build_preview(
    session: Session,
    tenant_id: int,
    items: list[ProductBulkImportItemIn],
) -> ProductBulkImportPreviewResponse:
    existing = _existing_by_name(session, tenant_id)
    preview_rows: list[ProductBulkImportPreviewRow] = []
    summary = ProductBulkImportPreviewSummary(
        total=len(items), valid=0, invalid=0, create=0, update=0
    )

    for idx, item in enumerate(items):
        errors: list[str] = []
        name = (item.name or "").strip()
        if not name:
            errors.append("name_required")

        price_cents, price_errors = _resolve_price_cents(item)
        errors.extend(price_errors)

        cost_cents, cost_errors = _resolve_cost_cents(item)
        errors.extend(cost_errors)

        category = normalize_product_category(item.category)
        subcategory = (item.subcategory or "").strip() or None
        description = (item.description or "").strip() or None
        ingredients = (item.ingredients or "").strip() or None

        existing_product: models.Product | None = None
        action = "skip"
        if name:
            existing_product = existing.get(_normalize_name(name))
            if existing_product:
                action = "update"
            else:
                action = "create"

        valid = len(errors) == 0 and bool(name) and price_cents is not None
        row = ProductBulkImportPreviewRow(
            row_index=idx,
            name=name,
            price_cents=price_cents,
            cost_cents=cost_cents,
            category=category,
            subcategory=subcategory,
            description=description,
            ingredients=ingredients,
            valid=valid,
            errors=errors,
            action=action if valid else "skip",
            existing_product_id=existing_product.id if existing_product and valid else None,
        )
        preview_rows.append(row)
        if valid:
            summary.valid += 1
            if action == "create":
                summary.create += 1
            elif action == "update":
                summary.update += 1
        else:
            summary.invalid += 1

    return ProductBulkImportPreviewResponse(items=preview_rows, summary=summary)


def confirm_import(
    session: Session,
    tenant_id: int,
    rows: list[ProductBulkImportPreviewRow],
) -> ProductBulkImportConfirmResult:
    created = 0
    updated = 0
    skipped = 0
    product_ids: list[int] = []

    for row in rows:
        if not row.valid or row.action == "skip":
            skipped += 1
            continue
        if row.price_cents is None or row.price_cents <= 0:
            skipped += 1
            continue
        name = row.name.strip()
        if not name:
            skipped += 1
            continue

        if row.action == "update" and row.existing_product_id:
            product = session.exec(
                select(models.Product).where(
                    models.Product.id == row.existing_product_id,
                    models.Product.tenant_id == tenant_id,
                )
            ).first()
            if not product:
                skipped += 1
                continue
            product.name = name
            product.price_cents = row.price_cents
            if row.cost_cents is not None:
                product.cost_cents = row.cost_cents
            if row.category is not None:
                product.category = normalize_product_category(row.category)
            if row.subcategory is not None:
                product.subcategory = row.subcategory or None
            if row.description is not None:
                product.description = row.description or None
            if row.ingredients is not None:
                product.ingredients = row.ingredients or None
            session.add(product)
            session.commit()
            session.refresh(product)
            updated += 1
            product_ids.append(product.id)
        else:
            product = models.Product(
                tenant_id=tenant_id,
                name=name,
                price_cents=row.price_cents,
                cost_cents=row.cost_cents,
                category=normalize_product_category(row.category),
                subcategory=row.subcategory,
                description=row.description,
                ingredients=row.ingredients,
            )
            session.add(product)
            session.commit()
            session.refresh(product)
            created += 1
            product_ids.append(product.id)

    return ProductBulkImportConfirmResult(
        created=created,
        updated=updated,
        skipped=skipped,
        product_ids=product_ids,
    )


def parse_json_import_payload(raw: Any) -> list[ProductBulkImportItemIn]:
    """Accept {items: [...]} or a raw list of objects."""
    if isinstance(raw, dict):
        items_raw = raw.get("items")
        if not isinstance(items_raw, list):
            raise ValueError("invalid_json_structure")
        return [ProductBulkImportItemIn.model_validate(x) for x in items_raw]
    if isinstance(raw, list):
        return [ProductBulkImportItemIn.model_validate(x) for x in raw]
    raise ValueError("invalid_json_structure")


def _csv_cell(row: dict[str, str], key: str) -> str | None:
    raw = row.get(key)
    if raw is None:
        return None
    text = str(raw).strip()
    return text if text else None


def _csv_float(row: dict[str, str], key: str) -> float | None:
    text = _csv_cell(row, key)
    if text is None:
        return None
    try:
        return float(text.replace(",", "."))
    except ValueError as exc:
        raise ValueError(f"invalid_{key}") from exc


def _csv_int(row: dict[str, str], key: str) -> int | None:
    text = _csv_cell(row, key)
    if text is None:
        return None
    try:
        return int(text)
    except ValueError as exc:
        raise ValueError(f"invalid_{key}") from exc


def _normalize_csv_header(raw: str | None) -> str:
    """Strip, casefold, and map known aliases to canonical header names."""
    h = (raw or "").strip().casefold()
    if not h:
        return ""
    if h in CSV_KNOWN_HEADERS:
        return h
    return CSV_HEADER_ALIASES.get(h, h)


def _detect_csv_dialect(sample: str) -> csv.Dialect:
    """Prefer comma; fall back to tab when the sample looks like TSV."""
    try:
        return csv.Sniffer().sniff(sample, delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel()
        if sample.count("\t") > sample.count(","):
            dialect.delimiter = "\t"
        return dialect


def _read_csv_dicts(text: str) -> tuple[list[str], list[dict[str, str]]]:
    """
    Return (original_headers_stripped, rows_with_original_keys).

    Keys in rows match the stripped original header strings (not casefolded).
    """
    cleaned = text.lstrip("\ufeff")
    if not cleaned.strip():
        raise ValueError("empty_csv")
    sample = cleaned[:4096]
    dialect = _detect_csv_dialect(sample)
    stream = io.StringIO(cleaned)
    reader = csv.DictReader(stream, dialect=dialect)
    if not reader.fieldnames:
        raise ValueError("empty_csv")
    original_headers = [(h or "").strip() for h in reader.fieldnames]
    if not any(original_headers):
        raise ValueError("empty_csv")
    rows: list[dict[str, str]] = []
    for raw_row in reader:
        row = {
            (k or "").strip(): ("" if v is None else str(v))
            for k, v in raw_row.items()
            if (k or "").strip()
        }
        if not any(v.strip() for v in row.values()):
            continue
        if len(rows) >= MAX_BULK_IMPORT_ROWS:
            raise ValueError("too_many_rows")
        rows.append(row)
    return original_headers, rows


def _apply_header_map(
    original_headers: list[str],
    rows: list[dict[str, str]],
    header_map: dict[str, str],
) -> tuple[list[str], list[dict[str, str]]]:
    """
    Remap columns using header_map: original_header → canonical (or skip if mapped to "").

    ``header_map`` keys should match stripped original headers (exact). Values must be
    canonical known headers, or empty string to drop the column explicitly.
    """
    canon_headers: list[str] = []
    for h in original_headers:
        if not h:
            continue
        target = header_map.get(h)
        if target is None:
            target = _normalize_csv_header(h)
        target = (target or "").strip().casefold()
        if not target:
            continue  # explicit drop
        canon_headers.append(target)

    if len(canon_headers) != len(set(canon_headers)):
        raise ValueError("duplicate_csv_headers")

    out_rows: list[dict[str, str]] = []
    for raw in rows:
        mapped: dict[str, str] = {}
        for h, v in raw.items():
            target = header_map.get(h)
            if target is None:
                target = _normalize_csv_header(h)
            target = (target or "").strip().casefold()
            if not target:
                continue
            mapped[target] = v
        out_rows.append(mapped)
    return canon_headers, out_rows


def map_csv_headers_via_ai(
    headers: list[str],
    sample_rows: list[dict[str, str]],
) -> dict[str, str]:
    """
    Ask the configured vision/LLM API to map vendor headers to canonical fields.

    Returns a map of original_header → canonical header (or "" to drop).
    Raises RuntimeError on configuration / API / parse failures.
    Never writes products; caller still runs preview → confirm.
    """
    api_key = (settings.product_vision_api_key or "").strip()
    if not api_key:
        raise RuntimeError("vision_not_configured")

    model = (settings.product_vision_model or "gpt-4o-mini").strip()
    url = (settings.product_vision_api_url or "https://api.openai.com/v1/chat/completions").strip()
    known = sorted(CSV_KNOWN_HEADERS)
    sample = sample_rows[:3]
    system_prompt = (
        "You map spreadsheet column headers from restaurant menu exports to a fixed schema. "
        "Return ONLY valid JSON: {\"mapping\":{\"<original_header>\":\"<canonical_or_empty>\"}}. "
        f"Canonical fields: {known}. "
        "Use an empty string \"\" only when the column is clearly not a product field "
        "(e.g. SKU, barcode, stock, id). Every input header must appear as a key."
    )
    user_payload = {"headers": headers, "sample_rows": sample}
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": "Map these CSV headers to the canonical product fields:\n"
                + json.dumps(user_payload, ensure_ascii=False),
            },
        ],
        "temperature": 0,
        "max_tokens": 1024,
    }
    headers_http = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    resp = requests.post(url, json=payload, headers=headers_http, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"vision_api_error:{resp.status_code}")

    data = resp.json()
    content = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
        .strip()
    )
    if not content:
        raise RuntimeError("vision_empty_response")
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)

    parsed = json.loads(content)
    raw_map = parsed.get("mapping") if isinstance(parsed, dict) else None
    if not isinstance(raw_map, dict):
        raise RuntimeError("vision_bad_mapping")

    result: dict[str, str] = {}
    for h in headers:
        if not h:
            continue
        if h not in raw_map:
            raise ValueError(f"unmapped_csv_columns:{h}")
        target = raw_map[h]
        if target is None:
            target = ""
        target_s = str(target).strip().casefold()
        if target_s and target_s not in CSV_KNOWN_HEADERS:
            raise ValueError(f"invalid_ai_mapping:{h}->{target_s}")
        result[h] = target_s
    return result


def parse_products_csv(
    text: str,
    *,
    header_map: dict[str, str] | None = None,
    use_ai_mapping: bool = False,
) -> list[ProductBulkImportItemIn]:
    """
    Parse a UTF-8 (optional BOM) products CSV/TSV into bulk-import items.

    Required column: ``name``.
    Price: ``price`` (major units) and/or ``price_cents`` (at least one required per row —
    enforced later by ``build_preview``).
    Optional: ``cost``, ``cost_cents``, ``category``, ``subcategory``, ``description``,
    ``ingredients``.

    Unknown columns raise ``unknown_csv_columns:…`` unless ``use_ai_mapping`` is True
    and the vision API is configured (then AI maps headers; leftover unknowns still error).
    Common aliases (producto→name, precio→price, …) are applied automatically.
    """
    if text is None:
        raise ValueError("empty_csv")

    original_headers, raw_rows = _read_csv_dicts(text)
    if not raw_rows:
        raise ValueError("empty_csv")

    effective_map: dict[str, str] = {}
    for h in original_headers:
        if not h:
            continue
        effective_map[h] = _normalize_csv_header(h)

    if header_map:
        for k, v in header_map.items():
            key = (k or "").strip()
            if key:
                effective_map[key] = (v or "").strip().casefold()

    unknown = [
        h
        for h, target in effective_map.items()
        if h and target and target not in CSV_KNOWN_HEADERS
    ]

    if unknown and use_ai_mapping:
        try:
            ai_map = map_csv_headers_via_ai(original_headers, raw_rows)
        except (RuntimeError, ValueError):
            raise
        except Exception as exc:
            raise RuntimeError("vision_bad_mapping") from exc
        for h, target in ai_map.items():
            effective_map[h] = target
        unknown = [
            h
            for h, target in effective_map.items()
            if h and target and target not in CSV_KNOWN_HEADERS
        ]

    if unknown:
        raise ValueError(f"unknown_csv_columns:{','.join(unknown)}")

    headers, rows = _apply_header_map(original_headers, raw_rows, effective_map)
    if "name" not in headers:
        raise ValueError("missing_name_column")

    items: list[ProductBulkImportItemIn] = []
    for row_num, row in enumerate(rows, start=2):  # header is line 1
        if len(items) >= MAX_BULK_IMPORT_ROWS:
            raise ValueError("too_many_rows")
        try:
            item = ProductBulkImportItemIn(
                name=_csv_cell(row, "name") or "",
                price=_csv_float(row, "price"),
                price_cents=_csv_int(row, "price_cents"),
                cost=_csv_float(row, "cost"),
                cost_cents=_csv_int(row, "cost_cents"),
                category=_csv_cell(row, "category"),
                subcategory=_csv_cell(row, "subcategory"),
                description=_csv_cell(row, "description"),
                ingredients=_csv_cell(row, "ingredients"),
            )
        except ValueError as exc:
            raise ValueError(f"row_{row_num}:{exc}") from exc
        except ValidationError as exc:
            raise ValueError(f"row_{row_num}:invalid_fields") from exc
        items.append(item)

    if not items:
        raise ValueError("empty_csv")
    return items


def format_preview_report(preview: ProductBulkImportPreviewResponse) -> str:
    """Human-readable validation report for CLI dry-run / apply."""
    s = preview.summary
    lines = [
        f"total={s.total} valid={s.valid} invalid={s.invalid} "
        f"create={s.create} update={s.update}",
    ]
    for row in preview.items:
        status = "OK" if row.valid else "INVALID"
        err = f" errors={','.join(row.errors)}" if row.errors else ""
        lines.append(
            f"  [{status}] row={row.row_index} action={row.action} "
            f"name={row.name!r} price_cents={row.price_cents}{err}"
        )
    return "\n".join(lines)


def vision_api_configured() -> bool:
    return bool((settings.product_vision_api_key or "").strip())


def extract_items_from_menu_image(contents: bytes, content_type: str) -> list[ProductBulkImportItemIn]:
    """Call external vision API; image bytes are not stored."""
    api_key = (settings.product_vision_api_key or "").strip()
    if not api_key:
        raise RuntimeError("vision_not_configured")

    b64 = base64.standard_b64encode(contents).decode("ascii")
    data_url = f"data:{content_type};base64,{b64}"
    model = (settings.product_vision_model or "gpt-4o-mini").strip()
    url = (settings.product_vision_api_url or "https://api.openai.com/v1/chat/completions").strip()

    system_prompt = (
        "You extract restaurant menu items from images. "
        "Return ONLY valid JSON: {\"items\":[{\"name\":\"...\",\"price\":12.5,\"category\":\"...\","
        "\"subcategory\":\"...\",\"description\":\"...\",\"ingredients\":\"...\"}]}. "
        "Use price as a decimal number in the menu currency (major units, e.g. pounds). "
        "Include every dish/item with a price when visible. Omit items without a readable price."
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Extract all menu dishes and prices from this image as JSON.",
                    },
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
        "temperature": 0,
        "max_tokens": 4096,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=120)
    if resp.status_code >= 400:
        raise RuntimeError(f"vision_api_error:{resp.status_code}")

    data = resp.json()
    content = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
        .strip()
    )
    if not content:
        raise RuntimeError("vision_empty_response")

    # Strip markdown code fences if present
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)

    parsed = json.loads(content)
    return parse_json_import_payload(parsed)
