"""Create one disposable Phase 1 tenant; never modify an existing tenant.

Run inside the existing LOCAL backend container, with credentials supplied by the
operator (do not put secrets in arguments):
  python -m app.seeds.seed_phase1_synthetic --create --allow-local-synthetic \
    --database-name <exact-local-database>

Required env: BASE_URL (HTTP loopback or exact Compose host haproxy), PHASE1_LIVE_MODE=false.
Use --credentials-stdin with a JSON object containing stripe_secret_key
(sk_test_... or rk_test_...), stripe_publishable_key (pk_test_...),
stripe_webhook_secret (whsec_...), and owner_password (14+ characters).
Alternatively use PHASE1_STRIPE_SECRET_KEY, PHASE1_STRIPE_PUBLISHABLE_KEY,
PHASE1_STRIPE_WEBHOOK_SECRET and PHASE1_OWNER_PASSWORD environment variables.
Save credential-free stdout to the repository ROOT tmp/phase1-fixture.json
(e.g. /repo/tmp through a root bind mount, not /app/tmp when /app is back/).
No credential file is written. The caller owns secure stdin and artifact storage.
Remote creation requires --allow-remote-synthetic instead of the local flag,
PHASE1_ALLOW_REMOTE_SYNTHETIC=1 and PHASE1_REMOTE_ORIGIN matching BASE_URL
exactly (HTTPS only). Database hostname remains restricted to local/Compose.
No email, migration, global seed, cleanup, or production fallback is performed.
The signed, secret-free manifest expires after 30 minutes. Failures roll back the
fixture transaction. Stripe PaymentIntent listing is read-only; live objects fail closed.
"""

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--create", action="store_true")
    parser.add_argument("--allow-local-synthetic", action="store_true")
    parser.add_argument("--allow-remote-synthetic", action="store_true")
    parser.add_argument("--credentials-stdin", action="store_true")
    parser.add_argument("--database-name", required=True)
    args = parser.parse_args()
    require(args.create and args.allow_local_synthetic != args.allow_remote_synthetic,
            "Creation requires --create and exactly one local/remote synthetic opt-in")
    remote = args.allow_remote_synthetic
    require(not remote or os.environ.get("PHASE1_ALLOW_REMOTE_SYNTHETIC") == "1",
            "Remote creation requires PHASE1_ALLOW_REMOTE_SYNTHETIC=1")
    require(os.environ.get("PHASE1_LIVE_MODE") == "false", "PHASE1_LIVE_MODE must be false")
    require(remote or not any(os.environ.get(k, "").lower() in {"production", "prod", "live"}
                    for k in ("APP_ENV", "ENVIRONMENT", "NODE_ENV")), "Production environment refused")
    base_url = os.environ.get("BASE_URL", "").rstrip("/")
    url = urlsplit(base_url)
    require(bool(url.hostname) and not url.username and not url.password and not url.path
            and not url.query and not url.fragment, "BASE_URL must be a bare origin")
    if remote:
        require(url.scheme == "https" and base_url == os.environ.get("PHASE1_REMOTE_ORIGIN"),
                "Remote origin must exactly match explicit HTTPS PHASE1_REMOTE_ORIGIN")
    else:
        require(url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1", "haproxy"},
                "BASE_URL must be HTTP loopback or the exact Compose host haproxy")
    credentials = {}
    if args.credentials_stdin:
        raw = sys.stdin.read(65537)
        require(len(raw) <= 65536, "Credentials input too large")
        credentials = json.loads(raw)
        require(isinstance(credentials, dict), "Credentials input must be a JSON object")
        require(set(credentials) == {"stripe_secret_key", "stripe_publishable_key",
                                     "stripe_webhook_secret", "owner_password"},
                "Credentials JSON requires exactly the four documented keys")
        require(all(isinstance(v, str) for v in credentials.values()), "Credentials must be strings")
    secret = credentials.get("stripe_secret_key", os.environ.get("PHASE1_STRIPE_SECRET_KEY", ""))
    publishable = credentials.get("stripe_publishable_key", os.environ.get("PHASE1_STRIPE_PUBLISHABLE_KEY", ""))
    webhook = credentials.get("stripe_webhook_secret", os.environ.get("PHASE1_STRIPE_WEBHOOK_SECRET", ""))
    password = credentials.get("owner_password", os.environ.get("PHASE1_OWNER_PASSWORD", ""))
    require(secret.startswith(("sk_test_", "rk_test_")) and len(secret) > 16, "Stripe test secret required")
    require(publishable.startswith("pk_test_") and len(publishable) > 16, "Stripe test publishable key required")
    require(len(password) >= 14, "PHASE1_OWNER_PASSWORD must have at least 14 characters")
    require(webhook.startswith("whsec_") and len(webhook) > 10, "Stripe webhook signing secret required")
    # Restricted keys may permit PaymentIntents but not Balance. Listing does not
    # create a payment; verify every returned object as well as the key prefix.
    request = Request("https://api.stripe.com/v1/payment_intents?limit=1", headers={"Authorization": f"Bearer {secret}"})
    with urlopen(request, timeout=20) as response:
        intents = json.load(response)
    require(intents.get("object") == "list" and isinstance(intents.get("data"), list),
            "Stripe PaymentIntent list contract unavailable")
    require(all(item.get("livemode") is False for item in intents["data"]),
            "Stripe returned a live or unclassified PaymentIntent")

    # Import application/database code only after all explicit safety gates.
    from sqlmodel import Session
    from app import models
    from app.db import engine
    from app.security import get_password_hash
    from app.tenant_payment_credentials import encrypt_payment_secret

    require(engine.url.host in {"localhost", "127.0.0.1", "::1", "db", "pos-db"},
            "Database must use a loopback or local Compose database hostname")
    require(engine.url.database == args.database_name, "Database acknowledgement mismatch")
    run_id = uuid4().hex
    tenant_name = f"Scanaki Phase 1 {run_id}"
    email = f"phase1-{run_id}@amvara.de"
    product_name = f"Synthetic Soup {run_id}"
    with Session(engine) as session:
        with session.begin():
            tenant = models.Tenant(
                name=tenant_name, is_demo=False, onboarding_status="completed",
                saas_plan_code="pro", ordering_mode="automatic", ordering_paused=False,
                ordering_service_hours=None, immediate_payment_required=True,
                require_kds_online=False, strict_fifo_kds=True,
                currency_code="GBP", timezone="UTC", location_check_enabled=False,
                stripe_payment_mode="tenant_keys", stripe_connected_account_id=None,
                stripe_publishable_key=publishable,
                stripe_secret_key_encrypted=encrypt_payment_secret(secret),
                stripe_webhook_secret_encrypted=encrypt_payment_secret(webhook),
            )
            session.add(tenant)
            session.flush()
            owner = models.User(email=email, full_name="Synthetic Phase1 Owner",
                                hashed_password=get_password_hash(password),
                                role=models.UserRole.owner, tenant_id=tenant.id,
                                must_change_password=False)
            location = models.TenantLocation(
                tenant_id=tenant.id, name="Synthetic Main", display_name="Synthetic Main",
                slug="synthetic-main", location_type="pub", is_active=True,
                menu_mode="inherit", kitchen_mode="inherit", payment_mode="inherit",
                hours_mode="override", opening_hours_override={}, ordering_hours_override={},
                ordering_paused=False,
            )
            floor = models.Floor(name="Synthetic Main", tenant_id=tenant.id)
            session.add(owner)
            session.add(location)
            session.add(floor)
            session.flush()
            table = models.Table(name=f"Synthetic Table {run_id}", tenant_id=tenant.id,
                                 floor_id=floor.id, location_id=location.id,
                                 service_point_type="table", display_number="1",
                                 customer_label="Synthetic Table 1",
                                 seat_count=2, is_active=True,
                                 is_ordering_enabled=True)
            product = models.Product(name=product_name, tenant_id=tenant.id,
                                     price_cents=500, category="Main Course", is_available=True,
                                     allergens=[], allergen_reviewed=True,
                                     allergen_notes="Synthetic test product only; not for consumption.")
            session.add(table)
            session.add(product)
            session.flush()
            question = models.ProductQuestion(
                tenant_id=tenant.id, product_id=product.id,
                type=models.ProductQuestionType.choice, label="Soup finish",
                options=["With garnish", "No garnish"], required=True, sort_order=0,
            )
            session.add(question)
            session.flush()
            payload = json.dumps({
                "schema": 1, "synthetic": True, "livemode": False,
                "target": "remote" if remote else "local",
                "run_id": run_id, "created_at": int(time.time()), "base_url": base_url,
                "tenant_id": tenant.id, "tenant_name": tenant_name,
                "location_id": location.id, "floor_id": floor.id,
                "owner_email": email, "table_id": table.id, "table_token": table.token,
                "product_id": product.id, "product_name": product_name,
                "question_id": question.id, "question_label": question.label,
                "question_option": "No garnish",
                "amount_cents": 500, "currency": "gbp",
                "publishable_key_sha256": hashlib.sha256(publishable.encode()).hexdigest(),
            }, separators=(",", ":"), sort_keys=True)
            signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        print(json.dumps({**json.loads(payload), "payload": payload, "signature": signature}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Database/HTTP exception strings may contain credentials or SQL values.
        message = str(error) if type(error) is ValueError else type(error).__name__
        print(f"Phase1 fixture refused/failed: {message}", file=sys.stderr)
        sys.exit(1)
