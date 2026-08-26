-- Let each restaurant choose split Kitchen/Bar routing or one combined Kitchen queue.
ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS kds_routing_mode VARCHAR(24) NOT NULL DEFAULT 'split';

UPDATE tenant
SET kds_routing_mode = 'split'
WHERE kds_routing_mode IS NULL OR kds_routing_mode NOT IN ('split', 'kitchen_all');
