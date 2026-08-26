-- Allow the platform SMTP configuration to use a Google Workspace
-- IP-authenticated relay without storing a mailbox password.
ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS smtp_auth_required BOOLEAN NOT NULL DEFAULT TRUE;
