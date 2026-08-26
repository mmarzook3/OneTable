-- Restaurant smart-plaque requests and fulfilment lifecycle.

CREATE TABLE IF NOT EXISTS smart_plaque_request (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    requested_by_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    quantity INTEGER NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'requested',
    delivery_contact_name VARCHAR(160) NOT NULL,
    delivery_address VARCHAR(500) NOT NULL,
    restaurant_notes VARCHAR(500),
    platform_notes VARCHAR(500),
    tracking_reference VARCHAR(160),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    preparing_at TIMESTAMPTZ,
    shipped_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    declined_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_smart_plaque_request_quantity CHECK (quantity BETWEEN 1 AND 100),
    CONSTRAINT ck_smart_plaque_request_status CHECK (
        status IN ('requested', 'approved', 'preparing', 'shipped', 'delivered', 'completed', 'declined', 'cancelled')
    )
);

CREATE INDEX IF NOT EXISTS ix_smart_plaque_request_tenant_id
    ON smart_plaque_request(tenant_id);
CREATE INDEX IF NOT EXISTS ix_smart_plaque_request_status
    ON smart_plaque_request(status);
CREATE INDEX IF NOT EXISTS ix_smart_plaque_request_requested_at
    ON smart_plaque_request(requested_at);

ALTER TABLE smart_plaque
    ADD COLUMN IF NOT EXISTS request_id INTEGER REFERENCES smart_plaque_request(id) ON DELETE SET NULL;
ALTER TABLE smart_plaque
    ADD COLUMN IF NOT EXISTS installed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_smart_plaque_request_id ON smart_plaque(request_id);

ALTER TABLE smart_plaque DROP CONSTRAINT IF EXISTS ck_smart_plaque_status;
ALTER TABLE smart_plaque ADD CONSTRAINT ck_smart_plaque_status
    CHECK (status IN (
        'available', 'reserved', 'preparing', 'shipped', 'delivered',
        'assigned', 'tested', 'installed', 'disabled', 'retired'
    ));

CREATE TABLE IF NOT EXISTS smart_plaque_request_event (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES smart_plaque_request(id) ON DELETE CASCADE,
    action VARCHAR(32) NOT NULL,
    actor_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_smart_plaque_request_event_request_id
    ON smart_plaque_request_event(request_id);
CREATE INDEX IF NOT EXISTS ix_smart_plaque_request_event_action
    ON smart_plaque_request_event(action);
CREATE INDEX IF NOT EXISTS ix_smart_plaque_request_event_created_at
    ON smart_plaque_request_event(created_at);
