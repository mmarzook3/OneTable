-- One Table restaurant provisioning and resumable first-login onboarding.
-- Existing tenants are complete by default; platform-created tenants opt in to onboarding.

ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS onboarding_status VARCHAR(32) NOT NULL DEFAULT 'completed',
    ADD COLUMN IF NOT EXISTS onboarding_step INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS onboarding_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS temporary_password_issued_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_tenant_onboarding_status
    ON tenant (onboarding_status);

