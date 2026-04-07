-- Conduit PostgreSQL Schema
-- Used by Docker Compose for fresh dev containers (docker-entrypoint-initdb.d).
-- Schema source of truth: /schema.hcl (managed by Atlas).
-- For existing deployments: atlas schema apply --env dev|prod

-- ─── Extensions ─────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Organizations ──────────────────────────────────────────────────

CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    api_key TEXT UNIQUE,
    admin_key TEXT UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organizations_api_key ON organizations(api_key);
CREATE INDEX idx_organizations_admin_key ON organizations(admin_key);

-- Seed default organization (used in single-tenant mode)
INSERT INTO organizations (id, name, api_key, admin_key)
VALUES ('org_datakai', 'DataKai', 'default_api_key_placeholder', 'default_admin_key_placeholder');

-- ─── Chunks (Vector Embeddings) ─────────────────────────────────────

CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL DEFAULT 'org_datakai' REFERENCES organizations(id),
    zettel_id TEXT NOT NULL,
    zettel_title TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,

    -- Vector embedding (1536 dimensions for text-embedding-3-small)
    embedding vector(1536),

    -- Metadata
    domains TEXT[] NOT NULL DEFAULT '{}',
    topics TEXT[] NOT NULL DEFAULT '{}',
    knowledge_type TEXT NOT NULL DEFAULT 'concept',
    context_source TEXT NOT NULL DEFAULT 'experience',
    source_url TEXT,
    provenance JSONB,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chunks_org_zettel ON chunks(organization_id, zettel_id);
CREATE INDEX idx_chunks_zettel_id ON chunks(zettel_id);
CREATE INDEX idx_chunks_knowledge_type ON chunks(knowledge_type);
CREATE INDEX idx_chunks_created_at ON chunks(created_at);
CREATE INDEX idx_chunks_domains ON chunks USING GIN(domains);
CREATE INDEX idx_chunks_topics ON chunks USING GIN(topics);
CREATE INDEX idx_chunks_provenance ON chunks USING GIN(provenance);
CREATE INDEX idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_chunks_updated_at
    BEFORE UPDATE ON chunks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ─── API Keys (Hashed Storage) ──────────────────────────────────────

CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    key_type TEXT NOT NULL CHECK (key_type IN ('api', 'admin')),
    scope TEXT NOT NULL DEFAULT 'admin',
    kai_ids TEXT[] DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_hash_active ON api_keys(key_hash) WHERE is_active = TRUE;
CREATE INDEX idx_api_keys_org ON api_keys(organization_id);

-- ─── Usage Events (Append-Only Metering) ────────────────────────────

CREATE TABLE usage_events (
    id BIGSERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('search', 'ingest', 'delete', 'context', 'ask')),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_events_org_created ON usage_events(organization_id, created_at DESC);

-- ─── Sync History ───────────────────────────────────────────────────

CREATE TABLE sync_history (
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

CREATE INDEX idx_sync_history_org_connector
    ON sync_history(organization_id, connector_type, connector_name);
CREATE INDEX idx_sync_history_completed
    ON sync_history(completed_at DESC);

-- ─── Raw Documents ──────────────────────────────────────────────────

CREATE TABLE raw_documents (
    id BIGSERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    connector_type TEXT NOT NULL,
    connector_name TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    raw_content TEXT NOT NULL,
    raw_size_bytes INT NOT NULL,
    format TEXT,
    source_path TEXT,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (organization_id, connector_type, connector_name, source_id)
);

CREATE INDEX idx_raw_docs_org_connector
    ON raw_documents(organization_id, connector_type, connector_name);
CREATE INDEX idx_raw_docs_source ON raw_documents(source_id);
CREATE INDEX idx_raw_docs_fetched ON raw_documents(fetched_at DESC);

-- ─── Console Users (Cognito SSO) ──────────────────────────────────

CREATE TABLE console_users (
    id TEXT PRIMARY KEY,
    cognito_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_console_users_cognito_sub ON console_users(cognito_sub);
CREATE INDEX idx_console_users_org ON console_users(organization_id);
CREATE INDEX idx_console_users_email ON console_users(email);

-- ─── Kais (Saved Knowledge Views) ────────────────────────────────────

CREATE TABLE kais (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    created_by TEXT REFERENCES console_users(cognito_sub),
    name TEXT NOT NULL,
    description TEXT,
    domains TEXT[] DEFAULT '{}',
    topics TEXT[] DEFAULT '{}',
    knowledge_types TEXT[] DEFAULT '{}',
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kais_org ON kais(organization_id);

-- Default kai for seed org
INSERT INTO kais (id, organization_id, name, description, is_default)
VALUES ('kai_default', 'org_datakai', 'All Knowledge', 'Full knowledge base — no filters', TRUE);

-- ─── Chat Messages (Ask Logging) ─────────────────────────────────────

CREATE TABLE chat_messages (
    id BIGSERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    kai_id TEXT,
    key_id TEXT,
    cognito_sub TEXT,
    query TEXT NOT NULL,
    answer TEXT,
    sources JSONB NOT NULL DEFAULT '[]',
    retrieval_stats JSONB NOT NULL DEFAULT '{}',
    mode TEXT NOT NULL DEFAULT 'standard',
    model TEXT,
    streamed BOOLEAN NOT NULL DEFAULT FALSE,
    source_count INTEGER NOT NULL DEFAULT 0,
    thread_id TEXT,
    rewritten_query TEXT,
    retrieval_ms INTEGER,
    synthesis_ms INTEGER,
    total_latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_org_created ON chat_messages(organization_id, created_at DESC);
CREATE INDEX idx_chat_messages_kai ON chat_messages(kai_id) WHERE kai_id IS NOT NULL;
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, created_at ASC) WHERE thread_id IS NOT NULL;

-- ─── Views ──────────────────────────────────────────────────────────

CREATE VIEW chunk_stats AS
SELECT
    (SELECT COUNT(*) FROM chunks) as total_chunks,
    (SELECT COUNT(DISTINCT zettel_id) FROM chunks) as total_zettels,
    (SELECT COALESCE(array_agg(DISTINCT d), '{}') FROM (SELECT unnest(domains) as d FROM chunks) AS domains_unnest) as all_domains,
    (SELECT COALESCE(array_agg(DISTINCT t), '{}') FROM (SELECT unnest(topics) as t FROM chunks) AS topics_unnest) as all_topics;

-- ─── Permissions ────────────────────────────────────────────────────

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conduit') THEN
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO conduit';
        EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO conduit';
    END IF;
END $$;
