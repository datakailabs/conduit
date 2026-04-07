import { Pool, PoolConfig } from 'pg';
import { postgresConfig, embeddingsConfig } from '../config.js';
import { normalizeProvenance } from '../types/provenance.js';
import type { SourceProvenance } from '../types/provenance.js';
import type { VectorStore, SearchResult, SearchFilter } from '../types/stores.js';

// Re-export domain types for backward compatibility
export type { SearchResult, SearchFilter } from '../types/stores.js';

export interface ChunkRecord {
  id: string;
  organizationId: string;
  zettelId: string;
  zettelTitle: string;
  section: string;
  content: string;
  chunkIndex: number;
  embedding: number[];
  domains: string[];
  topics: string[];
  knowledgeType: string;
  contextSource: string;
  createdAt: Date;
  updatedAt: Date;
}

class PostgresVectorStore implements VectorStore {
  private pool: Pool;
  private initialized = false;

  constructor() {
    const poolConfig: PoolConfig = postgresConfig.connectionString
      ? {
          connectionString: postgresConfig.connectionString,
          ssl: postgresConfig.ssl,
        }
      : {
          host: postgresConfig.host,
          port: postgresConfig.port,
          user: postgresConfig.user,
          password: postgresConfig.password,
          database: postgresConfig.database,
          ssl: postgresConfig.ssl,
        };

    this.pool = new Pool(poolConfig);
  }

  /**
   * Get the underlying pool (used by OrganizationStore)
   */
  getPool(): Pool {
    return this.pool;
  }

