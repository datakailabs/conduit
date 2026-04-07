-- Domain Taxonomy Cleanup Migration
-- Enforces domain contract: ^[a-z][a-z0-9-]{1,30}$
-- Three steps: fix invalid format, reclassify overly-specific to topics, merge near-duplicates
-- Idempotent: safe to run multiple times
-- Reference: zettel-20260318205332-domain-taxonomy-contract-open-format-validated

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- STEP 1: Fix invalid format domains (33 domains, ~47 chunks)
-- ═══════════════════════════════════════════════════════════════════════

-- Uppercase-only fixes
UPDATE chunks SET domains = array_replace(domains, 'AWS', 'aws') WHERE 'AWS' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'ETL', 'etl') WHERE 'ETL' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'MLOps', 'machine-learning') WHERE 'MLOps' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'Data Engineering', 'data-engineering') WHERE 'Data Engineering' = ANY(domains);

-- AI-related → genai
UPDATE chunks SET domains = array_replace(domains, 'AI development', 'genai') WHERE 'AI development' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'AI integration', 'genai') WHERE 'AI integration' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'AI management', 'genai') WHERE 'AI management' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'AI prediction', 'genai') WHERE 'AI prediction' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'AI tools', 'genai') WHERE 'AI tools' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'language models', 'genai') WHERE 'language models' = ANY(domains);

-- Cloud/infra related → cloud
UPDATE chunks SET domains = array_replace(domains, 'Cloud Security', 'security') WHERE 'Cloud Security' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'Cloud Storage', 'cloud') WHERE 'Cloud Storage' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'resource management', 'cloud') WHERE 'resource management' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'runtime management', 'cloud') WHERE 'runtime management' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'instance management', 'cloud') WHERE 'instance management' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'account management', 'cloud') WHERE 'account management' = ANY(domains);

-- Data related → data-engineering
UPDATE chunks SET domains = array_replace(domains, 'data integration', 'data-engineering') WHERE 'data integration' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'data management', 'data-engineering') WHERE 'data management' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'data organization', 'data-engineering') WHERE 'data organization' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'data sharing', 'data-engineering') WHERE 'data sharing' = ANY(domains);

-- Governance → data-governance
UPDATE chunks SET domains = array_replace(domains, 'data governance', 'data-governance') WHERE 'data governance' = ANY(domains);

-- Security related → security
UPDATE chunks SET domains = array_replace(domains, 'identity management', 'security') WHERE 'identity management' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'security testing', 'security') WHERE 'security testing' = ANY(domains);

-- ML related → machine-learning
UPDATE chunks SET domains = array_replace(domains, 'model management', 'machine-learning') WHERE 'model management' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'model serving', 'machine-learning') WHERE 'model serving' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'model training', 'machine-learning') WHERE 'model training' = ANY(domains);

-- Remove nonsense domains (just remove, don't remap)
UPDATE chunks SET domains = array_remove(domains, 'meeting technology') WHERE 'meeting technology' = ANY(domains);
UPDATE chunks SET domains = array_remove(domains, 'market analysis') WHERE 'market analysis' = ANY(domains);
UPDATE chunks SET domains = array_remove(domains, 'UI/UX design') WHERE 'UI/UX design' = ANY(domains);
UPDATE chunks SET domains = array_remove(domains, 'front-end development') WHERE 'front-end development' = ANY(domains);
UPDATE chunks SET domains = array_remove(domains, 'startup development') WHERE 'startup development' = ANY(domains);
UPDATE chunks SET domains = array_remove(domains, 'software development') WHERE 'software development' = ANY(domains);
UPDATE chunks SET domains = array_remove(domains, 'best practices') WHERE 'best practices' = ANY(domains);

-- ═══════════════════════════════════════════════════════════════════════
-- STEP 2: Reclassify overly-specific domains → topics
-- Pattern: remove from domains, add to topics if not already there
-- ═══════════════════════════════════════════════════════════════════════

-- AWS services → topics (keep 'aws' domain)
UPDATE chunks SET domains = array_remove(domains, 'redshift'),
  topics = CASE WHEN NOT ('redshift' = ANY(topics)) THEN array_append(topics, 'redshift') ELSE topics END
WHERE 'redshift' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 's3'),
  topics = CASE WHEN NOT ('s3' = ANY(topics)) THEN array_append(topics, 's3') ELSE topics END
