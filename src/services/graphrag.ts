/**
 * GraphRAG Service
 *
 * Unified retrieval pipeline: vector search → dedup → graph expansion → re-ranking → context assembly.
 * Eliminates duplication between ask.ts, context.ts, and resolvers.
 *
 * Pipeline steps (each a private method):
 *   1. vectorSearch()      — embed query, search pgvector, dedup by zettelId
 *   2. expandViaEdges()    — traverse explicit graph edges from seeds
 *   3. expandViaTopics()   — find nodes sharing topics/domains (implicit graph)
 *   4. rankResults()       — merge all sources with graph-aware scoring
 *   5. assembleContext()   — build structured text for LLM consumption
 */

import { postgres } from '../clients/postgres.js';
import { arangoClient } from '../clients/arango/index.js';
import { embeddingsService } from './embeddings/index.js';
import type { VectorStore, GraphTraversal, SearchResult, ZettelNode } from '../types/stores.js';
import type { EmbeddingsProvider } from './embeddings/types.js';
import type { SourceProvenance } from '../types/provenance.js';
import { LRUCache, buildCacheKey } from '../lib/cache.js';

// ─── Configuration ────────────────────────────────────────────────────

export interface GraphRAGConfig {
  minSimilarity: number;
  /** Minimum score for the TOP result to proceed with synthesis. If the best
   *  result is below this, the query is considered off-topic and returns empty. */
  minRelevanceFloor: number;
  graphExpansionDepth: number;
  graphEdgeBoost: number;
  graphTopicBoost: number;
  maxSeedExpansion: number;
  minTopicNeighbors: number;
}

const DEFAULT_CONFIG: GraphRAGConfig = {
  minSimilarity: 0.3,
  minRelevanceFloor: 0.55,
  graphExpansionDepth: 1,
  graphEdgeBoost: 0.08,
  graphTopicBoost: 0.02,
  maxSeedExpansion: 10,
  minTopicNeighbors: 3,
};

// ─── Result Types ─────────────────────────────────────────────────────

export type RetrievalPath = 'vector' | 'graph-edge' | 'graph-topic';

export interface RankedResult {
  zettelId: string;
  title: string;
  content: string;
  score: number;
  graphBoost: number;
  relationships: Array<{ type: string; targetId: string; targetTitle: string }>;
  path: RetrievalPath;
  domains: string[];
  topics: string[];
  knowledgeType: string;
  contextSource: string;
  created: string;
  updated: string;
  sourceUrl?: string;
  provenance?: SourceProvenance;
}

export interface RetrievalStats {
  vectorSeeds: number;
  graphEdge: number;
  graphTopic: number;
}

export interface GraphRAGResult {
  results: RankedResult[];
  stats: RetrievalStats;
  structuredContext: string;
}

// ─── Internal types for pipeline state ────────────────────────────────

interface EdgeExpansionResult {
  seedRelationships: Map<string, RankedResult['relationships']>;
  edgeNeighbors: Map<string, { connectedSeeds: Set<string>; zettel: ZettelNode }>;
}

const EMPTY_RESULT: GraphRAGResult = {
  results: [],
  stats: { vectorSeeds: 0, graphEdge: 0, graphTopic: 0 },
  structuredContext: '',
};

// ─── Service ──────────────────────────────────────────────────────────

export class GraphRAGService {
  private config: GraphRAGConfig;
  private vectorStore: VectorStore;
  private graphStore: GraphTraversal;
  private embeddings: EmbeddingsProvider;
  private cache: LRUCache<GraphRAGResult>;

  constructor(deps?: {
    vectorStore?: VectorStore;
    graphStore?: GraphTraversal;
    embeddings?: EmbeddingsProvider;
    config?: Partial<GraphRAGConfig>;
  }) {
    this.vectorStore = deps?.vectorStore ?? postgres;
    this.graphStore = deps?.graphStore ?? arangoClient;
    this.embeddings = deps?.embeddings ?? embeddingsService;
    this.config = { ...DEFAULT_CONFIG, ...(deps?.config ?? {}) };
    this.cache = new LRUCache<GraphRAGResult>({
      maxSize: 256,
      ttlMs: 5 * 60 * 1000,
      name: 'graphrag',
    });
  }

