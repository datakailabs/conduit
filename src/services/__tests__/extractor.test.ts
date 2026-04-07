import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { ExtractorService } from '../extractor.js';
import type { ExtractionResult } from '../extractor.js';

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock config (must be before service import resolves)
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
    ollama: { url: 'http://localhost:11434', model: 'nomic-embed-text', dimensions: 768 },
  },
  postgresConfig: {},
  serverConfig: { port: 4000, nodeEnv: 'test' },
}));

const mockSearch = vi.fn();
vi.mock('../../clients/postgres.js', () => ({
  postgres: {
    search: (...args: unknown[]) => mockSearch(...args),
    upsertChunks: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn(),
  },
}));

const mockGenerateEmbedding = vi.fn().mockResolvedValue(new Array(1536).fill(0.1));
const mockGenerateEmbeddings = vi.fn().mockResolvedValue([new Array(1536).fill(0.1)]);
vi.mock('../embeddings/index.js', () => ({
  embeddingsService: {
    generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
    generateEmbeddings: (...args: unknown[]) => mockGenerateEmbeddings(...args),
    dimensions: 1536,
  },
}));

vi.mock('../ingestion.js', () => ({
  IngestionService: vi.fn().mockImplementation(() => ({
    ingestKnowledgeUnit: vi.fn().mockResolvedValue({
      success: true,
      zettelId: 'test-id',
      chunksCreated: 1,
      relationshipsCreated: 0,
    }),
  })),
  ingestionService: {
    ingestKnowledgeUnit: vi.fn().mockResolvedValue({
      success: true,
      zettelId: 'test-id',
      chunksCreated: 1,
      relationshipsCreated: 0,
    }),
  },
}));

