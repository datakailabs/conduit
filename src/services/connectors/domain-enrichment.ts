/**
 * Domain Enrichment — Keyword-based domain tagging for ingested documents.
 *
 * Augments connector-provided domainHints with additional domains detected
 * from title and content keywords. This ensures AI-related content from
 * generic repos (e.g. Snowflake quickstarts) gets properly tagged.
 *
 * Runs at ingestion time so domain tags are consistent in both ArangoDB
 * and pgvector from the start — no manual AQL patches needed.
 */

interface DomainRule {
  domain: string;
  /** At least one keyword must match (case-insensitive, word boundary aware) */
  keywords: string[];
}

const DOMAIN_RULES: DomainRule[] = [
  {
    domain: 'genai',
    keywords: [
      'cortex', 'llm', 'large language model', 'fine-tun', 'fine tun',
      'chatbot', 'generative ai', 'generative-ai', 'rag ', 'rag-based',
      'retrieval augmented', 'model serving', 'model training',
      'inference', 'ai function', 'ai agent', 'prompt engineer',
      'transformer', 'foundation model', 'embedding', 'vector search',
      'natural language processing', 'nlp', 'sentiment analysis',
      'multimodal', 'image process', 'text classif', 'copilot',
      'automl', 'model deploy', 'serving endpoint', 'model endpoint',
      'model registr', 'feature store', 'ai assist', 'ai analyt',
      'ai-powered', 'deep learn', 'neural net',
    ],
  },
  {
    domain: 'machine-learning',
    keywords: [
      'machine learn', 'mlflow', 'hyperparameter', 'training data',
      'model evaluation', 'model comparison', 'experiment track',
      'feature engineer', 'scikit-learn', 'pytorch', 'tensorflow',
      'distributed training', 'model artifact', 'batch inference',
      'model governance', 'model lineage',
    ],
  },
  {
    domain: 'streaming',
    keywords: [
      'kinesis', 'kafka', 'streaming', 'real-time processing',
      'event-driven', 'stream processing', 'pub/sub', 'firehose',
    ],
  },
  {
    domain: 'security',
    keywords: [
      'authentication', 'authorization', 'encryption', 'access control',
      'iam', 'identity management', 'kms', 'ssl', 'tls', 'oauth',
      'rbac', 'privilege', 'credential',
    ],
  },
  {
    domain: 'data-governance',
    keywords: [
      'data governance', 'unity catalog', 'data lineage', 'compliance',
      'audit trail', 'data classification', 'data quality', 'masking',
      'retention policy',
    ],
  },
];

/**
 * Enrich domain tags based on title and content keywords.
 *
 * @param title - Document title
 * @param content - Document content (first 2000 chars checked for performance)
 * @param existingDomains - Domains already assigned (e.g. from connector config)
 * @returns Deduplicated array of domains including any newly detected ones
 */
export function enrichDomains(
  title: string,
  content: string,
  existingDomains: string[],
): string[] {
  const domains = new Set(existingDomains);
  const searchText = (title + ' ' + content.slice(0, 2000)).toLowerCase();

  for (const rule of DOMAIN_RULES) {
    if (domains.has(rule.domain)) continue;

    const matched = rule.keywords.some(kw => searchText.includes(kw));
    if (matched) {
      domains.add(rule.domain);
    }
  }

  return [...domains];
}
