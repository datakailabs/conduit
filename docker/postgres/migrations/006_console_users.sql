-- Migration 006: Console Users
-- Links Cognito identities to organizations for console access.
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS console_users (
    id TEXT PRIMARY KEY,
    cognito_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_console_users_cognito_sub ON console_users(cognito_sub);
CREATE INDEX IF NOT EXISTS idx_console_users_org ON console_users(organization_id);
CREATE INDEX IF NOT EXISTS idx_console_users_email ON console_users(email);

-- Grant permissions
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conduit') THEN
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO conduit';
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO conduit';
    END IF;
END $$;
