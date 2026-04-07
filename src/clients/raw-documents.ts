/**
 * Raw Document Store — Preserves source content before parsing/enrichment.
 *
 * This is the "raw layer" in data engineering terms. By storing the untouched
 * source content, we can reprocess documents when parsing logic, enrichment
 * rules, or chunking strategies change — without re-fetching from source.
 */

import type { Pool } from 'pg';

export interface RawDocumentRecord {
  organizationId: string;
  connectorType: string;
  connectorName: string;
  sourceId: string;
  contentHash: string;
  rawContent: string;
  rawSizeBytes: number;
  format?: string;
  sourcePath?: string;
  fetchedAt: string;
}

export class RawDocumentStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Ensure the raw_documents table exists (runs migration idempotently) */
  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS raw_documents (
        id BIGSERIAL PRIMARY KEY,
        organization_id TEXT NOT NULL,
        connector_type TEXT NOT NULL,
        connector_name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        raw_content TEXT NOT NULL,
        raw_size_bytes INT NOT NULL,
        format TEXT,
        source_path TEXT,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, connector_type, connector_name, source_id)
      )
    `);
  }

  /** Upsert a batch of raw documents (insert or update on conflict) */
  async saveBatch(docs: RawDocumentRecord[]): Promise<number> {
    if (docs.length === 0) return 0;

    let saved = 0;
    // Batch in groups of 50 to avoid query size limits
    for (let i = 0; i < docs.length; i += 50) {
      const batch = docs.slice(i, i + 50);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < batch.length; j++) {
        const doc = batch[j];
        const offset = j * 9;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
        );
        values.push(
          doc.organizationId,
          doc.connectorType,
          doc.connectorName,
          doc.sourceId,
          doc.contentHash,
          doc.rawContent,
          doc.rawSizeBytes,
          doc.format || null,
          doc.sourcePath || null,
        );
      }

      const result = await this.pool.query(
        `INSERT INTO raw_documents
           (organization_id, connector_type, connector_name, source_id, content_hash, raw_content, raw_size_bytes, format, source_path)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (organization_id, connector_type, connector_name, source_id)
         DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           raw_content = EXCLUDED.raw_content,
           raw_size_bytes = EXCLUDED.raw_size_bytes,
           format = EXCLUDED.format,
           source_path = EXCLUDED.source_path,
           fetched_at = NOW()`,
        values,
      );

      saved += result.rowCount ?? 0;
    }

    return saved;
  }

  /** Delete raw documents by source IDs */
  async deleteBatch(
    organizationId: string,
    connectorType: string,
    connectorName: string,
    sourceIds: string[],
  ): Promise<number> {
    if (sourceIds.length === 0) return 0;

    const result = await this.pool.query(
      `DELETE FROM raw_documents
       WHERE organization_id = $1
         AND connector_type = $2
         AND connector_name = $3
         AND source_id = ANY($4)`,
      [organizationId, connectorType, connectorName, sourceIds],
    );

    return result.rowCount ?? 0;
  }

  /** Get count of raw documents for a connector */
  async count(
    organizationId: string,
    connectorType?: string,
    connectorName?: string,
  ): Promise<number> {
    let query = 'SELECT COUNT(*) FROM raw_documents WHERE organization_id = $1';
    const params: unknown[] = [organizationId];

    if (connectorType) {
      query += ' AND connector_type = $2';
      params.push(connectorType);
    }
    if (connectorName) {
      query += ` AND connector_name = $${params.length + 1}`;
      params.push(connectorName);
    }

    const result = await this.pool.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }
}
