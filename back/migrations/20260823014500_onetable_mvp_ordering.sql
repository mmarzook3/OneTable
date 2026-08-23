-- One Table MVP: automatic ordering, QR/NFC plaque lifecycle, KDS heartbeat,
-- encrypted Stripe credentials, and payment-before-kitchen release.

ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS ordering_mode VARCHAR(32) NOT NULL DEFAULT 'activation_pin',
    ADD COLUMN IF NOT EXISTS ordering_paused BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS ordering_pause_reason VARCHAR(240),
    ADD COLUMN IF NOT EXISTS ordering_service_hours JSONB,
    ADD COLUMN IF NOT EXISTS require_kds_online BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS kds_heartbeat_timeout_seconds INTEGER NOT NULL DEFAULT 120,
    ADD COLUMN IF NOT EXISTS strict_fifo_kds BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS stripe_secret_key_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS stripe_webhook_secret_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS stripe_payment_mode VARCHAR(32) NOT NULL DEFAULT 'tenant_keys',
    ADD COLUMN IF NOT EXISTS stripe_connected_account_id VARCHAR(128);

CREATE INDEX IF NOT EXISTS ix_tenant_stripe_connected_account_id
    ON tenant (stripe_connected_account_id);

ALTER TABLE "table"
    ADD COLUMN IF NOT EXISTS plaque_status VARCHAR(32) NOT NULL DEFAULT 'not_created',
    ADD COLUMN IF NOT EXISTS plaque_last_tested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS nfc_written_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS nfc_locked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS token_rotated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_table_plaque_status ON "table" (plaque_status);

CREATE TABLE IF NOT EXISTS kitchen_device (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    device_key VARCHAR(64) NOT NULL,
    name VARCHAR(120) NOT NULL,
    display_route VARCHAR(16) NOT NULL DEFAULT 'kitchen',
    station_id INTEGER REFERENCES kitchen_station(id) ON DELETE SET NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_kitchen_device_tenant_key UNIQUE (tenant_id, device_key)
);

CREATE INDEX IF NOT EXISTS ix_kitchen_device_tenant ON kitchen_device (tenant_id);
CREATE INDEX IF NOT EXISTS ix_kitchen_device_key ON kitchen_device (device_key);
CREATE INDEX IF NOT EXISTS ix_kitchen_device_route ON kitchen_device (display_route);
CREATE INDEX IF NOT EXISTS ix_kitchen_device_station ON kitchen_device (station_id);
CREATE INDEX IF NOT EXISTS ix_kitchen_device_last_seen ON kitchen_device (last_seen_at);
CREATE INDEX IF NOT EXISTS ix_kitchen_device_revoked ON kitchen_device (revoked_at);

ALTER TABLE "order"
    ADD COLUMN IF NOT EXISTS requires_prepayment BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS kitchen_released_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_state VARCHAR(32),
    ADD COLUMN IF NOT EXISTS payment_amount_cents INTEGER,
    ADD COLUMN IF NOT EXISTS payment_currency VARCHAR(3),
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(128),
    ADD COLUMN IF NOT EXISTS public_idempotency_key VARCHAR(64),
    ADD COLUMN IF NOT EXISTS checkout_locked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_order_requires_prepayment ON "order" (requires_prepayment);
CREATE INDEX IF NOT EXISTS ix_order_kitchen_released_at ON "order" (kitchen_released_at);
CREATE INDEX IF NOT EXISTS ix_order_payment_state ON "order" (payment_state);
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_stripe_payment_intent_id
    ON "order" (stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_tenant_public_idempotency
    ON "order" (tenant_id, public_idempotency_key)
    WHERE public_idempotency_key IS NOT NULL;

ALTER TABLE "order"
    DROP CONSTRAINT IF EXISTS ck_order_payment_amount_nonnegative;
ALTER TABLE "order"
    ADD CONSTRAINT ck_order_payment_amount_nonnegative
    CHECK (payment_amount_cents IS NULL OR payment_amount_cents >= 0);