  /**
   * Full GraphRAG retrieval pipeline.
   */
  async retrieve(
    orgId: string,
    query: string,
    limit: number,
    options?: { fetchNeighborRelationships?: boolean; skipCache?: boolean }
  ): Promise<GraphRAGResult> {
    // Cache check
    const cacheKey = buildCacheKey(orgId, query, limit);
    if (!options?.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    // Step 1: Vector search — seeds
    const vectorSeeds = await this.vectorSearch(orgId, query, limit);
    if (vectorSeeds.length === 0) return EMPTY_RESULT;

    const seedIds = new Set(vectorSeeds.map((r) => r.zettelId));

    // Step 2: Graph expansion — edges + topics (parallel)
    const edgeExpansion = await this.expandViaEdges(orgId, vectorSeeds, seedIds);
    const topicNeighbors = await this.expandViaTopics(orgId, vectorSeeds, seedIds, edgeExpansion.edgeNeighbors, limit);

    // Step 3: Rank and merge all results
    const results = this.rankResults(
      vectorSeeds, seedIds, edgeExpansion, topicNeighbors, orgId, limit, !!options?.fetchNeighborRelationships
    );

    // Relevance floor — if best result is below threshold, query is off-topic
    if (results.length === 0 || results[0].score < this.config.minRelevanceFloor) {
      return EMPTY_RESULT;
    }

    // Step 4: Assemble context + stats
    const structuredContext = this.assembleContext(results);
    const stats: RetrievalStats = {
      vectorSeeds: results.filter((r) => r.path === 'vector').length,
      graphEdge: results.filter((r) => r.path === 'graph-edge').length,
      graphTopic: results.filter((r) => r.path === 'graph-topic').length,
    };

    const result = { results, stats, structuredContext };
    this.cache.set(cacheKey, result);
    return result;
  }

  // ─── Step 1: Vector Search ──────────────────────────────────────────

  private async vectorSearch(orgId: string, query: string, limit: number): Promise<SearchResult[]> {
    const embedding = await this.embeddings.generateEmbedding(query);
    const searchResults = await this.vectorStore.search(orgId, embedding, limit * 3);

    // Deduplicate by zettelId (keep highest score per zettel)
    const deduped = new Map<string, SearchResult>();
    for (const result of searchResults) {
      const existing = deduped.get(result.zettelId);
      if (!existing || result.score > existing.score) {
        deduped.set(result.zettelId, result);
      }
    }

    return Array.from(deduped.values())
      .filter((r) => r.score >= this.config.minSimilarity);
  }

  // ─── Step 2a: Edge Expansion ────────────────────────────────────────

  private async expandViaEdges(
    orgId: string,
    vectorSeeds: SearchResult[],
    seedIds: Set<string>
  ): Promise<EdgeExpansionResult> {
    const { graphExpansionDepth, maxSeedExpansion } = this.config;
    const seedRelationships = new Map<string, RankedResult['relationships']>();
    const edgeNeighbors = new Map<string, { connectedSeeds: Set<string>; zettel: ZettelNode }>();

    await Promise.all(
      vectorSeeds.slice(0, maxSeedExpansion).map(async (seed) => {
        try {
          const [neighbors, graphData] = await Promise.all([
            this.graphStore.traverseGraph(orgId, seed.zettelId, graphExpansionDepth),
            this.graphStore.getZettelWithRelationships(orgId, seed.zettelId, graphExpansionDepth),
          ]);

          if (graphData) {
            seedRelationships.set(
              seed.zettelId,
              graphData.relationships.map((r) => ({
                type: r.type,
                targetId: r.target.id,
                targetTitle: r.target.title,
              }))
            );
          }

          for (const neighbor of neighbors) {
            if (seedIds.has(neighbor.id)) continue;
            const existing = edgeNeighbors.get(neighbor.id);
            if (existing) {
              existing.connectedSeeds.add(seed.zettelId);
            } else {
              edgeNeighbors.set(neighbor.id, {
                connectedSeeds: new Set([seed.zettelId]),
                zettel: neighbor,
              });
            }
          }
        } catch {
          // Graph expansion is best-effort
        }
      })
    );

    return { seedRelationships, edgeNeighbors };
  }

  // ─── Step 2b: Topic Expansion ───────────────────────────────────────

  private async expandViaTopics(
    orgId: string,
    vectorSeeds: SearchResult[],
    seedIds: Set<string>,
    edgeNeighbors: Map<string, unknown>,
    limit: number
  ): Promise<Array<ZettelNode & { sharedCount: number }>> {
    const { minTopicNeighbors } = this.config;
    const allTopics = [...new Set(vectorSeeds.flatMap((s) => s.metadata.topics))];
    const allDomains = [...new Set(vectorSeeds.flatMap((s) => s.metadata.domains))];
    const excludeIds = [...seedIds, ...edgeNeighbors.keys()] as string[];

    try {
      return await this.graphStore.findBySharedTopics(
        orgId,
        allTopics,
        allDomains,
        excludeIds,
        Math.max(minTopicNeighbors, limit - vectorSeeds.length)
      );
    } catch {
      return []; // Topic expansion is best-effort
    }
  }

  // ─── Step 3: Graph-Aware Ranking ────────────────────────────────────

  private rankResults(
    vectorSeeds: SearchResult[],
    seedIds: Set<string>,
    edgeExpansion: EdgeExpansionResult,
    topicNeighbors: Array<ZettelNode & { sharedCount: number }>,
    orgId: string,
    limit: number,
    fetchNeighborRelationships: boolean
  ): RankedResult[] {
    const { minSimilarity, graphEdgeBoost, graphTopicBoost } = this.config;
    const { seedRelationships, edgeNeighbors } = edgeExpansion;
    const resultMap = new Map<string, RankedResult>();

    // Vector seeds with inter-seed edge boost
    for (const seed of vectorSeeds) {
      const rels = seedRelationships.get(seed.zettelId) || [];
      let boost = 0;
      for (const rel of rels) {
        if (seedIds.has(rel.targetId)) boost += graphEdgeBoost;
      }

      resultMap.set(seed.zettelId, this.buildResult(seed.zettelId, {
        title: seed.zettelTitle,
        content: seed.content,
        score: seed.score + boost,
        graphBoost: boost,
        relationships: rels,
        path: 'vector',
        ...seed.metadata,
      }));
    }

    // Edge-discovered neighbors
    for (const [neighborId, info] of edgeNeighbors) {
      const graphScore = minSimilarity + (info.connectedSeeds.size * graphEdgeBoost * 3);

      resultMap.set(neighborId, this.buildResult(neighborId, {
        title: info.zettel.title,
        content: info.zettel.content,
        score: Math.min(graphScore, 0.9),
        graphBoost: graphScore - minSimilarity,
        relationships: [],
        path: 'graph-edge',
        domains: info.zettel.domains,
        topics: info.zettel.topics,
        knowledgeType: info.zettel.knowledgeType,
        contextSource: info.zettel.contextSource,
        created: info.zettel.created,
        updated: info.zettel.updated,
        sourceUrl: info.zettel.sourceUrl,
        provenance: info.zettel.provenance,
      }));
    }

    // Topic-discovered neighbors
    for (const neighbor of topicNeighbors) {
      if (resultMap.has(neighbor.id)) continue;
      const topicScore = minSimilarity + (neighbor.sharedCount * graphTopicBoost);

      resultMap.set(neighbor.id, this.buildResult(neighbor.id, {
        title: neighbor.title,
        content: neighbor.content,
        score: Math.min(topicScore, 0.5),
        graphBoost: topicScore - minSimilarity,
        relationships: [],
        path: 'graph-topic',
        domains: neighbor.domains,
        topics: neighbor.topics,
        knowledgeType: neighbor.knowledgeType,
        contextSource: neighbor.contextSource,
        created: neighbor.created,
        updated: neighbor.updated,
        sourceUrl: neighbor.sourceUrl,
        provenance: neighbor.provenance,
      }));
    }

    return Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Helper to construct a RankedResult without repeating field assignments */
  private buildResult(zettelId: string, fields: Omit<RankedResult, 'zettelId'>): RankedResult {
    return { zettelId, ...fields };
  }

  // ─── Step 4: Context Assembly ───────────────────────────────────────

  private assembleContext(results: RankedResult[]): string {
    if (results.length === 0) return '';

    const parts: string[] = [];

    // Topology section — show how results connect
    const resultIds = new Set(results.map((r) => r.zettelId));
    const topology: string[] = [];
    for (const r of results) {
      for (const rel of r.relationships) {
        if (resultIds.has(rel.targetId)) {
          topology.push(`${r.title} —[${rel.type}]→ ${rel.targetTitle}`);
        }
      }
    }

    if (topology.length > 0) {
      parts.push(`KNOWLEDGE GRAPH TOPOLOGY:\n${topology.join('\n')}`);
    }

    // Knowledge units
    parts.push('KNOWLEDGE UNITS:');
    for (const r of results) {
      let unit = `### ${r.title}\n${r.content}`;
      if (r.relationships.length > 0) {
        unit += `\nConnections: ${r.relationships.map((rel) => `${rel.type} → ${rel.targetTitle}`).join(', ')}`;
      }
      parts.push(unit);
    }

    return parts.join('\n\n');
  }

  // ─── Cache Management ───────────────────────────────────────────────

  /** Invalidate cache for an org (call after ingestion/deletion) */
  invalidateCache(orgId?: string): void {
    if (orgId) {
      this.cache.invalidatePrefix(orgId + ':');
    } else {
      this.cache.clear();
    }
  }

  /** Cache stats for monitoring */
  getCacheStats() {
    return this.cache.getStats();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────

export const graphRAGService = new GraphRAGService();
