-- Repair deployments where SQLModel metadata created the smart-plaque tables
-- just before the versioned migration. Ensure deleting an available plaque
-- also deletes only its own assignment-history rows.

ALTER TABLE smart_plaque_assignment_event
    DROP CONSTRAINT IF EXISTS smart_plaque_assignment_event_plaque_id_fkey;
ALTER TABLE smart_plaque_assignment_event
    ADD CONSTRAINT smart_plaque_assignment_event_plaque_id_fkey
    FOREIGN KEY (plaque_id) REFERENCES smart_plaque(id) ON DELETE CASCADE;
