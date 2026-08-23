-- Reusable OneTable QR/NFC plaques. The permanent public code belongs to the
-- physical plaque; its tenant/table assignment can change without reprinting
-- the QR code or rewriting a locked NFC tag.

CREATE TABLE IF NOT EXISTS smart_plaque (
    id SERIAL PRIMARY KEY,
    public_code VARCHAR(64) NOT NULL UNIQUE,
    batch_label VARCHAR(100),
    status VARCHAR(24) NOT NULL DEFAULT 'available',
    assigned_tenant_id INTEGER REFERENCES tenant(id) ON DELETE SET NULL,
    table_id INTEGER REFERENCES "table"(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    assigned_by_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_at TIMESTAMPTZ,
    nfc_written_at TIMESTAMPTZ,
    nfc_verified_at TIMESTAMPTZ,
    nfc_locked_at TIMESTAMPTZ,
    CONSTRAINT ck_smart_plaque_status
        CHECK (status IN ('available', 'assigned', 'disabled', 'retired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_smart_plaque_table_id
    ON smart_plaque(table_id)
    WHERE table_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_smart_plaque_assigned_tenant_id
    ON smart_plaque(assigned_tenant_id);
CREATE INDEX IF NOT EXISTS ix_smart_plaque_status
    ON smart_plaque(status);
CREATE INDEX IF NOT EXISTS ix_smart_plaque_batch_label
    ON smart_plaque(batch_label);

CREATE TABLE IF NOT EXISTS smart_plaque_assignment_event (
    id SERIAL PRIMARY KEY,
    plaque_id INTEGER NOT NULL REFERENCES smart_plaque(id) ON DELETE CASCADE,
    action VARCHAR(32) NOT NULL,
    from_tenant_id INTEGER,
    from_table_id INTEGER,
    to_tenant_id INTEGER,
    to_table_id INTEGER,
    actor_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_smart_plaque_assignment_event_plaque_id
    ON smart_plaque_assignment_event(plaque_id);
CREATE INDEX IF NOT EXISTS ix_smart_plaque_assignment_event_created_at
    ON smart_plaque_assignment_event(created_at);
