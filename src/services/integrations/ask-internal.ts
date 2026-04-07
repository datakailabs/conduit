/**
 * Internal Ask Service — shared logic for Slack, Teams, and REST ask routes.
 *
 * Calls GraphRAG retrieval + LLM synthesis directly (no HTTP round-trip).
 */

import { graphRAGService } from '../graphrag.js';
import { synthesisService } from '../synthesis.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('ask-internal');

export interface AskInternalResult {
  query: string;
  answer: string;
  mode: string;
  sources: Array<{
    id: string;
    title: string;
    score: number;
    domains: string[];
    sourceUrl?: string;
  }>;
  retrieval: { vectorSeeds: number; graphEdge: number; graphTopic: number };
}

/**
 * Execute an ask query against the knowledge graph.
 * Used by Slack, Teams, and potentially the REST route.
 */
export async function askInternal(
  query: string,
  orgId: string,
  options?: { limit?: number; mode?: 'standard' | 'swarm' }
): Promise<AskInternalResult> {
  const limit = options?.limit ?? 8;
  const mode = options?.mode ?? 'standard';

  const retrieval = await graphRAGService.retrieve(orgId, query, limit);

  const sources = retrieval.results.map((r) => ({
    id: r.zettelId,
    title: r.title,
    score: r.score,
    domains: r.domains,
    sourceUrl: r.sourceUrl,
  }));

  if (retrieval.results.length === 0) {
    return {
      query,
      answer: "I don't have relevant knowledge to answer this question.",
      mode: 'standard',
      sources: [],
      retrieval: retrieval.stats,
    };
  }

  const synthesis = await synthesisService.synthesize(query, retrieval.structuredContext, mode);

  log.info('Internal ask complete', {
    query: query.slice(0, 80),
    orgId,
    resultCount: sources.length,
    mode: synthesis.mode,
  });

  return {
    query,
    answer: synthesis.answer,
    mode: synthesis.mode,
    sources,
    retrieval: retrieval.stats,
  };
}
