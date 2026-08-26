-- Scanaki tenant locations, room/table ordering points and immutable order context.

CREATE TABLE IF NOT EXISTS tenant_location (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    display_name VARCHAR(160) NOT NULL,
    slug VARCHAR(120) NOT NULL,
    location_type VARCHAR(32) NOT NULL DEFAULT 'pub',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    menu_mode VARCHAR(16) NOT NULL DEFAULT 'inherit',
    hours_mode VARCHAR(16) NOT NULL DEFAULT 'inherit',
    kitchen_mode VARCHAR(16) NOT NULL DEFAULT 'inherit',
    payment_mode VARCHAR(16) NOT NULL DEFAULT 'inherit',
    opening_hours_override JSONB,
    ordering_hours_override JSONB,
    default_kitchen_station_id INTEGER REFERENCES kitchen_station(id) ON DELETE SET NULL,
    payment_account_reference VARCHAR(128),
    ordering_paused BOOLEAN NOT NULL DEFAULT FALSE,
    ordering_pause_reason VARCHAR(240),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_tenant_location_type CHECK (location_type IN ('pub', 'lounge', 'hotel_building', 'other')),
    CONSTRAINT ck_tenant_location_menu_mode CHECK (menu_mode IN ('inherit', 'override')),
    CONSTRAINT ck_tenant_location_hours_mode CHECK (hours_mode IN ('inherit', 'override')),
    CONSTRAINT ck_tenant_location_kitchen_mode CHECK (kitchen_mode IN ('inherit', 'override')),
    CONSTRAINT ck_tenant_location_payment_mode CHECK (payment_mode IN ('inherit', 'override')),
    CONSTRAINT uq_tenant_location_tenant_slug UNIQUE (tenant_id, slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_location_tenant_name_ci
    ON tenant_location (tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS ix_tenant_location_tenant_active
    ON tenant_location (tenant_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS ix_tenant_location_default_kitchen
    ON tenant_location (default_kitchen_station_id);

ALTER TABLE tenant_location
    ALTER COLUMN is_active SET DEFAULT TRUE,
    ALTER COLUMN sort_order SET DEFAULT 0,
    ALTER COLUMN menu_mode SET DEFAULT 'inherit',
    ALTER COLUMN hours_mode SET DEFAULT 'inherit',
    ALTER COLUMN kitchen_mode SET DEFAULT 'inherit',
    ALTER COLUMN payment_mode SET DEFAULT 'inherit',
    ALTER COLUMN ordering_paused SET DEFAULT FALSE,
    ALTER COLUMN created_at SET DEFAULT NOW(),
    ALTER COLUMN updated_at SET DEFAULT NOW();

INSERT INTO tenant_location (
    tenant_id, name, display_name, slug, location_type, is_active, sort_order,
    menu_mode, hours_mode, kitchen_mode, payment_mode, ordering_paused,
    created_at, updated_at
)
SELECT
    t.id,
    t.name,
    t.name,
    COALESCE(
        NULLIF(trim(BOTH '-' FROM regexp_replace(lower(t.name), '[^a-z0-9]+', '-', 'g')), ''),
        'main-location'
    ),
    CASE WHEN t.business_type::text = 'bar' THEN 'pub' ELSE 'other' END,
    TRUE, 0,
    'inherit', 'inherit', 'inherit', 'inherit', FALSE, NOW(), NOW()
FROM tenant t
WHERE NOT EXISTS (
    SELECT 1 FROM tenant_location l WHERE l.tenant_id = t.id
);

-- The approved pilot identity uses four locations without inventing room/table numbers.
UPDATE tenant_location l
SET name = 'The Yew Trees',
    display_name = 'The Yew Trees',
    slug = 'the-yew-trees',
    location_type = 'pub',
    sort_order = 0,
    updated_at = NOW()
FROM tenant t
WHERE l.tenant_id = t.id
  AND t.name = 'The Yew Trees Pub'
  AND l.id = (
      SELECT l2.id FROM tenant_location l2
      WHERE l2.tenant_id = t.id
      ORDER BY l2.sort_order, l2.id
      LIMIT 1
  );

UPDATE tenant
SET saas_plan_code = 'pro',
    saas_included_tables = GREATEST(COALESCE(saas_included_tables, 0), 20)
WHERE name = 'The Yew Trees Pub';

INSERT INTO tenant_location (
    tenant_id, name, display_name, slug, location_type, is_active, sort_order,
    menu_mode, hours_mode, kitchen_mode, payment_mode, ordering_paused,
    created_at, updated_at
)
SELECT t.id, v.name, v.display_name, v.slug, v.location_type, TRUE, v.sort_order,
       'inherit', 'inherit', 'inherit', 'inherit', FALSE, NOW(), NOW()
FROM tenant t
CROSS JOIN (VALUES
    ('Sports Lounge', 'Sports Lounge', 'sports-lounge', 'lounge', 10),
    ('Premium Building', 'Blaby Hotel - Premium Building', 'premium-building', 'hotel_building', 20),
    ('Main Building', 'Blaby Hotel - Main Building', 'main-building', 'hotel_building', 30)
) AS v(name, display_name, slug, location_type, sort_order)
WHERE t.name = 'The Yew Trees Pub'
  AND NOT EXISTS (
      SELECT 1 FROM tenant_location l
      WHERE l.tenant_id = t.id AND l.slug = v.slug
  );

ALTER TABLE "table"
    ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES tenant_location(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS service_point_type VARCHAR(16) NOT NULL DEFAULT 'table',
    ADD COLUMN IF NOT EXISTS display_number VARCHAR(64),
    ADD COLUMN IF NOT EXISTS customer_label VARCHAR(120),
    ADD COLUMN IF NOT EXISTS is_ordering_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS assignment_version INTEGER NOT NULL DEFAULT 1;

UPDATE "table" p
SET location_id = (
        SELECT l.id FROM tenant_location l
        WHERE l.tenant_id = p.tenant_id
        ORDER BY l.sort_order, l.id
        LIMIT 1
    )
WHERE p.location_id IS NULL;

UPDATE "table"
SET display_number = COALESCE(
    NULLIF(trim(regexp_replace(name, '^(table|room)\s*', '', 'i')), ''),
    name
)
WHERE display_number IS NULL OR trim(display_number) = '';

ALTER TABLE "table" ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE "table" ALTER COLUMN display_number SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_table_service_point_type'
    ) THEN
        ALTER TABLE "table" ADD CONSTRAINT ck_table_service_point_type
            CHECK (service_point_type IN ('table', 'room'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_table_location_id ON "table" (location_id);
CREATE INDEX IF NOT EXISTS ix_table_tenant_ordering_enabled
    ON "table" (tenant_id, is_ordering_enabled);
CREATE UNIQUE INDEX IF NOT EXISTS ux_table_location_display_number_ci
    ON "table" (location_id, lower(display_number));

CREATE OR REPLACE FUNCTION scanaki_create_default_location_for_tenant()
RETURNS TRIGGER AS $$
DECLARE
    generated_slug TEXT;
BEGIN
    generated_slug := COALESCE(
        NULLIF(trim(BOTH '-' FROM regexp_replace(lower(NEW.name), '[^a-z0-9]+', '-', 'g')), ''),
        'main-location'
    );
    INSERT INTO tenant_location (
        tenant_id, name, display_name, slug, location_type, is_active, sort_order,
        menu_mode, hours_mode, kitchen_mode, payment_mode, ordering_paused,
        created_at, updated_at
    ) VALUES (
        NEW.id, NEW.name, NEW.name, generated_slug, 'other', TRUE, 0,
        'inherit', 'inherit', 'inherit', 'inherit', FALSE, NOW(), NOW()
    ) ON CONFLICT (tenant_id, slug) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scanaki_tenant_default_location ON tenant;
CREATE TRIGGER trg_scanaki_tenant_default_location
AFTER INSERT ON tenant
FOR EACH ROW EXECUTE FUNCTION scanaki_create_default_location_for_tenant();

CREATE OR REPLACE FUNCTION scanaki_prepare_ordering_point()
RETURNS TRIGGER AS $$
DECLARE
    location_tenant INTEGER;
BEGIN
    IF NEW.location_id IS NULL THEN
        SELECT id INTO NEW.location_id
        FROM tenant_location
        WHERE tenant_id = NEW.tenant_id AND is_active = TRUE
        ORDER BY sort_order, id
        LIMIT 1;
    END IF;
    SELECT tenant_id INTO location_tenant FROM tenant_location WHERE id = NEW.location_id;
    IF location_tenant IS NULL OR location_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION 'ordering point location must belong to tenant';
    END IF;
    IF NEW.display_number IS NULL OR trim(NEW.display_number) = '' THEN
        NEW.display_number := COALESCE(
            NULLIF(trim(regexp_replace(NEW.name, '^(table|room)\s*', '', 'i')), ''),
            NEW.name
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scanaki_prepare_ordering_point ON "table";
CREATE TRIGGER trg_scanaki_prepare_ordering_point
BEFORE INSERT ON "table"
FOR EACH ROW EXECUTE FUNCTION scanaki_prepare_ordering_point();

CREATE OR REPLACE FUNCTION scanaki_bump_ordering_point_assignment()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.location_id IS DISTINCT FROM NEW.location_id
       OR OLD.service_point_type IS DISTINCT FROM NEW.service_point_type
       OR OLD.display_number IS DISTINCT FROM NEW.display_number THEN
        NEW.assignment_version := GREATEST(COALESCE(OLD.assignment_version, 1) + 1, 2);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scanaki_bump_ordering_point_assignment ON "table";
CREATE TRIGGER trg_scanaki_bump_ordering_point_assignment
BEFORE UPDATE OF location_id, service_point_type, display_number ON "table"
FOR EACH ROW EXECUTE FUNCTION scanaki_bump_ordering_point_assignment();

CREATE TABLE IF NOT EXISTS location_menu_product (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES tenant_location(id) ON DELETE CASCADE,
    tenant_product_id INTEGER REFERENCES tenantproduct(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES product(id) ON DELETE CASCADE,
    enabled BOOLEAN,
    price_cents_override INTEGER CHECK (price_cents_override >= 0),
    category_override VARCHAR(120),
    sort_order_override INTEGER,
    available_from DATE,
    available_until DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_location_menu_product_source CHECK (num_nonnulls(tenant_product_id, product_id) = 1),
    CONSTRAINT uq_location_menu_product_tenant_product UNIQUE (location_id, tenant_product_id),
    CONSTRAINT uq_location_menu_product_product UNIQUE (location_id, product_id)
);
CREATE INDEX IF NOT EXISTS ix_location_menu_product_location ON location_menu_product (location_id);
CREATE INDEX IF NOT EXISTS ix_location_menu_product_tenant ON location_menu_product (tenant_id);

CREATE TABLE IF NOT EXISTS location_date_override (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES tenant_location(id) ON DELETE CASCADE,
    override_date DATE NOT NULL,
    is_closed BOOLEAN NOT NULL DEFAULT FALSE,
    opening_hours JSONB,
    ordering_hours JSONB,
    note VARCHAR(240),
    CONSTRAINT uq_location_date_override UNIQUE (location_id, override_date)
);
CREATE INDEX IF NOT EXISTS ix_location_date_override_tenant_date
    ON location_date_override (tenant_id, override_date);

ALTER TABLE "order"
    ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES tenant_location(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS location_name_snapshot VARCHAR(160),
    ADD COLUMN IF NOT EXISTS service_point_type_snapshot VARCHAR(16),
    ADD COLUMN IF NOT EXISTS service_point_label_snapshot VARCHAR(120),
    ADD COLUMN IF NOT EXISTS kitchen_station_id_snapshot INTEGER REFERENCES kitchen_station(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS payment_account_snapshot VARCHAR(128),
    ADD COLUMN IF NOT EXISTS ordering_point_assignment_version_snapshot INTEGER;

UPDATE "order" o
SET location_id = p.location_id,
    location_name_snapshot = COALESCE(l.display_name, l.name),
    service_point_type_snapshot = p.service_point_type,
    service_point_label_snapshot = COALESCE(
        p.customer_label,
        CASE WHEN p.service_point_type = 'room' THEN 'Room ' ELSE 'Table ' END || p.display_number
    ),
    ordering_point_assignment_version_snapshot = p.assignment_version
FROM "table" p
LEFT JOIN tenant_location l ON l.id = p.location_id
WHERE o.table_id = p.id
  AND o.location_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_order_location_id ON "order" (location_id);
CREATE INDEX IF NOT EXISTS ix_order_kitchen_station_snapshot
    ON "order" (kitchen_station_id_snapshot);

CREATE TABLE IF NOT EXISTS location_audit_event (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    location_id INTEGER REFERENCES tenant_location(id) ON DELETE SET NULL,
    table_id INTEGER REFERENCES "table"(id) ON DELETE SET NULL,
    action VARCHAR(64) NOT NULL,
    actor_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_location_audit_event_tenant_created
    ON location_audit_event (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_location_audit_event_location
    ON location_audit_event (location_id);
