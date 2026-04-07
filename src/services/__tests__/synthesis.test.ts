import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { SynthesisService } from '../synthesis.js';

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
}));

function createMockClient(responseContent: string | null) {
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

// ─── Tests ───────────────────────────────────────────────────────────────

describe('SynthesisService', () => {
  describe('standard mode', () => {
    it('synthesizes an answer from context', async () => {
      const client = createMockClient('This is the synthesized answer.');
      const service = new SynthesisService(client, 'gpt-4o-mini');

      const result = await service.synthesize(
        'What is GraphRAG?',
        'KNOWLEDGE UNITS:\n### GraphRAG\nGraph-enhanced retrieval augmented generation.',
        'standard'
      );

      expect(result.answer).toBe('This is the synthesized answer.');
      expect(result.mode).toBe('standard');
      expect(result.model).toBe('gpt-4o-mini');
      expect(result.swarm).toBeUndefined();
    });

    it('handles null LLM response', async () => {
      const client = createMockClient(null);
      const service = new SynthesisService(client, 'gpt-4o-mini');

      const result = await service.synthesize('query', 'context', 'standard');

      expect(result.answer).toBe('Unable to generate answer.');
    });

    it('passes context and query to LLM', async () => {
      const client = createMockClient('Answer.');
      const service = new SynthesisService(client, 'test-model');

      await service.synthesize('my question', 'my context', 'standard');

      const createFn = client.chat.completions.create as any;
      expect(createFn).toHaveBeenCalledTimes(1);
      const args = createFn.mock.calls[0][0];
      expect(args.model).toBe('test-model');
      expect(args.messages[1].content).toContain('my context');
      expect(args.messages[2].content).toContain('my question');
    });
  });

  describe('synthesize routing', () => {
    it('defaults to standard mode', async () => {
      const client = createMockClient('Answer.');
      const service = new SynthesisService(client, 'gpt-4o-mini');

      const result = await service.synthesize('query', 'context');

      expect(result.mode).toBe('standard');
    });
  });
});
