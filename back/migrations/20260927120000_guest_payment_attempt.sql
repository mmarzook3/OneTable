CREATE TABLE IF NOT EXISTS guest_payment_attempt (
    id varchar(36) PRIMARY KEY,
    tenant_id integer NOT NULL REFERENCES tenant(id),
    order_id integer NOT NULL REFERENCES "order"(id),
    session_hash varchar(64) NOT NULL,
    item_ids jsonb NOT NULL,
    amount_cents integer NOT NULL CHECK (amount_cents > 0),
    currency varchar(3) NOT NULL,
    account_binding varchar(128) NOT NULL,
    stripe_payment_intent_id varchar(128) UNIQUE,
    state varchar(32) NOT NULL DEFAULT 'creating',
    refunded_amount_cents integer NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_guest_payment_attempt_order_id ON guest_payment_attempt(order_id);
CREATE INDEX IF NOT EXISTS ix_guest_payment_attempt_tenant_id ON guest_payment_attempt(tenant_id);
CREATE INDEX IF NOT EXISTS ix_guest_payment_attempt_session_hash ON guest_payment_attempt(session_hash);
