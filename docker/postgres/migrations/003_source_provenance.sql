-- Migration 003: Source Provenance
-- Replace flat source_url with structured provenance JSONB

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS provenance JSONB;

-- Migrate existing source_url data into provenance
UPDATE chunks
SET provenance = jsonb_build_object('type', 'url', 'url', source_url)
WHERE source_url IS NOT NULL AND provenance IS NULL;

-- GIN index for JSONB queries
CREATE INDEX IF NOT EXISTS idx_chunks_provenance ON chunks USING GIN(provenance);
