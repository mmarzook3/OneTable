"""Field defaults on Settings (no env mutation; uses model metadata only)."""


def test_email_from_default_is_project_domain_not_example_com() -> None:
    from app.settings import Settings

    default = Settings.model_fields["email_from"].default
    assert default == "noreply@scanaki.uk"
    assert "example.com" not in (default or "")


def test_email_sender_name_uses_scanaki_brand() -> None:
    from app.settings import Settings

    assert Settings.model_fields["email_from_name"].default == "Scanaki"


def test_payment_defaults_use_gbp() -> None:
    from app.settings import Settings

    assert Settings.model_fields["stripe_currency"].default == "gbp"
    assert Settings.model_fields["saas_plan_currency"].default == "gbp"
    assert Settings.model_fields["saas_plan_price_cents"].default == 999
    assert Settings.model_fields["saas_lite_price_cents"].default == 999
    assert Settings.model_fields["saas_pro_price_cents"].default == 3999
    assert Settings.model_fields["saas_ultra_price_cents"].default == 8499
    assert Settings.model_fields["saas_extra_table_price_cents"].default == 399
