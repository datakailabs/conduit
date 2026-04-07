-- Migration 005: Raw Document Store
-- Stores raw source content before parsing/enrichment.
-- Enables reprocessing without re-fetching from source.
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS raw_documents (
    id BIGSERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    connector_type TEXT NOT NULL,
    connector_name TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    raw_content TEXT NOT NULL,
    raw_size_bytes INT NOT NULL,
    format TEXT,           -- detected file format (markdown, html, etc.)
    source_path TEXT,      -- original file path or URL
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Dedup: only store latest version per source
    UNIQUE (organization_id, connector_type, connector_name, source_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_docs_org_connector
    ON raw_documents(organization_id, connector_type, connector_name);
CREATE INDEX IF NOT EXISTS idx_raw_docs_source
    ON raw_documents(source_id);
CREATE INDEX IF NOT EXISTS idx_raw_docs_fetched
    ON raw_documents(fetched_at DESC);

-- Grant permissions
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conduit') THEN
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO conduit';
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO conduit';
    END IF;
END $$;
