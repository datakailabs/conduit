/**
 * Connector Types — Interfaces for data source connectors and document parsing.
 *
 * Connectors discover, fetch, and incrementally sync content from external sources.
 * Document parsers extract clean text from file formats (PDF, DOCX, HTML, etc.).
 * Both feed into the existing IngestionService pipeline.
 */

import type { SourceProvenance } from './provenance.js';

// ─── Document Parser ─────────────────────────────────────────────────

/** Supported document formats for parsing */
export type DocumentFormat =
  | 'markdown'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'html'
  | 'csv'
  | 'txt';

/** Result of parsing a document into clean text */
export interface ParsedDocument {
  /** Extracted plain text / markdown content */
  content: string;
  /** Document title (from metadata or first heading) */
  title: string;
  /** Original format */
  format: DocumentFormat;
  /** Document-level metadata extracted during parsing */
  metadata: {
    author?: string;
    createdDate?: string;
    modifiedDate?: string;
    pageCount?: number;
    wordCount?: number;
    language?: string;
    [key: string]: unknown;
  };
}

/** Interface for document format parsers */
export interface DocumentParser {
  /** Formats this parser can handle */
  readonly supportedFormats: DocumentFormat[];
  /** Parse a buffer into clean text */
  parse(input: Buffer, format: DocumentFormat, filename?: string): Promise<ParsedDocument>;
}

// ─── Connector ───────────────────────────────────────────────────────

/** A single content item discovered by a connector */
export interface SourceDocument {
  /** Unique identifier within the source (file path, URL, row ID, etc.) */
  sourceId: string;
  /** Human-readable title */
  title: string;
  /** Clean text content (already parsed) */
  content: string;
  /** Provenance tracking back to origin */
  provenance: SourceProvenance;
  /** Optional domain hints for LLM categorization */
  domainHints?: string[];
  /** Content hash for change detection */
  contentHash: string;
  /** Last modified timestamp from the source */
  modifiedAt: string;
}

/** Sync cursor — opaque state persisted between sync runs */
export interface SyncCursor {
  /** Connector type identifier */
  connectorType: string;
  /** Source-specific identifier (e.g., directory path, repo URL) */
  sourceId: string;
  /** Last successful sync timestamp */
  lastSyncAt: string;
  /** Connector-specific state (page tokens, offsets, etc.) */
  state: Record<string, unknown>;
}

/** Result of a sync operation */
export interface SyncResult {
  /** Documents that are new or changed since last sync */
  upserted: SourceDocument[];
  /** Source IDs of documents that have been deleted from the source */
  deleted: string[];
  /** Updated cursor for next sync run */
  cursor: SyncCursor;
  /** Sync statistics */
  stats: {
    discovered: number;
    new: number;
    updated: number;
    deleted: number;
    unchanged: number;
    errors: number;
  };
  /** Errors encountered (non-fatal — sync continues past individual failures) */
  errors: Array<{ sourceId: string; error: string }>;
}

/** Configuration for a connector source */
export interface ConnectorConfig {
  /** Connector type identifier */
  type: string;
  /** Human-readable name for this source */
  name: string;
  /** Organization this source belongs to */
  organizationId: string;
  /** Connector-specific settings */
  settings: Record<string, unknown>;
  /** Optional domain hints applied to all documents from this source */
  domainHints?: string[];
  /** File patterns to include (glob). If empty, include all. */
  includePatterns?: string[];
  /** File patterns to exclude (glob) */
  excludePatterns?: string[];
}

/** Interface that all connectors must implement */
export interface Connector {
  /** Unique type identifier (e.g., 'filesystem', 'github', 'postgresql') */
  readonly type: string;
  /** Human-readable description */
  readonly description: string;

  /**
   * Validate connector configuration.
   * Returns null if valid, or an error message if invalid.
   */
  validate(config: ConnectorConfig): string | null;

  /**
   * Discover available content in the source.
   * Returns source IDs and basic metadata without fetching full content.
   */
  discover(config: ConnectorConfig): Promise<Array<{
    sourceId: string;
    title: string;
    modifiedAt: string;
    sizeBytes?: number;
  }>>;

  /**
   * Perform an incremental sync from the source.
   * Fetches new/changed content since the last cursor, detects deletions.
   */
  sync(config: ConnectorConfig, cursor?: SyncCursor): Promise<SyncResult>;
}
