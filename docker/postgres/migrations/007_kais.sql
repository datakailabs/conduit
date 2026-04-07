-- Kais: Named knowledge views (saved filters)
-- A Kai with empty filter arrays = "all knowledge" (no filtering)

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

-- Add scope + kai scoping to api_keys
ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE api_keys ADD COLUMN kai_ids TEXT[] DEFAULT '{}';

-- Create default kai for existing org
INSERT INTO kais (id, organization_id, name, description, is_default)
VALUES ('kai_default', 'org_datakai', 'All Knowledge', 'Full knowledge base — no filters', TRUE);
