import { normalizeProvenance } from '../../types/provenance.js';
import type { ZettelNode } from '../../types/stores.js';

// ArangoDB collection names
export const ZETTELS_COLLECTION = 'zettels';
export const RELATIONSHIPS_COLLECTION = 'relationships';
export const GRAPH_NAME = 'knowledge_graph';

/** Convert ArangoDB document to ZettelNode */
export function docToZettel(doc: any): ZettelNode {
  return {
    id: doc._key || doc.id,
    organizationId: doc.organizationId || 'org_datakai',
    title: doc.title,
    summary: doc.summary,
    content: doc.content,
    created: doc.created,
    updated: doc.updated,
    domains: doc.domains || [],
    topics: doc.topics || [],
    knowledgeType: doc.knowledgeType,
    contextSource: doc.contextSource,
    sourceUrl: doc.sourceUrl,
    provenance: normalizeProvenance(doc.sourceUrl, doc.provenance),
  };
}
