-- Migration: explicit fictional demo tenants for the public marketing landing page
-- Description: prevents real customer tenants from being used as public demo content
-- Date: 2026-08-24

ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS ix_tenant_is_demo ON tenant (is_demo);

COMMENT ON COLUMN tenant.is_demo IS
    'True only for fictional tenants that may be listed on the public marketing landing page';