WHERE 's3' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'storage'),
  topics = CASE WHEN NOT ('storage' = ANY(topics)) THEN array_append(topics, 'storage') ELSE topics END
WHERE 'storage' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'iam'),
  topics = CASE WHEN NOT ('iam' = ANY(topics)) THEN array_append(topics, 'iam') ELSE topics END
WHERE 'iam' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'glue'),
  topics = CASE WHEN NOT ('glue' = ANY(topics)) THEN array_append(topics, 'glue') ELSE topics END
WHERE 'glue' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'athena'),
  topics = CASE WHEN NOT ('athena' = ANY(topics)) THEN array_append(topics, 'athena') ELSE topics END
WHERE 'athena' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'emr'),
  topics = CASE WHEN NOT ('emr' = ANY(topics)) THEN array_append(topics, 'emr') ELSE topics END
WHERE 'emr' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'kinesis'),
  topics = CASE WHEN NOT ('kinesis' = ANY(topics)) THEN array_append(topics, 'kinesis') ELSE topics END
WHERE 'kinesis' = ANY(domains);

-- Tools → topics
UPDATE chunks SET domains = array_remove(domains, 'spark'),
  topics = CASE WHEN NOT ('spark' = ANY(topics)) THEN array_append(topics, 'spark') ELSE topics END
WHERE 'spark' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'delta-lake'),
  topics = CASE WHEN NOT ('delta-lake' = ANY(topics)) THEN array_append(topics, 'delta-lake') ELSE topics END
WHERE 'delta-lake' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'dbt'),
  topics = CASE WHEN NOT ('dbt' = ANY(topics)) THEN array_append(topics, 'dbt') ELSE topics END
WHERE 'dbt' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'mlflow'),
  topics = CASE WHEN NOT ('mlflow' = ANY(topics)) THEN array_append(topics, 'mlflow') ELSE topics END
WHERE 'mlflow' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'terraform'),
  topics = CASE WHEN NOT ('terraform' = ANY(topics)) THEN array_append(topics, 'terraform') ELSE topics END
WHERE 'terraform' = ANY(domains);

-- Generic → topics
UPDATE chunks SET domains = array_remove(domains, 'cli'),
  topics = CASE WHEN NOT ('cli' = ANY(topics)) THEN array_append(topics, 'cli') ELSE topics END
WHERE 'cli' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'sdk'),
  topics = CASE WHEN NOT ('sdk' = ANY(topics)) THEN array_append(topics, 'sdk') ELSE topics END
WHERE 'sdk' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'python'),
  topics = CASE WHEN NOT ('python' = ANY(topics)) THEN array_append(topics, 'python') ELSE topics END
WHERE 'python' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'sql'),
  topics = CASE WHEN NOT ('sql' = ANY(topics)) THEN array_append(topics, 'sql') ELSE topics END
WHERE 'sql' = ANY(domains);

-- Overlaps → merge into parent domain, move old name to topic
UPDATE chunks SET
  domains = CASE
    WHEN 'data-engineering' = ANY(array_remove(domains, 'data-warehouse'))
    THEN array_remove(domains, 'data-warehouse')
    ELSE array_append(array_remove(domains, 'data-warehouse'), 'data-engineering')
  END,
  topics = CASE WHEN NOT ('data-warehouse' = ANY(topics)) THEN array_append(topics, 'data-warehouse') ELSE topics END
WHERE 'data-warehouse' = ANY(domains);

UPDATE chunks SET
  domains = CASE
    WHEN 'data-engineering' = ANY(array_remove(domains, 'etl'))
    THEN array_remove(domains, 'etl')
    ELSE array_append(array_remove(domains, 'etl'), 'data-engineering')
  END,
  topics = CASE WHEN NOT ('etl' = ANY(topics)) THEN array_append(topics, 'etl') ELSE topics END
WHERE 'etl' = ANY(domains);

-- ═══════════════════════════════════════════════════════════════════════
-- STEP 3: Merge near-duplicates
-- ═══════════════════════════════════════════════════════════════════════

