-- Chat message logging for Ask endpoint
-- Persists every Q&A with sources, timing, and user context

CREATE TABLE IF NOT EXISTS chat_messages (
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
    retrieval_ms INTEGER,
    synthesis_ms INTEGER,
    total_latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_org_created ON chat_messages(organization_id, created_at DESC);
CREATE INDEX idx_chat_messages_kai ON chat_messages(kai_id) WHERE kai_id IS NOT NULL;
