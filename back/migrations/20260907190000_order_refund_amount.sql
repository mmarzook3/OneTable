-- Legacy refunded states include partial refunds: do not guess their amounts.
-- Keep replay safe when --sync-idempotent runs after new refunds are recorded.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'order'
          AND column_name = 'refunded_amount_cents'
    ) THEN
        ALTER TABLE "order" ADD COLUMN refunded_amount_cents INTEGER DEFAULT 0
            CHECK (refunded_amount_cents >= 0);
        UPDATE "order" SET refunded_amount_cents = NULL
            WHERE payment_state IN ('refunded', 'partially_refunded');
    END IF;
END $$;
