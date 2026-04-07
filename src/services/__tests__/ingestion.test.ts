import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IngestionService } from '../ingestion.js';
import type { VectorStore, GraphCRUD, ZettelNode } from '../../types/stores.js';
import type { EmbeddingsProvider } from '../embeddings/types.js';

// ─── Mocks ───────────────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  extractionConfig: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    maxTokens: 4096,
    dedupThreshold: 0.85,
    get clientConfig() {
      return { apiKey: 'test-key' };
    },
  },
  embeddingsConfig: {
    provider: 'openai',
    dimensions: 1536,
    openai: { apiKey: 'test', model: 'text-embedding-3-small', dimensions: 1536 },
  },
  postgresConfig: {},
}));

vi.mock('../../clients/arango/index.js', () => ({
  arangoClient: {},
}));

vi.mock('../../clients/postgres.js', () => ({
  postgres: {},
}));

vi.mock('../embeddings/index.js', () => ({
  embeddingsService: {},
}));

function createMockVectorStore(): VectorStore {
  return {
    initialize: vi.fn(),
    upsertChunks: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    deleteZettelChunks: vi.fn().mockResolvedValue(undefined),
    updateChunkMetadata: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn(),
    close: vi.fn(),
  };
}

function createMockGraphCRUD(): GraphCRUD {
  return {
    upsertZettel: vi.fn().mockResolvedValue(undefined),
    createRelationships: vi.fn().mockResolvedValue(undefined),
    getZettel: vi.fn().mockResolvedValue(null),
    deleteZettel: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({ totalZettels: 0, totalRelationships: 0 }),
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

// ─── Tests ───────────────────────────────────────────────────────────────

describe('IngestionService', () => {
  let vectorStore: VectorStore;
  let graphStore: GraphCRUD;
  let embeddings: EmbeddingsProvider;
  let service: IngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    vectorStore = createMockVectorStore();
    graphStore = createMockGraphCRUD();
    embeddings = createMockEmbeddings();
    service = new IngestionService({ vectorStore, graphStore, embeddings });
  });

  describe('ingestKnowledgeUnit', () => {
    it('ingests a knowledge unit to both stores', async () => {
      const result = await service.ingestKnowledgeUnit('org_test', {
        id: 'zettel-test-001',
        title: 'Test Knowledge',
        content: 'This is test knowledge content that should be indexed.',
        domains: ['testing'],
        topics: ['vitest', 'unit-testing', 'mocking'],
        knowledgeType: 'concept',
        contextSource: 'experience',
      });

      expect(result.success).toBe(true);
      expect(result.zettelId).toBe('zettel-test-001');
      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(graphStore.upsertZettel).toHaveBeenCalledTimes(1);
      expect(vectorStore.upsertChunks).toHaveBeenCalledTimes(1);
      expect(embeddings.generateEmbeddings).toHaveBeenCalledTimes(1);
    });

    it('creates relationships when provided', async () => {
      const result = await service.ingestKnowledgeUnit('org_test', {
        id: 'zettel-test-002',
        title: 'Related Knowledge',
        content: 'Content with relationships.',
        domains: ['testing'],
        topics: ['relations', 'graph', 'edges'],
        knowledgeType: 'pattern',
        contextSource: 'experience',
        relationships: [
          { type: 'EXTENDS', target: 'zettel-test-001', properties: { how: 'by adding tests' } },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.relationshipsCreated).toBe(1);
      expect(graphStore.createRelationships).toHaveBeenCalledTimes(1);
    });

    it('handles errors gracefully', async () => {
      (graphStore.upsertZettel as any).mockRejectedValue(new Error('DB error'));

      const result = await service.ingestKnowledgeUnit('org_test', {
        id: 'zettel-fail',
        title: 'Will Fail',
        content: 'This should fail gracefully.',
        domains: ['testing'],
        topics: ['error', 'handling', 'resilience'],
        knowledgeType: 'concept',
        contextSource: 'experience',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  describe('deleteZettel', () => {
    it('deletes from both stores', async () => {
      const result = await service.deleteZettel('org_test', 'zettel-delete-me');

      expect(result).toBe(true);
      expect(graphStore.deleteZettel).toHaveBeenCalledWith('org_test', 'zettel-delete-me');
      expect(vectorStore.deleteZettelChunks).toHaveBeenCalledWith('org_test', 'zettel-delete-me');
    });

    it('returns false on error', async () => {
      (graphStore.deleteZettel as any).mockRejectedValue(new Error('fail'));

      const result = await service.deleteZettel('org_test', 'zettel-bad');

      expect(result).toBe(false);
    });
  });
});
