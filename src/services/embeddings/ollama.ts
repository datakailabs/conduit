import type { EmbeddingsProvider, OllamaProviderConfig } from './types.js';

/**
 * Ollama Embeddings Provider
 *
 * Uses local Ollama instance for embedding generation.
 * Recommended for development (free, offline, fast iteration).
 *
 * Supported models:
 * - nomic-embed-text: 768 dimensions (default)
 * - mxbai-embed-large: 1024 dimensions
 * - all-minilm: 384 dimensions
 */
export class OllamaEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = 'ollama';
  readonly dimensions: number;

  private url: string;
  private model: string;

  constructor(config: OllamaProviderConfig) {
    this.url = config.url;
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    try {
      const embeddings: number[][] = [];

      // Ollama API processes one text at a time
      for (const text of texts) {
        const response = await fetch(`${this.url}/api/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            prompt: text,
          }),
        });

        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.statusText}`);
        }

        const data = (await response.json()) as { embedding: number[] };
        embeddings.push(data.embedding);
      }

      return embeddings;
    } catch (error) {
      console.error('❌ Ollama embeddings error:', error);
      throw error;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }
}
