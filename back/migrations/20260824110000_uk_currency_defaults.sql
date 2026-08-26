-- Migration: UK currency defaults
-- Description: default new and unconfigured tenants to GBP with the pound symbol
-- Date: 2026-08-24

ALTER TABLE tenant
    ALTER COLUMN currency_code SET DEFAULT 'GBP';

ALTER TABLE tenant
    ALTER COLUMN currency SET DEFAULT '£';

UPDATE tenant
SET currency_code = 'GBP', currency = '£'
WHERE currency_code IS NULL OR btrim(currency_code) = '';
