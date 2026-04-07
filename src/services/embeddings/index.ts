import { embeddingsConfig } from '../../config.js';
import type { EmbeddingsProvider } from './types.js';
import { OpenAIEmbeddingsProvider } from './openai.js';
import { OllamaEmbeddingsProvider } from './ollama.js';

export type { EmbeddingsProvider } from './types.js';
export { OpenAIEmbeddingsProvider } from './openai.js';
export { OllamaEmbeddingsProvider } from './ollama.js';

/**
 * Create embeddings provider based on configuration
 *
 * Selection logic:
 * 1. Use EMBEDDINGS_PROVIDER env var if set
 * 2. Default to 'ollama' for development, 'openai' for production
 */
function createEmbeddingsProvider(): EmbeddingsProvider {
  const provider = embeddingsConfig.provider;

  console.log(`📊 Initializing embeddings provider: ${provider}`);

  switch (provider) {
    case 'openai':
      if (!embeddingsConfig.openai) {
        throw new Error('OpenAI embeddings config missing. Set OPENAI_API_KEY.');
      }
      console.log(`   Model: ${embeddingsConfig.openai.model}`);
      console.log(`   Dimensions: ${embeddingsConfig.openai.dimensions}`);
      return new OpenAIEmbeddingsProvider(embeddingsConfig.openai);

    case 'ollama':
      if (!embeddingsConfig.ollama) {
        throw new Error('Ollama embeddings config missing. Set OLLAMA_URL.');
      }
      console.log(`   Model: ${embeddingsConfig.ollama.model}`);
      console.log(`   Dimensions: ${embeddingsConfig.ollama.dimensions}`);
      console.log(`   URL: ${embeddingsConfig.ollama.url}`);
      return new OllamaEmbeddingsProvider(embeddingsConfig.ollama);

    default:
      throw new Error(`Unknown embeddings provider: ${provider}`);
  }
}

/**
 * Singleton embeddings service instance
 *
 * Usage:
 *   import { embeddingsService } from './services/embeddings/index.js';
 *   const vectors = await embeddingsService.generateEmbeddings(texts);
 */
export const embeddingsService = createEmbeddingsProvider();

/**
 * Get current provider dimensions (needed for vector DB schema)
 */
export function getEmbeddingDimensions(): number {
  return embeddingsService.dimensions;
}
