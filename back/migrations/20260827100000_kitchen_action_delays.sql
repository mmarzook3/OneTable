-- Configurable Kitchen action safety timings.
ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS kitchen_action_hold_seconds INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS kitchen_action_cooldown_seconds INTEGER NOT NULL DEFAULT 2;

ALTER TABLE tenant
    DROP CONSTRAINT IF EXISTS ck_tenant_kitchen_action_hold_seconds,
    ADD CONSTRAINT ck_tenant_kitchen_action_hold_seconds
        CHECK (kitchen_action_hold_seconds BETWEEN 1 AND 5),
    DROP CONSTRAINT IF EXISTS ck_tenant_kitchen_action_cooldown_seconds,
    ADD CONSTRAINT ck_tenant_kitchen_action_cooldown_seconds
        CHECK (kitchen_action_cooldown_seconds BETWEEN 0 AND 30);
