/**
 * PostgreSQL Connector — Syncs knowledge from an external PostgreSQL database.
 *
 * Executes a user-provided SQL query and maps result columns to zettel fields.
 * Supports incremental sync via a timestamp column or content hashing.
 * Connects to an EXTERNAL database — not Conduit's own PostgreSQL instance.
 */

import { createHash } from 'crypto';
import type {
  Connector,
  ConnectorConfig,
  SourceDocument,
  SyncCursor,
  SyncResult,
} from '../../types/connector.js';
import type { SourceProvenance } from '../../types/provenance.js';

// ─── Settings ─────────────────────────────────────────────────────────

interface PostgreSQLSettings {
  /** PostgreSQL connection string (e.g., postgresql://user:pass@host:5432/db) */
  connectionString: string;
  /** SQL query to fetch rows. Must return at least the columns mapped below. */
  query: string;
  /** Column mapping: which columns map to zettel fields */
  columns: {
    /** Column used as unique row identifier (required) */
    id: string;
    /** Column used as document title (required) */
    title: string;
    /** Column(s) concatenated as document content (required — string or array) */
    content: string | string[];
    /** Column with last-modified timestamp (optional — enables timestamp-based sync) */
    modifiedAt?: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function extractContent(row: Record<string, unknown>, contentColumns: string | string[]): string {
  const cols = Array.isArray(contentColumns) ? contentColumns : [contentColumns];
  const parts: string[] = [];

  for (const col of cols) {
    const value = row[col];
    if (value != null && value !== '') {
      parts.push(String(value));
    }
  }

  return parts.join('\n\n');
}

function validateSettings(settings: Partial<PostgreSQLSettings>): string | null {
  if (!settings.connectionString || typeof settings.connectionString !== 'string') {
    return 'settings.connectionString is required';
  }
  if (!settings.query || typeof settings.query !== 'string') {
    return 'settings.query is required (SQL SELECT statement)';
  }
  if (!settings.columns || typeof settings.columns !== 'object') {
    return 'settings.columns is required (column mapping)';
  }
  if (!settings.columns.id) return 'settings.columns.id is required';
  if (!settings.columns.title) return 'settings.columns.title is required';
  if (!settings.columns.content) return 'settings.columns.content is required';

  // Basic SQL injection guard — only allow SELECT statements
  const normalized = settings.query.trim().toLowerCase();
  if (!normalized.startsWith('select')) {
    return 'settings.query must be a SELECT statement';
  }

  return null;
}

// ─── Connector ────────────────────────────────────────────────────────

export class PostgreSQLConnector implements Connector {
  readonly type = 'postgresql';
  readonly description = 'Sync knowledge from an external PostgreSQL database';

  validate(config: ConnectorConfig): string | null {
    return validateSettings(config.settings as Partial<PostgreSQLSettings>);
  }

  async discover(config: ConnectorConfig): Promise<Array<{
    sourceId: string;
    title: string;
    modifiedAt: string;
    sizeBytes?: number;
  }>> {
    const settings = config.settings as unknown as PostgreSQLSettings;
    const rows = await this.executeQuery(settings);

    return rows.map(row => {
      const id = String(row[settings.columns.id]);
      const title = String(row[settings.columns.title] || id);
      const modifiedAt = settings.columns.modifiedAt && row[settings.columns.modifiedAt]
        ? new Date(row[settings.columns.modifiedAt] as string).toISOString()
        : new Date().toISOString();
      const content = extractContent(row, settings.columns.content);

      return {
        sourceId: id,
        title,
        modifiedAt,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
      };
    });
  }

  async sync(config: ConnectorConfig, cursor?: SyncCursor): Promise<SyncResult> {
    const settings = config.settings as unknown as PostgreSQLSettings;
    const previousHashes = (cursor?.state?.hashes as Record<string, string>) || {};

    // Execute query — if we have a modifiedAt column and cursor, we could optimize
    // with a WHERE clause, but for safety we always fetch all rows and diff locally.
    // The user can add their own WHERE clause to the query if needed.
    const rows = await this.executeQuery(settings);

    const upserted: SourceDocument[] = [];
    const errors: Array<{ sourceId: string; error: string }> = [];
    const currentHashes: Record<string, string> = {};
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;

    for (const row of rows) {
      const id = String(row[settings.columns.id]);

      try {
        const title = String(row[settings.columns.title] || id);
        const content = extractContent(row, settings.columns.content);

        if (!content.trim()) {
          errors.push({ sourceId: id, error: 'Empty content after extraction' });
          continue;
        }

        const hash = contentHash(content);
        currentHashes[id] = hash;

        // Skip unchanged
        if (previousHashes[id] === hash) {
          unchangedCount++;
          continue;
        }

        const modifiedAt = settings.columns.modifiedAt && row[settings.columns.modifiedAt]
          ? new Date(row[settings.columns.modifiedAt] as string).toISOString()
          : new Date().toISOString();

        const provenance: SourceProvenance = {
          type: 'database',
          query: settings.query,
          fetchedAt: new Date().toISOString(),
          title,
        };

        upserted.push({
          sourceId: id,
          title,
          content,
          provenance,
          domainHints: config.domainHints,
          contentHash: hash,
          modifiedAt,
        });

        if (previousHashes[id]) {
          updatedCount++;
        } else {
          newCount++;
        }
      } catch (err) {
        errors.push({
          sourceId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Detect deletions: rows in previous hashes that no longer appear
    const currentIds = new Set(Object.keys(currentHashes));
    const deleted = Object.keys(previousHashes).filter(id => !currentIds.has(id));

    const newCursor: SyncCursor = {
      connectorType: this.type,
      sourceId: settings.connectionString.replace(/\/\/[^@]*@/, '//***@'), // Redact credentials
      lastSyncAt: new Date().toISOString(),
      state: { hashes: currentHashes },
    };

    return {
      upserted,
      deleted,
      cursor: newCursor,
      stats: {
        discovered: rows.length,
        new: newCount,
        updated: updatedCount,
        deleted: deleted.length,
        unchanged: unchangedCount,
        errors: errors.length,
      },
      errors,
    };
  }

  /** Execute the configured query against the external database */
  private async executeQuery(settings: PostgreSQLSettings): Promise<Record<string, unknown>[]> {
    // Dynamic import — pg is already a dependency but we isolate the connection
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: settings.connectionString });

    try {
      const result = await pool.query(settings.query);
      return result.rows;
    } finally {
      await pool.end();
    }
  }
}
