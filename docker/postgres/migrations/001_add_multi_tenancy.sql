-- Multi-tenancy migration (idempotent)
-- Adds organizations table and organization_id to chunks

-- Create organizations table if not exists
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    admin_key TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_api_key ON organizations(api_key);
CREATE INDEX IF NOT EXISTS idx_organizations_admin_key ON organizations(admin_key);

-- Seed default organization if not exists
INSERT INTO organizations (id, name, api_key, admin_key)
VALUES ('org_datakai', 'DataKai', 'default_api_key_placeholder', 'default_admin_key_placeholder')
ON CONFLICT (id) DO NOTHING;

-- Add organization_id column to chunks if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'chunks' AND column_name = 'organization_id'
    ) THEN
        ALTER TABLE chunks ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_datakai' REFERENCES organizations(id);
        CREATE INDEX idx_chunks_org_zettel ON chunks(organization_id, zettel_id);
    END IF;
END $$;
