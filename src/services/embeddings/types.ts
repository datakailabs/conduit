/**
 * Embeddings Provider Interface
 *
 * Abstraction layer for embedding generation providers.
 * Allows switching between OpenAI, Ollama, or other providers
 * without changing consumer code.
 */

export interface EmbeddingsProvider {
  /**
   * Provider name for logging/debugging
   */
  readonly name: string;

  /**
   * Vector dimensions produced by this provider
   */
  readonly dimensions: number;

  /**
   * Generate embeddings for multiple texts
   * @param texts - Array of text strings to embed
   * @returns Array of embedding vectors (same order as input)
   */
  generateEmbeddings(texts: string[]): Promise<number[][]>;

  /**
   * Generate embedding for a single text
   * @param text - Text string to embed
   * @returns Single embedding vector
   */
  generateEmbedding(text: string): Promise<number[]>;
}

/**
 * Provider configuration types
 */
export interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface OllamaProviderConfig {
  url: string;
  model: string;
  dimensions: number;
}

export type EmbeddingsProviderType = 'openai' | 'ollama';

export interface EmbeddingsConfig {
  provider: EmbeddingsProviderType;
  openai?: OpenAIProviderConfig;
  ollama?: OllamaProviderConfig;
}