UPDATE chunks SET domains = array_replace(domains, 'cloud-computing', 'cloud') WHERE 'cloud-computing' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'cloud-services', 'cloud') WHERE 'cloud-services' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'cloud-storage', 'cloud') WHERE 'cloud-storage' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'cloud-security', 'security') WHERE 'cloud-security' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'cloud-data-platform', 'cloud') WHERE 'cloud-data-platform' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'data-warehousing', 'data-engineering') WHERE 'data-warehousing' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'data-security', 'security') WHERE 'data-security' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'generative-ai', 'genai') WHERE 'generative-ai' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'ml', 'machine-learning') WHERE 'ml' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'mlops', 'machine-learning') WHERE 'mlops' = ANY(domains);
UPDATE chunks SET domains = array_replace(domains, 'ml-ops', 'machine-learning') WHERE 'ml-ops' = ANY(domains);

-- Remaining tiny domains (<10 chunks) → move to topics
UPDATE chunks SET domains = array_remove(domains, 'async-programming'),
  topics = CASE WHEN NOT ('async-programming' = ANY(topics)) THEN array_append(topics, 'async-programming') ELSE topics END
WHERE 'async-programming' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'graph-analysis'),
  topics = CASE WHEN NOT ('graph-analysis' = ANY(topics)) THEN array_append(topics, 'graph-analysis') ELSE topics END
WHERE 'graph-analysis' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'docker'),
  topics = CASE WHEN NOT ('docker' = ANY(topics)) THEN array_append(topics, 'docker') ELSE topics END
WHERE 'docker' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'kafka'),
  topics = CASE WHEN NOT ('kafka' = ANY(topics)) THEN array_append(topics, 'kafka') ELSE topics END
WHERE 'kafka' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'ray'),
  topics = CASE WHEN NOT ('ray' = ANY(topics)) THEN array_append(topics, 'ray') ELSE topics END
WHERE 'ray' = ANY(domains);

UPDATE chunks SET domains = array_remove(domains, 'mcp'),
  topics = CASE WHEN NOT ('mcp' = ANY(topics)) THEN array_append(topics, 'mcp') ELSE topics END
WHERE 'mcp' = ANY(domains);

-- Catch-all: move remaining tiny/junk domains to topics
-- These are all the single-digit count domains with valid format but too specific
DO $$
DECLARE
  d TEXT;
  tiny_domains TEXT[] := ARRAY[
    'api', 'ai', 'audit', 'analytics', 'batch-inference', 'billing', 'business',
    'business-intelligence', 'client-configuration', 'compliance', 'data-architecture',
    'data-management', 'data-preparation', 'data-types', 'dataops', 'deep-learning',
    'dependencies', 'deployment', 'distributed-systems', 'encryption', 'energy',
    'experiment-tracking', 'feature-discovery', 'feature-engineering', 'feature-governance',
    'feature-joins', 'feature-lineage', 'feature-serving', 'feature-store', 'governance',
    'gpu-compute', 'gpu-computing', 'hive', 'infrastructure-as-code', 'lakehouse',
    'limitations', 'model-customization', 'model-deployment', 'model-evaluation',
    'model-governance', 'model-management', 'model-registry', 'model-serving',
    'modelops', 'monitoring', 'network-security', 'networking', 'performance',
    'performance-optimization', 'pricing', 'products', 'real-time-ml',
    'real-time-processing', 'recommendation-systems', 'resource-management',
    'scalability', 'scikit-learn', 'sdk-usage', 'system-administration',
    'tableau', 'tensorflow', 'troubleshooting', 'tutorials',
    'workflow', 'workflow-management', 'ai-tooling', 'delta-live-tables'
  ];
BEGIN
  FOREACH d IN ARRAY tiny_domains LOOP
    UPDATE chunks SET
      domains = array_remove(domains, d),
      topics = CASE WHEN NOT (d = ANY(topics)) THEN array_append(topics, d) ELSE topics END
    WHERE d = ANY(domains);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- STEP 4: Deduplicate domain arrays (array_replace can leave dupes)
-- ═══════════════════════════════════════════════════════════════════════

UPDATE chunks SET domains = (
  SELECT ARRAY(SELECT DISTINCT unnest(domains) ORDER BY 1)
)
WHERE array_length(domains, 1) > 1;

-- ═══════════════════════════════════════════════════════════════════════
-- STEP 5: Fallback — no chunk should have empty domains
-- ═══════════════════════════════════════════════════════════════════════

UPDATE chunks SET domains = ARRAY['general']
WHERE domains = '{}' OR domains IS NULL OR array_length(domains, 1) IS NULL;

COMMIT;
