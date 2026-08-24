from app.tenant_currency import (
    apply_tenant_currency_api_dict,
    normalize_tenant_currency_fields,
    sync_tenant_currency_symbol_from_code,
)
from app.models import Tenant


def test_new_tenant_defaults_to_uk_currency():
    tenant = Tenant(name="UK Default Tenant")
    assert tenant.currency_code == "GBP"
    assert tenant.currency == "£"


def test_normalize_defaults_to_gbp():
    assert normalize_tenant_currency_fields(None, None) == ("GBP", "£")
    assert normalize_tenant_currency_fields("", "$") == ("GBP", "£")


def test_normalize_usd():
    assert normalize_tenant_currency_fields("usd", None) == ("USD", "$")


def test_apply_dict_mutates():
    d = {"currency_code": None, "currency": "$"}
    apply_tenant_currency_api_dict(d)
    assert d["currency_code"] == "GBP"
    assert d["currency"] == "£"


def test_apply_dict_keeps_usd():
    d = {"currency_code": "USD", "currency": "€"}
    apply_tenant_currency_api_dict(d)
    assert d["currency_code"] == "USD"
    assert d["currency"] == "$"


def test_sync_symbol():
    assert sync_tenant_currency_symbol_from_code("GBP") == "£"
    assert sync_tenant_currency_symbol_from_code("EUR") == "€"
    assert sync_tenant_currency_symbol_from_code(None) is None
