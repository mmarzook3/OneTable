-- Scanaki controlled-beta readiness: plans, invitations, product availability and allergens.
ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS saas_plan_code VARCHAR(16) NOT NULL DEFAULT 'lite',
    ADD COLUMN IF NOT EXISTS saas_extra_tables INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS invitation_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS invitation_last_error VARCHAR(500);

UPDATE tenant
SET saas_plan_code = CASE
    WHEN (SELECT count(*) FROM "table" t WHERE t.tenant_id = tenant.id) <= 2 THEN 'lite'
    WHEN (SELECT count(*) FROM "table" t WHERE t.tenant_id = tenant.id) <= 20 THEN 'pro'
    ELSE 'ultra'
END
WHERE saas_plan_code IS NULL OR saas_plan_code = '' OR saas_subscription_status = 'grandfathered';

ALTER TABLE product
    ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS allergens JSONB,
    ADD COLUMN IF NOT EXISTS dietary_tags JSONB,
    ADD COLUMN IF NOT EXISTS allergen_notes TEXT,
    ADD COLUMN IF NOT EXISTS allergen_reviewed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_product_tenant_available
    ON product (tenant_id, is_available);
