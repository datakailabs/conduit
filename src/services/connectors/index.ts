/**
 * Connector Manager — Orchestrates connectors and routes results to ingestion.
 *
 * Responsibilities:
 * - Registry of available connector types
 * - Runs sync operations and feeds results into IngestionService
 * - Manages sync cursors for incremental updates
 * - Handles document deletion when sources remove content
 */

import { randomUUID } from 'crypto';
import type { Connector, ConnectorConfig, SyncCursor, SyncResult, SourceDocument } from '../../types/connector.js';
import type { IngestionService, IngestResult } from '../ingestion.js';
import { FilesystemConnector } from './filesystem.js';
import { GitHubConnector } from './github.js';
import { PostgreSQLConnector } from './postgresql.js';
import { enrichDomains } from './domain-enrichment.js';
import { arangoClient } from '../../clients/arango/index.js';
import { postgres } from '../../clients/postgres.js';

export { DocumentParserService, documentParser, detectFormat } from './parsers/index.js';
export { FilesystemConnector } from './filesystem.js';
export { GitHubConnector } from './github.js';
export { PostgreSQLConnector } from './postgresql.js';
export { enrichDomains } from './domain-enrichment.js';

/** Result of running a connector sync + ingestion cycle */
export interface ConnectorSyncResult {
  /** Raw sync result from the connector */
  sync: SyncResult;
  /** Per-document ingestion results */
  ingestion: Array<{
    sourceId: string;
    zettelId: string;
    result: IngestResult;
  }>;
  /** Overall summary */
  summary: {
    documentsProcessed: number;
    documentsIngested: number;
    documentsFailed: number;
    documentsDeleted: number;
  };
}

export class ConnectorManager {
  private connectors = new Map<string, Connector>();
  private ingestion: IngestionService;

  constructor(ingestion: IngestionService) {
    this.ingestion = ingestion;

    // Register built-in connectors
    this.register(new FilesystemConnector());
    this.register(new GitHubConnector());
    this.register(new PostgreSQLConnector());
  }

  /** Register a connector type */
  register(connector: Connector): void {
    this.connectors.set(connector.type, connector);
  }

  /** Get a registered connector by type */
  get(type: string): Connector | undefined {
    return this.connectors.get(type);
  }

  /** List all registered connector types */
  listTypes(): Array<{ type: string; description: string }> {
    return Array.from(this.connectors.values()).map(c => ({
      type: c.type,
      description: c.description,
    }));
  }

  /**
   * Run a full sync cycle: discover → sync → ingest new/changed → delete removed.
   */
  async syncAndIngest(
    config: ConnectorConfig,
    cursor?: SyncCursor
  ): Promise<ConnectorSyncResult> {
    const connector = this.connectors.get(config.type);
    if (!connector) {
      throw new Error(`Unknown connector type: ${config.type}. Available: ${Array.from(this.connectors.keys()).join(', ')}`);
    }

    // Validate config
    const validationError = connector.validate(config);
    if (validationError) {
      throw new Error(`Invalid connector config: ${validationError}`);
    }

    // Run sync
    const syncResult = await connector.sync(config, cursor);

    // Ingest new/changed documents
    const ingestionResults: ConnectorSyncResult['ingestion'] = [];
    let ingested = 0;
    let failed = 0;

    for (const doc of syncResult.upserted) {
      const zettelId = this.sourceIdToZettelId(config, doc.sourceId);

      // Enrich domains based on content keywords (e.g. tag genai for AI-related docs)
      const enrichedDomains = enrichDomains(doc.title, doc.content, doc.domainHints || []);

      const result = await this.ingestion.ingestKnowledgeUnit(config.organizationId, {
        id: zettelId,
        title: doc.title,
        content: doc.content,
        domains: enrichedDomains,
        topics: [], // Will be enriched by extractor if needed
        knowledgeType: 'concept',
        contextSource: 'vendor-doc',
        sourceUrl: doc.provenance.url || doc.provenance.path,
        provenance: doc.provenance,
      });

      ingestionResults.push({ sourceId: doc.sourceId, zettelId, result });

      if (result.success) {
        ingested++;
      } else {
        failed++;
      }
    }

    // Delete removed documents
    let deleted = 0;
    for (const sourceId of syncResult.deleted) {
      const zettelId = this.sourceIdToZettelId(config, sourceId);
      const ok = await this.ingestion.deleteZettel(config.organizationId, zettelId);
      if (ok) deleted++;
    }

    // Sync chunk metadata for ingested zettels (domains/topics from ArangoDB → pgvector)
    const ingestedZettelIds = ingestionResults
      .filter(r => r.result.success)
      .map(r => r.zettelId);
    if (ingestedZettelIds.length > 0) {
      await this.syncChunkMetadata(config.organizationId, ingestedZettelIds);
    }

    return {
      sync: syncResult,
      ingestion: ingestionResults,
      summary: {
        documentsProcessed: syncResult.upserted.length,
        documentsIngested: ingested,
        documentsFailed: failed,
        documentsDeleted: deleted,
      },
    };
  }

  /** Sync chunk metadata (domains/topics) from ArangoDB to pgvector for specific zettels */
  private async syncChunkMetadata(orgId: string, zettelIds: string[]): Promise<void> {
    try {
      let synced = 0;

      for (const zettelId of zettelIds) {
        const zettel = await arangoClient.getZettel(orgId, zettelId);
        if (!zettel) continue;

        await postgres.updateChunkMetadata(orgId, zettelId, {
          domains: zettel.domains || [],
          topics: zettel.topics || [],
        });
        synced++;
      }

      if (synced > 0) {
        console.log(`  ✅ Chunk metadata synced for ${synced}/${zettelIds.length} zettels`);
      }
    } catch (err) {
      console.warn('  ⚠️  Chunk metadata sync failed (non-critical):', err instanceof Error ? err.message : err);
    }
  }

  /** Generate a deterministic zettel ID from connector source */
  private sourceIdToZettelId(config: ConnectorConfig, sourceId: string): string {
    return `${config.type}:${config.name}:${sourceId}`
      .toLowerCase()
      .replace(/\//g, '.')       // Replace path separators (ArangoDB can't have / in keys)
      .replace(/[^a-z0-9:._-]/g, '-')
      .replace(/-+/g, '-');
  }
}
