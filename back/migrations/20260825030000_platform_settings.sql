-- Scanaki platform identity, legal links and encrypted global SMTP configuration.
CREATE TABLE IF NOT EXISTS platform_settings (
    id INTEGER PRIMARY KEY,
    company_legal_name VARCHAR(200),
    support_email VARCHAR(320),
    contact_email VARCHAR(320),
    phone VARCHAR(64),
    address TEXT,
    website_url VARCHAR(2048),
    company_number VARCHAR(100),
    vat_number VARCHAR(100),
    terms_url VARCHAR(2048),
    privacy_url VARCHAR(2048),
    smtp_host VARCHAR(255),
    smtp_port INTEGER,
    smtp_use_tls BOOLEAN NOT NULL DEFAULT TRUE,
    smtp_user VARCHAR(320),
    smtp_password_encrypted TEXT,
    email_from VARCHAR(320),
    email_from_name VARCHAR(200),
    smtp_last_tested_at TIMESTAMPTZ,
    smtp_last_test_success BOOLEAN,
    smtp_last_test_message VARCHAR(500),
    updated_by_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_platform_settings_singleton CHECK (id = 1),
    CONSTRAINT ck_platform_settings_smtp_port CHECK (
        smtp_port IS NULL OR (smtp_port >= 1 AND smtp_port <= 65535)
    )
);

-- SQLModel metadata can create the table before migrations in development.
ALTER TABLE platform_settings
    ALTER COLUMN smtp_use_tls SET DEFAULT TRUE,
    ALTER COLUMN created_at SET DEFAULT NOW(),
    ALTER COLUMN updated_at SET DEFAULT NOW();

-- A metadata-first bootstrap may already contain fields introduced by later
-- migrations. Their Python defaults do not apply to this historical SQL insert.
-- Keep legacy schemas valid and preserve every existing singleton value.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
               AND table_name = 'platform_settings' AND column_name = 'smtp_auth_required') THEN
        ALTER TABLE platform_settings ALTER COLUMN smtp_auth_required SET DEFAULT TRUE;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
               AND table_name = 'platform_settings' AND column_name = 'remember_session_days') THEN
        ALTER TABLE platform_settings ALTER COLUMN remember_session_days SET DEFAULT 10;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
               AND table_name = 'platform_settings' AND column_name = 'remember_inactivity_days') THEN
        ALTER TABLE platform_settings ALTER COLUMN remember_inactivity_days SET DEFAULT 5;
    END IF;
END $$;

INSERT INTO platform_settings (id, smtp_use_tls)
VALUES (1, TRUE)
ON CONFLICT (id) DO NOTHING;
