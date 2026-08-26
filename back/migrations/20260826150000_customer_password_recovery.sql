-- End-user customer password recovery. User/provider/courier/platform accounts
-- continue using password_reset_token; customer accounts remain separately scoped.

ALTER TABLE customer
    ADD COLUMN IF NOT EXISTS password_reset_token_hash VARCHAR(64);
ALTER TABLE customer
    ADD COLUMN IF NOT EXISTS password_reset_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_customer_password_reset_token_hash
    ON customer(password_reset_token_hash)
    WHERE password_reset_token_hash IS NOT NULL;
