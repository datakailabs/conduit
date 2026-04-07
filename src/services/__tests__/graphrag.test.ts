import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VectorStore, GraphTraversal, SearchResult, ZettelNode, ZettelWithRelationships } from '../../types/stores.js';
import type { EmbeddingsProvider } from '../embeddings/types.js';

// ─── Module Mocks (must be before GraphRAGService import resolves) ───────

vi.mock('../../config.js', () => ({
  postgresConfig: {},
  arangoConfig: { url: 'http://localhost:8529', database: 'test', username: 'root', password: '' },
  embeddingsConfig: {
    provider: 'openai',
    dimensions: 1536,
    openai: { apiKey: 'test', model: 'text-embedding-3-small', dimensions: 1536 },
  },
}));

vi.mock('../../clients/postgres.js', () => ({
  postgres: { search: vi.fn(), initialize: vi.fn() },
}));

vi.mock('../../clients/arango/index.js', () => ({
  arangoClient: { traverseGraph: vi.fn(), getZettelWithRelationships: vi.fn(), findBySharedTopics: vi.fn(), initialize: vi.fn() },
}));

vi.mock('../embeddings/index.js', () => ({
  embeddingsService: { generateEmbedding: vi.fn(), generateEmbeddings: vi.fn(), dimensions: 1536, name: 'mock' },
}));

import { GraphRAGService } from '../graphrag.js';

// ─── Mock Factories ──────────────────────────────────────────────────────

function createMockVectorStore(): VectorStore {
  return {
    initialize: vi.fn(),
    upsertChunks: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    deleteZettelChunks: vi.fn(),
    updateChunkMetadata: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({ totalChunks: 0, totalZettels: 0, dimensions: 1536 }),
    close: vi.fn(),
  };
}

function createMockGraphTraversal(): GraphTraversal {
  return {
    getZettelWithRelationships: vi.fn().mockResolvedValue(null),
    traverseGraph: vi.fn().mockResolvedValue([]),
    findBySharedTopics: vi.fn().mockResolvedValue([]),
    findPrerequisitePath: vi.fn().mockResolvedValue(null),
  };
}

