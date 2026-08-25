-- Complete Scanaki platform subscription operations and reporting.
ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS saas_cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS saas_suspended_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS saas_last_payment_failed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS saas_last_payment_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS saas_last_invoice_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS saas_last_invoice_status VARCHAR(32),
    ADD COLUMN IF NOT EXISTS saas_last_invoice_amount_cents INTEGER,
    ADD COLUMN IF NOT EXISTS saas_last_invoice_currency VARCHAR(8);

CREATE TABLE IF NOT EXISTS saas_subscription_event (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'system',
    old_status VARCHAR(32),
    new_status VARCHAR(32),
    plan_code VARCHAR(16),
    amount_cents INTEGER,
    currency VARCHAR(8),
    stripe_event_id VARCHAR(255),
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_subscription_event_stripe_event
    ON saas_subscription_event (stripe_event_id)
    WHERE stripe_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saas_subscription_event_tenant_created
    ON saas_subscription_event (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saas_subscription_event_type_created
    ON saas_subscription_event (event_type, created_at DESC);
