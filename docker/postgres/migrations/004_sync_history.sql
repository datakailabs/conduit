-- Migration 004: Sync History
-- Tracks every connector sync operation with stats and cursor state.
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS sync_history (
    id BIGSERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    connector_type TEXT NOT NULL,
    connector_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
    docs_discovered INT NOT NULL DEFAULT 0,
    docs_new INT NOT NULL DEFAULT 0,
    docs_updated INT NOT NULL DEFAULT 0,
    docs_deleted INT NOT NULL DEFAULT 0,
    docs_unchanged INT NOT NULL DEFAULT 0,
    docs_failed INT NOT NULL DEFAULT 0,
    duration_ms INT,
    cursor_state JSONB,
    error_summary TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_history_org_connector
    ON sync_history(organization_id, connector_type, connector_name);
CREATE INDEX IF NOT EXISTS idx_sync_history_completed
    ON sync_history(completed_at DESC);

-- Grant permissions
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conduit') THEN
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO conduit';
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO conduit';
    END IF;
END $$;
