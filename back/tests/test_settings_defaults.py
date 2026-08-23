"""Field defaults on Settings (no env mutation; uses model metadata only)."""


def test_email_from_default_is_project_domain_not_example_com() -> None:
    from app.settings import Settings

    default = Settings.model_fields["email_from"].default
    assert default == "noreply@scanaski.uk"
    assert "example.com" not in (default or "")


def test_email_sender_name_uses_scanaki_brand() -> None:
    from app.settings import Settings

    assert Settings.model_fields["email_from_name"].default == "Scanaki"