vi.mock('../../clients/arango/index.js', () => ({
  arangoClient: {
    createRelationships: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn(),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeLLMResponse(units: Array<Record<string, unknown>>, discardedCount = 0, summary = 'Test extraction') {
  return JSON.stringify({ units, discardedCount, summary });
}

function makeUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: 'Test Knowledge Unit',
    content: 'This is a test knowledge unit with enough content to be meaningful and self-contained.',
    domains: ['testing'],
    topics: ['vitest', 'unit-testing', 'mocking'],
    knowledgeType: 'concept',
    contextSource: 'experience',
    confidence: 0.9,
    relationships: [],
    ...overrides,
  };
}

function createMockClient(responseContent: string) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: responseContent } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('ExtractorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no existing duplicates
    mockSearch.mockResolvedValue([]);
  });

  describe('extract', () => {
    it('extracts units from text via LLM', async () => {
      const response = makeLLMResponse([makeUnit()]);
      const client = createMockClient(response);
      const service = new ExtractorService({ client });

      const result = await service.extract('org_test', 'Some long text about knowledge extraction...');

      expect(result.extracted).toBe(1);
      expect(result.novel).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(result.units).toHaveLength(1);
      expect(result.units[0].title).toBe('Test Knowledge Unit');
      expect(result.units[0].isDuplicate).toBe(false);
    });

    it('filters units with confidence below 0.5', async () => {
      const response = makeLLMResponse([
        makeUnit({ title: 'High Confidence', confidence: 0.8 }),
        makeUnit({ title: 'Low Confidence', confidence: 0.3 }),
        makeUnit({ title: 'Borderline', confidence: 0.5 }),
      ]);
      const client = createMockClient(response);
      const service = new ExtractorService({ client });

      const result = await service.extract('org_test', 'Text content here...');

      expect(result.extracted).toBe(2); // Only 0.8 and 0.5
      expect(result.discarded).toBe(1); // The 0.3 one
      expect(result.units.map(u => u.title)).toEqual(['High Confidence', 'Borderline']);
    });

    it('pads topics when fewer than 3', async () => {
      const response = makeLLMResponse([
        makeUnit({ topics: ['single-topic'], domains: ['test-domain'] }),
      ]);
      const client = createMockClient(response);
      const service = new ExtractorService({ client });

      const result = await service.extract('org_test', 'Text content...');

      expect(result.units[0].topics).toHaveLength(3);
      expect(result.units[0].topics[0]).toBe('single-topic');
      expect(result.units[0].topics[1]).toBe('test-domain');
      expect(result.units[0].topics[2]).toBe('test-domain');
    });
  });

  describe('deduplication', () => {
    it('marks units as duplicates when similarity exceeds threshold', async () => {
      const response = makeLLMResponse([makeUnit()]);
      const client = createMockClient(response);
      const service = new ExtractorService({ client, dedupThreshold: 0.85 });

      // Simulate high similarity match
      mockSearch.mockResolvedValue([{
        score: 0.92,
        zettelId: 'existing-zettel-123',
        zettelTitle: 'Existing Knowledge',
        section: 'main',
        content: 'Similar content',
        chunkIndex: 0,
        metadata: { domains: [], topics: [], knowledgeType: 'concept', contextSource: 'experience', created: '', updated: '' },
      }]);

      const result = await service.extract('org_test', 'Text content...');

      expect(result.duplicates).toBe(1);
      expect(result.novel).toBe(0);
      expect(result.units[0].isDuplicate).toBe(true);
      expect(result.units[0].duplicateOf).toBe('existing-zettel-123');
      expect(result.units[0].similarityScore).toBe(0.92);
    });

    it('treats units as novel when similarity is below threshold', async () => {
      const response = makeLLMResponse([makeUnit()]);
      const client = createMockClient(response);
      const service = new ExtractorService({ client, dedupThreshold: 0.85 });

      // Simulate low similarity match
      mockSearch.mockResolvedValue([{
        score: 0.4,
        zettelId: 'distant-zettel',
        zettelTitle: 'Different Knowledge',
        section: 'main',
        content: 'Unrelated content',
        chunkIndex: 0,
        metadata: { domains: [], topics: [], knowledgeType: 'concept', contextSource: 'experience', created: '', updated: '' },
      }]);

      const result = await service.extract('org_test', 'Text content...');

      expect(result.novel).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(result.units[0].isDuplicate).toBe(false);
      expect(result.units[0].similarityScore).toBe(0.4);
    });

    it('treats as novel when no existing chunks exist', async () => {
      const response = makeLLMResponse([makeUnit()]);
      const client = createMockClient(response);
      const service = new ExtractorService({ client });

      mockSearch.mockResolvedValue([]);

      const result = await service.extract('org_test', 'Text content...');

      expect(result.novel).toBe(1);
      expect(result.units[0].isDuplicate).toBe(false);
      expect(result.units[0].similarityScore).toBe(0);
    });
  });

  describe('error handling', () => {
    it('handles invalid JSON from LLM gracefully', async () => {
      const client = createMockClient('this is not json at all');
      const service = new ExtractorService({ client });

      const result = await service.extract('org_test', 'Text content...');

      expect(result.extracted).toBe(0);
      expect(result.units).toHaveLength(0);
      expect(result.summary).toBe('Failed to parse LLM response');
    });

    it('handles empty LLM response', async () => {
      const client = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: null } }],
            }),
          },
        },
      } as unknown as OpenAI;
      const service = new ExtractorService({ client });

      const result = await service.extract('org_test', 'Text content...');

      expect(result.extracted).toBe(0);
      expect(result.summary).toBe('No response from LLM');
    });

    it('handles malformed units in response', async () => {
      const response = makeLLMResponse([
        makeUnit(), // valid
        { title: 'Missing fields' } as Record<string, unknown>, // invalid — no content, domains, etc.
      ]);
      const client = createMockClient(response);
      const service = new ExtractorService({ client });

      const result = await service.extract('org_test', 'Text content...');

      // Only the valid unit should be extracted
      expect(result.extracted).toBe(1);
      expect(result.units).toHaveLength(1);
    });
  });

  describe('dry run', () => {
    it('does not ingest when ingest=false', async () => {
      const response = makeLLMResponse([makeUnit()]);
      const client = createMockClient(response);
      const service = new ExtractorService({ client });

      const result = await service.extract('org_test', 'Text content...', { ingest: false });

      expect(result.dryRun).toBe(true);
      expect(result.novel).toBe(1);
      expect(result.units[0].ingested).toBe(false);
    });
  });
});
