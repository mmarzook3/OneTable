-- Give username-based platform operators a separate, deliverable recovery inbox.
ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS recovery_email VARCHAR(320);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_recovery_email_lower
    ON "user" (LOWER(recovery_email))
    WHERE recovery_email IS NOT NULL;
