-- Versioned Scanaki tier pricing, scheduled offers, and contracted tenant snapshots.
ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS saas_monthly_price_cents INTEGER,
    ADD COLUMN IF NOT EXISTS saas_extra_table_unit_price_cents INTEGER,
    ADD COLUMN IF NOT EXISTS saas_included_tables INTEGER;

CREATE TABLE IF NOT EXISTS saas_plan_pricing (
    id SERIAL PRIMARY KEY,
    plan_code VARCHAR(16) NOT NULL,
    version INTEGER NOT NULL,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(500),
    regular_price_cents INTEGER NOT NULL CHECK (regular_price_cents >= 0),
    offer_price_cents INTEGER CHECK (offer_price_cents >= 0),
    currency VARCHAR(8) NOT NULL DEFAULT 'gbp',
    billing_interval VARCHAR(16) NOT NULL DEFAULT 'month',
    included_tables INTEGER NOT NULL CHECK (included_tables >= 0),
    extra_table_price_cents INTEGER NOT NULL CHECK (extra_table_price_cents >= 0),
    trial_days INTEGER NOT NULL CHECK (trial_days >= 0),
    offer_badge VARCHAR(80),
    offer_starts_at TIMESTAMPTZ,
    offer_ends_at TIMESTAMPTZ,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    is_public BOOLEAN NOT NULL DEFAULT TRUE,
    stripe_product_id VARCHAR(255),
    stripe_regular_price_id VARCHAR(255),
    stripe_offer_price_id VARCHAR(255),
    stripe_extra_table_price_id VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_saas_plan_pricing_version UNIQUE (plan_code, version),
    CONSTRAINT ck_saas_plan_pricing_offer_window CHECK (
        offer_ends_at IS NULL OR offer_starts_at IS NULL OR offer_ends_at > offer_starts_at
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_plan_pricing_active
    ON saas_plan_pricing (plan_code)
    WHERE is_active = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_plan_pricing_version_idx
    ON saas_plan_pricing (plan_code, version);
CREATE INDEX IF NOT EXISTS idx_saas_plan_pricing_created
    ON saas_plan_pricing (plan_code, created_at DESC);

-- SQLModel metadata may create the table before migrations in development.
ALTER TABLE saas_plan_pricing
    ALTER COLUMN created_at SET DEFAULT NOW(),
    ALTER COLUMN updated_at SET DEFAULT NOW();

CREATE TABLE IF NOT EXISTS saas_pricing_event (
    id SERIAL PRIMARY KEY,
    pricing_id INTEGER REFERENCES saas_plan_pricing(id) ON DELETE SET NULL,
    plan_code VARCHAR(16) NOT NULL,
    action VARCHAR(32) NOT NULL,
    migration_mode VARCHAR(32) NOT NULL DEFAULT 'new_customers_only',
    migrated_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    detail JSONB,
    created_by_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saas_pricing_event_created
    ON saas_pricing_event (created_at DESC);

ALTER TABLE saas_pricing_event
    ALTER COLUMN created_at SET DEFAULT NOW();

INSERT INTO saas_plan_pricing (
    plan_code, version, name, description, regular_price_cents, offer_price_cents,
    currency, billing_interval, included_tables, extra_table_price_cents, trial_days,
    offer_badge, is_featured, is_public, is_active
)
SELECT 'lite', 1, 'Lite', 'A simple start for small venues.', 3497, 999,
       'gbp', 'month', 2, 399, 14, 'Launch deal', FALSE, TRUE, TRUE
WHERE NOT EXISTS (SELECT 1 FROM saas_plan_pricing WHERE plan_code = 'lite' AND is_active = TRUE);

INSERT INTO saas_plan_pricing (
    plan_code, version, name, description, regular_price_cents, offer_price_cents,
    currency, billing_interval, included_tables, extra_table_price_cents, trial_days,
    offer_badge, is_featured, is_public, is_active
)
SELECT 'pro', 1, 'Pro', 'Built for busy restaurants and pubs.', 13997, 3999,
       'gbp', 'month', 20, 399, 14, 'Launch deal', TRUE, TRUE, TRUE
WHERE NOT EXISTS (SELECT 1 FROM saas_plan_pricing WHERE plan_code = 'pro' AND is_active = TRUE);

INSERT INTO saas_plan_pricing (
    plan_code, version, name, description, regular_price_cents, offer_price_cents,
    currency, billing_interval, included_tables, extra_table_price_cents, trial_days,
    offer_badge, is_featured, is_public, is_active
)
SELECT 'ultra', 1, 'Ultra', 'More capacity for larger hospitality teams.', 29747, 8499,
       'gbp', 'month', 45, 399, 14, 'Launch deal', FALSE, TRUE, TRUE
WHERE NOT EXISTS (SELECT 1 FROM saas_plan_pricing WHERE plan_code = 'ultra' AND is_active = TRUE);