  /**
   * Initialize connection and verify pgvector extension
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Verify connection
      const client = await this.pool.connect();
      try {
        // Check if pgvector extension is enabled
        const result = await client.query(
          "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
        );

        if (result.rows.length === 0) {
          throw new Error(
            'pgvector extension not found. Run: CREATE EXTENSION vector;'
          );
        }

        // Verify chunks table exists
        const tableCheck = await client.query(
          "SELECT 1 FROM information_schema.tables WHERE table_name = 'chunks'"
        );

        if (tableCheck.rows.length === 0) {
          throw new Error(
            'chunks table not found. Run the init.sql schema migration.'
          );
        }

        this.initialized = true;
        console.log('✅ PostgreSQL vector store initialized');
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('❌ Failed to initialize PostgreSQL:', error);
      throw error;
    }
  }

  /**
   * Upsert chunks with embeddings, scoped to organization
   */
  async upsertChunks(
    organizationId: string,
    chunks: Array<{
      id: string;
      vector: number[];
      payload: {
        zettelId: string;
        zettelTitle: string;
        section: string;
        content: string;
        chunkIndex: number;
        domains: string[];
        topics: string[];
        knowledgeType: string;
        contextSource: string;
        sourceUrl?: string;
        provenance?: SourceProvenance;
        created: string;
        updated: string;
      };
    }>
  ): Promise<void> {
    if (chunks.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const chunk of chunks) {
        // Format vector as pgvector string: '[0.1,0.2,0.3]'
        const vectorStr = `[${chunk.vector.join(',')}]`;

        await client.query(
          `INSERT INTO chunks (
            id, organization_id, zettel_id, zettel_title, section, content, chunk_index,
            embedding, domains, topics, knowledge_type, context_source, source_url, provenance,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11, $12, $13, $14, $15, $16)
          ON CONFLICT (id) DO UPDATE SET
            organization_id = EXCLUDED.organization_id,
            zettel_id = EXCLUDED.zettel_id,
            zettel_title = EXCLUDED.zettel_title,
            section = EXCLUDED.section,
            content = EXCLUDED.content,
            chunk_index = EXCLUDED.chunk_index,
            embedding = EXCLUDED.embedding,
            domains = EXCLUDED.domains,
            topics = EXCLUDED.topics,
            knowledge_type = EXCLUDED.knowledge_type,
            context_source = EXCLUDED.context_source,
            source_url = EXCLUDED.source_url,
            provenance = EXCLUDED.provenance,
            updated_at = NOW()`,
          [
            chunk.id,
            organizationId,
            chunk.payload.zettelId,
            chunk.payload.zettelTitle,
            chunk.payload.section,
            chunk.payload.content,
            chunk.payload.chunkIndex,
            vectorStr,
            chunk.payload.domains,
            chunk.payload.topics,
            chunk.payload.knowledgeType,
            chunk.payload.contextSource,
            chunk.payload.provenance?.url || chunk.payload.sourceUrl || null,
            chunk.payload.provenance ? JSON.stringify(chunk.payload.provenance) : null,
            new Date(chunk.payload.created),
            new Date(chunk.payload.updated),
          ]
        );
      }

      await client.query('COMMIT');
      console.log(`✅ Upserted ${chunks.length} chunks to PostgreSQL`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Failed to upsert chunks:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Semantic similarity search using cosine distance, scoped to organization
   */
  async search(
    organizationId: string,
    vector: number[],
    limit: number = 10,
    filter?: SearchFilter
  ): Promise<SearchResult[]> {
    const vectorStr = `[${vector.join(',')}]`;

    // Build WHERE clause — always scope by organization
    const conditions: string[] = ['organization_id = $3'];
    const params: any[] = [vectorStr, limit, organizationId];
    let paramIndex = 4;

    if (filter?.domain) {
      conditions.push(`$${paramIndex} = ANY(domains)`);
      params.push(filter.domain);
      paramIndex++;
    }

    if (filter?.topics && filter.topics.length > 0) {
      conditions.push(`topics && $${paramIndex}`);
      params.push(filter.topics);
      paramIndex++;
    }

    if (filter?.knowledgeType) {
      conditions.push(`knowledge_type = $${paramIndex}`);
      params.push(filter.knowledgeType);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Cosine similarity: 1 - cosine_distance
    // pgvector uses <=> for cosine distance, so similarity = 1 - distance
    const query = `
      SELECT
        1 - (embedding <=> $1::vector) as score,
        zettel_id,
        zettel_title,
        section,
        content,
        chunk_index,
        domains,
        topics,
        knowledge_type,
        context_source,
        source_url,
        provenance,
        created_at,
        updated_at
      FROM chunks
      ${whereClause}
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, params);

      return result.rows.map((row) => ({
        score: parseFloat(row.score),
        zettelId: row.zettel_id,
        zettelTitle: row.zettel_title,
        section: row.section,
        content: row.content,
        chunkIndex: row.chunk_index,
        metadata: {
          domains: row.domains,
          topics: row.topics,
          knowledgeType: row.knowledge_type,
          contextSource: row.context_source,
          sourceUrl: row.source_url || undefined,
          provenance: normalizeProvenance(row.source_url, row.provenance),
          created: row.created_at.toISOString(),
          updated: row.updated_at.toISOString(),
        },
      }));
    } catch (error) {
      console.error('❌ Search failed:', error);
      throw error;
    }
  }

  /**
   * Delete all chunks for a specific Zettel, scoped to organization
   */
  async deleteZettelChunks(organizationId: string, zettelId: string): Promise<void> {
    try {
      await this.pool.query(
        'DELETE FROM chunks WHERE organization_id = $1 AND zettel_id = $2',
        [organizationId, zettelId]
      );
      console.log(`✅ Deleted chunks for ${zettelId}`);
    } catch (error) {
      console.error(`❌ Failed to delete chunks for ${zettelId}:`, error);
      throw error;
    }
  }

  /**
   * Get collection statistics, optionally scoped to organization
   */
  async getStats(organizationId?: string): Promise<{
    totalChunks: number;
    totalZettels: number;
    dimensions: number;
  }> {
    try {
      let result;
      if (organizationId) {
        result = await this.pool.query(
          `SELECT
            COUNT(*) as total_chunks,
            COUNT(DISTINCT zettel_id) as total_zettels
          FROM chunks
          WHERE organization_id = $1`,
          [organizationId]
        );
      } else {
        result = await this.pool.query(`
          SELECT
            COUNT(*) as total_chunks,
            COUNT(DISTINCT zettel_id) as total_zettels
          FROM chunks
        `);
      }

      return {
        totalChunks: parseInt(result.rows[0].total_chunks) || 0,
        totalZettels: parseInt(result.rows[0].total_zettels) || 0,
        dimensions: embeddingsConfig.dimensions,
      };
    } catch (error) {
      console.error('❌ Failed to get stats:', error);
      throw error;
    }
  }

  /**
   * Update chunk metadata in place without re-embedding
   */
  async updateChunkMetadata(
    organizationId: string,
    zettelId: string,
    metadata: {
      domains?: string[];
      topics?: string[];
      sourceUrl?: string | null;
      provenance?: SourceProvenance | null;
    }
  ): Promise<void> {
    const updates: string[] = [];
    const params: any[] = [organizationId, zettelId];
    let idx = 3;

    if (metadata.domains !== undefined) {
      updates.push(`domains = $${idx++}`);
      params.push(metadata.domains);
    }
    if (metadata.topics !== undefined) {
      updates.push(`topics = $${idx++}`);
      params.push(metadata.topics);
    }
    if (metadata.sourceUrl !== undefined) {
      updates.push(`source_url = $${idx++}`);
      params.push(metadata.sourceUrl);
    }
    if (metadata.provenance !== undefined) {
      updates.push(`provenance = $${idx++}`);
      params.push(metadata.provenance ? JSON.stringify(metadata.provenance) : null);
    }

    if (updates.length === 0) return;
    updates.push('updated_at = NOW()');

    await this.pool.query(
      `UPDATE chunks SET ${updates.join(', ')} WHERE organization_id = $1 AND zettel_id = $2`,
      params
    );
  }

  /**
   * Create HNSW index for faster search (run after bulk loading)
   */
  async createSearchIndex(): Promise<void> {
    console.log('📦 Creating HNSW index for vector search...');
    try {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_chunks_embedding
        ON chunks USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);
      console.log('✅ HNSW index created');
    } catch (error) {
      console.error('❌ Failed to create index:', error);
      throw error;
    }
  }

  /**
   * Close connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Singleton instance
export const postgres = new PostgresVectorStore();
