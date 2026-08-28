-- Durable KDS heartbeat transition diagnostics. Clients buffer failures locally and
-- upload them after recovery, so failures that never reached the server remain visible.
CREATE TABLE IF NOT EXISTS kitchen_heartbeat_diagnostic (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    device_key VARCHAR(64) NOT NULL,
    source VARCHAR(16) NOT NULL,
    outcome VARCHAR(32) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status_code INTEGER NULL,
    duration_ms INTEGER NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    network_type VARCHAR(32) NULL,
    wifi_enabled BOOLEAN NULL,
    network_validated BOOLEAN NULL,
    detail VARCHAR(500) NULL
);

CREATE INDEX IF NOT EXISTS ix_kitchen_heartbeat_diagnostic_tenant_id
    ON kitchen_heartbeat_diagnostic (tenant_id);
CREATE INDEX IF NOT EXISTS ix_kitchen_heartbeat_diagnostic_device_key
    ON kitchen_heartbeat_diagnostic (device_key);
CREATE INDEX IF NOT EXISTS ix_kitchen_heartbeat_diagnostic_occurred_at
    ON kitchen_heartbeat_diagnostic (occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_kitchen_heartbeat_diagnostic_outcome
    ON kitchen_heartbeat_diagnostic (outcome);