function createMockEmbeddings(): EmbeddingsProvider {
  return {
    name: 'mock',
    dimensions: 1536,
    generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
    generateEmbeddings: vi.fn().mockResolvedValue([new Array(1536).fill(0.1)]),
  };
}

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    score: 0.85,
    zettelId: 'zettel-001',
    zettelTitle: 'Test Zettel',
    section: 'main',
    content: 'Test content for knowledge unit.',
    chunkIndex: 0,
    metadata: {
      domains: ['testing'],
      topics: ['vitest', 'unit-testing', 'mocking'],
      knowledgeType: 'concept',
      contextSource: 'experience',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('GraphRAGService', () => {
  let vectorStore: VectorStore;
  let graphStore: GraphTraversal;
  let embeddings: EmbeddingsProvider;
  let service: GraphRAGService;

  beforeEach(() => {
    vectorStore = createMockVectorStore();
    graphStore = createMockGraphTraversal();
    embeddings = createMockEmbeddings();
    service = new GraphRAGService({ vectorStore, graphStore, embeddings });
  });

  describe('retrieve', () => {
    it('returns empty results when no vector seeds match', async () => {
      const result = await service.retrieve('org_test', 'test query', 10);

      expect(result.results).toHaveLength(0);
      expect(result.stats).toEqual({ vectorSeeds: 0, graphEdge: 0, graphTopic: 0 });
      expect(result.structuredContext).toBe('');
      expect(embeddings.generateEmbedding).toHaveBeenCalledWith('test query');
    });

    it('returns vector seeds above minimum similarity', async () => {
      (vectorStore.search as any).mockResolvedValue([
        makeSearchResult({ score: 0.85, zettelId: 'z1' }),
        makeSearchResult({ score: 0.15, zettelId: 'z2' }), // below 0.3 threshold
      ]);

      const result = await service.retrieve('org_test', 'test query', 10);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].zettelId).toBe('z1');
      expect(result.results[0].path).toBe('vector');
      expect(result.stats.vectorSeeds).toBe(1);
    });

    it('deduplicates by zettelId keeping highest score', async () => {
      (vectorStore.search as any).mockResolvedValue([
        makeSearchResult({ score: 0.85, zettelId: 'z1', section: 'chunk-1' }),
        makeSearchResult({ score: 0.92, zettelId: 'z1', section: 'chunk-2' }),
        makeSearchResult({ score: 0.70, zettelId: 'z1', section: 'chunk-3' }),
      ]);

      const result = await service.retrieve('org_test', 'test query', 10);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].score).toBeGreaterThanOrEqual(0.92);
    });

    it('adds graph edge neighbors from traversal', async () => {
      (vectorStore.search as any).mockResolvedValue([
        makeSearchResult({ score: 0.85, zettelId: 'z1' }),
      ]);

      const neighbor: ZettelNode = {
        id: 'z-neighbor',
        organizationId: 'org_test',
        title: 'Neighbor Zettel',
        content: 'Related content.',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
        domains: ['testing'],
        topics: ['related', 'neighbor', 'graph'],
        knowledgeType: 'concept',
        contextSource: 'experience',
      };
      (graphStore.traverseGraph as any).mockResolvedValue([neighbor]);
      (graphStore.getZettelWithRelationships as any).mockResolvedValue({
        zettel: neighbor,
        relationships: [],
      });

      const result = await service.retrieve('org_test', 'test query', 10);

      expect(result.results).toHaveLength(2);
      const edgeResult = result.results.find(r => r.path === 'graph-edge');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.zettelId).toBe('z-neighbor');
      expect(result.stats.graphEdge).toBe(1);
    });

    it('adds topic neighbors when explicit edges are sparse', async () => {
      (vectorStore.search as any).mockResolvedValue([
        makeSearchResult({ score: 0.85, zettelId: 'z1' }),
      ]);

      (graphStore.findBySharedTopics as any).mockResolvedValue([{
        id: 'z-topic',
        organizationId: 'org_test',
        title: 'Topic Neighbor',
        content: 'Shared topic content.',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
        domains: ['testing'],
        topics: ['vitest', 'unit-testing', 'shared'],
        knowledgeType: 'concept',
        contextSource: 'experience',
        sharedCount: 4,
      }]);

      const result = await service.retrieve('org_test', 'test query', 10);

      const topicResult = result.results.find(r => r.path === 'graph-topic');
      expect(topicResult).toBeDefined();
      expect(topicResult!.zettelId).toBe('z-topic');
      expect(result.stats.graphTopic).toBe(1);
    });

    it('boosts vector seeds connected by graph edges', async () => {
      (vectorStore.search as any).mockResolvedValue([
        makeSearchResult({ score: 0.80, zettelId: 'z1' }),
        makeSearchResult({ score: 0.81, zettelId: 'z2' }),
      ]);

      // z1 has a relationship to z2 (both seeds → boost)
      (graphStore.getZettelWithRelationships as any).mockImplementation(
        (_org: string, id: string) => {
          if (id === 'z1') {
            return {
              zettel: { id: 'z1' },
              relationships: [{ type: 'EXTENDS', target: { id: 'z2', title: 'Z2' } }],
            };
          }
          return { zettel: { id }, relationships: [] };
        }
      );

      const result = await service.retrieve('org_test', 'test query', 10);

      const z1 = result.results.find(r => r.zettelId === 'z1');
      expect(z1!.graphBoost).toBeGreaterThan(0);
      expect(z1!.score).toBeGreaterThan(0.80);
    });

    it('respects limit parameter', async () => {
      const seeds = Array.from({ length: 20 }, (_, i) =>
        makeSearchResult({ score: 0.9 - i * 0.02, zettelId: `z-${i}` })
      );
      (vectorStore.search as any).mockResolvedValue(seeds);

      const result = await service.retrieve('org_test', 'test query', 5);

      expect(result.results).toHaveLength(5);
    });

    it('assembles structured context with topology', async () => {
      (vectorStore.search as any).mockResolvedValue([
        makeSearchResult({ score: 0.85, zettelId: 'z1' }),
        makeSearchResult({ score: 0.80, zettelId: 'z2' }),
      ]);

      (graphStore.getZettelWithRelationships as any).mockImplementation(
        (_org: string, id: string) => {
          if (id === 'z1') {
            return {
              zettel: { id: 'z1' },
              relationships: [{ type: 'REQUIRES', target: { id: 'z2', title: 'Test Zettel' } }],
            };
          }
          return { zettel: { id }, relationships: [] };
        }
      );

      const result = await service.retrieve('org_test', 'test query', 10);

      expect(result.structuredContext).toContain('KNOWLEDGE GRAPH TOPOLOGY');
      expect(result.structuredContext).toContain('KNOWLEDGE UNITS');
      expect(result.structuredContext).toContain('REQUIRES');
    });

    it('handles graph expansion errors gracefully', async () => {
      (vectorStore.search as any).mockResolvedValue([
        makeSearchResult({ score: 0.85, zettelId: 'z1' }),
      ]);
      (graphStore.traverseGraph as any).mockRejectedValue(new Error('DB down'));
      (graphStore.getZettelWithRelationships as any).mockRejectedValue(new Error('DB down'));
      (graphStore.findBySharedTopics as any).mockRejectedValue(new Error('DB down'));

      const result = await service.retrieve('org_test', 'test query', 10);

      // Should still return vector seeds despite graph failures
      expect(result.results).toHaveLength(1);
      expect(result.results[0].zettelId).toBe('z1');
    });
  });

  describe('config', () => {
    it('accepts custom config overrides', async () => {
      const custom = new GraphRAGService({
        vectorStore,
        graphStore,
        embeddings,
        config: { minSimilarity: 0.5 },
      });

      (vectorStore.search as any).mockResolvedValue([
        makeSearchResult({ score: 0.45, zettelId: 'z1' }), // below 0.5
        makeSearchResult({ score: 0.60, zettelId: 'z2' }), // above 0.5
      ]);

      const result = await custom.retrieve('org_test', 'test query', 10);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].zettelId).toBe('z2');
    });
  });
});
