-- Platform-controlled remembered staff/Kitchen session policy.
ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS remember_session_days INTEGER NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS remember_inactivity_days INTEGER NOT NULL DEFAULT 5;

ALTER TABLE platform_settings
    DROP CONSTRAINT IF EXISTS ck_platform_settings_remember_session_days,
    ADD CONSTRAINT ck_platform_settings_remember_session_days
        CHECK (remember_session_days BETWEEN 1 AND 90),
    DROP CONSTRAINT IF EXISTS ck_platform_settings_remember_inactivity_days,
    ADD CONSTRAINT ck_platform_settings_remember_inactivity_days
        CHECK (remember_inactivity_days BETWEEN 1 AND 30),
    DROP CONSTRAINT IF EXISTS ck_platform_settings_remember_idle_within_session,
    ADD CONSTRAINT ck_platform_settings_remember_idle_within_session
        CHECK (remember_inactivity_days <= remember_session_days);
