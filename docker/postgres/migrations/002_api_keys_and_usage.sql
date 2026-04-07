-- Migration 002: API Keys and Usage Events
-- Adds hashed API key storage and usage metering tables
-- Idempotent: safe to run multiple times

-- api_keys: hashed key storage (replaces plaintext on organizations)
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    key_type TEXT NOT NULL CHECK (key_type IN ('api', 'admin')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
    ON api_keys(key_hash) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_api_keys_org
    ON api_keys(organization_id);

-- usage_events: append-only metering log
CREATE TABLE IF NOT EXISTS usage_events (
    id BIGSERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('search', 'ingest', 'delete', 'context')),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_org_created
    ON usage_events(organization_id, created_at DESC);

-- Add email column to organizations (nullable for existing rows)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'organizations' AND column_name = 'email'
    ) THEN
        ALTER TABLE organizations ADD COLUMN email TEXT;
    END IF;
END $$;

-- Make api_key and admin_key nullable for new orgs that use api_keys table
-- (existing orgs keep their values; new orgs get placeholder UUIDs)
DO $$
BEGIN
    -- Drop NOT NULL if it exists on api_key
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'organizations' AND column_name = 'api_key' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE organizations ALTER COLUMN api_key DROP NOT NULL;
    END IF;

    -- Drop NOT NULL if it exists on admin_key
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'organizations' AND column_name = 'admin_key' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE organizations ALTER COLUMN admin_key DROP NOT NULL;
    END IF;
END $$;

-- Grant permissions on new tables
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conduit') THEN
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO conduit';
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO conduit';
    END IF;
END $$;
