import OpenAI from 'openai';
import type { EmbeddingsProvider, OpenAIProviderConfig } from './types.js';

/**
 * OpenAI Embeddings Provider
 *
 * Uses OpenAI's text-embedding-3-small or text-embedding-3-large models.
 * Recommended for production due to quality and reliability.
 *
 * Pricing (as of 2024):
 * - text-embedding-3-small: $0.02 / 1M tokens (1536 dimensions)
 * - text-embedding-3-large: $0.13 / 1M tokens (3072 dimensions)
 */
export class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = 'openai';
  readonly dimensions: number;

  private client: OpenAI;
  private model: string;

  constructor(config: OpenAIProviderConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    try {
      // OpenAI API supports batch embedding
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      });

      // Sort by index to maintain input order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map((item) => item.embedding);
    } catch (error) {
      console.error('❌ OpenAI embeddings error:', error);
      throw error;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }
}
