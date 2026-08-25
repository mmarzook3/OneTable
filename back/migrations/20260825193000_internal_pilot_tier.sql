-- Internal, unpublished Pilot tier with unlimited ordering points and all UI modules.

INSERT INTO saas_plan_pricing (
    plan_code,
    version,
    name,
    description,
    regular_price_cents,
    offer_price_cents,
    currency,
    billing_interval,
    included_tables,
    extra_table_price_cents,
    trial_days,
    offer_badge,
    is_featured,
    is_public,
    is_active,
    created_at,
    updated_at
)
SELECT
    'pilot',
    1,
    'Pilot',
    'Internal full-feature tier for approved pilot customers.',
    0,
    NULL,
    'gbp',
    'month',
    10000,
    0,
    0,
    'Internal pilot',
    FALSE,
    FALSE,
    TRUE,
    NOW(),
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM saas_plan_pricing
    WHERE plan_code = 'pilot' AND is_active = TRUE
);

UPDATE tenant
SET saas_plan_code = 'pilot',
    saas_extra_tables = 0,
    saas_included_tables = 10000,
    saas_monthly_price_cents = 0,
    saas_extra_table_unit_price_cents = 0,
    saas_subscription_status = CASE
        WHEN saas_stripe_subscription_id IS NULL THEN 'grandfathered'
        ELSE saas_subscription_status
    END,
    saas_trial_ends_at = CASE
        WHEN saas_stripe_subscription_id IS NULL THEN NULL
        ELSE saas_trial_ends_at
    END,
    ui_modules = NULL
WHERE name = 'The Yew Trees Pub';
