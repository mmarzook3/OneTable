-- Migration: per-tenant Scanaki Delivery availability switch
-- Description: allow a restaurant to disable new first-party delivery orders while retaining table ordering and reservations
-- Date: 2026-08-24

ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS delivery_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN tenant.delivery_enabled IS
    'When false, public and staff first-party Scanaki Delivery checkout creation is disabled';
