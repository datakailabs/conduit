/**
 * Filesystem Connector — Syncs documents from a local directory.
 *
 * Watches a directory for markdown, PDF, DOCX, and other supported files.
 * Supports incremental sync via file modification timestamps and content hashing.
 * Respects include/exclude glob patterns.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, extname } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';
import type {
  Connector,
  ConnectorConfig,
  SourceDocument,
  SyncCursor,
  SyncResult,
} from '../../types/connector.js';
import type { SourceProvenance } from '../../types/provenance.js';
import { documentParser, detectFormat } from './parsers/index.js';

/** Filesystem-specific connector settings */
interface FilesystemSettings {
  /** Root directory to scan */
  path: string;
  /** Whether to scan subdirectories (default: true) */
  recursive?: boolean;
  /** Max file size in bytes to process (default: 10MB) */
  maxFileSizeBytes?: number;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function expandTilde(path: string): string {
  return path.startsWith('~/') ? path.replace('~', homedir()) : path;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function matchesGlob(filepath: string, pattern: string): boolean {
  // Replace **/ with optional path prefix (matches zero or more directories)
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '(.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${regex}$`).test(filepath);
}

function shouldInclude(
  relativePath: string,
  includePatterns?: string[],
  excludePatterns?: string[]
): boolean {
  // Check excludes first
  if (excludePatterns?.length) {
    for (const pattern of excludePatterns) {
      if (matchesGlob(relativePath, pattern)) return false;
    }
  }

  // If no include patterns, include everything not excluded
  if (!includePatterns?.length) return true;

  // Check includes
  for (const pattern of includePatterns) {
    if (matchesGlob(relativePath, pattern)) return true;
  }

  return false;
}

/** Recursively list files in a directory */
function listFiles(dir: string, recursive: boolean): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (recursive && !entry.name.startsWith('.')) {
        files.push(...listFiles(fullPath, true));
      }
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

export class FilesystemConnector implements Connector {
  readonly type = 'filesystem';
  readonly description = 'Sync documents from a local directory';

  validate(config: ConnectorConfig): string | null {
    const settings = config.settings as Partial<FilesystemSettings>;

    if (!settings.path || typeof settings.path !== 'string') {
      return 'settings.path is required and must be a string';
    }

    const resolved = expandTilde(settings.path);
    if (!existsSync(resolved)) {
      return `Directory does not exist: ${resolved}`;
    }

    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return `Path is not a directory: ${resolved}`;
    }

    return null;
  }

  async discover(config: ConnectorConfig): Promise<Array<{
    sourceId: string;
    title: string;
    modifiedAt: string;
    sizeBytes?: number;
  }>> {
    const settings = config.settings as unknown as FilesystemSettings;
    const rootDir = expandTilde(settings.path);
    const recursive = settings.recursive !== false;

    const allFiles = listFiles(rootDir, recursive);

    return allFiles
      .filter(filepath => {
        const format = detectFormat(filepath);
        if (!format) return false;
        const rel = relative(rootDir, filepath);
        return shouldInclude(rel, config.includePatterns, config.excludePatterns);
      })
      .map(filepath => {
        const stat = statSync(filepath);
        const rel = relative(rootDir, filepath);
        return {
          sourceId: rel,
          title: rel,
          modifiedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        };
      });
  }

  async sync(config: ConnectorConfig, cursor?: SyncCursor): Promise<SyncResult> {
    const settings = config.settings as unknown as FilesystemSettings;
    const rootDir = expandTilde(settings.path);
    const maxSize = settings.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
    const lastSyncAt = cursor?.lastSyncAt ? new Date(cursor.lastSyncAt) : new Date(0);
    const previousHashes = (cursor?.state?.hashes as Record<string, string>) || {};

    const discovered = await this.discover(config);
    const upserted: SourceDocument[] = [];
    const errors: Array<{ sourceId: string; error: string }> = [];
    const currentHashes: Record<string, string> = {};
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;

    for (const item of discovered) {
      const fullPath = join(rootDir, item.sourceId);

      try {
        // Skip files over size limit
        if (item.sizeBytes && item.sizeBytes > maxSize) {
          errors.push({
            sourceId: item.sourceId,
            error: `File too large (${(item.sizeBytes / 1024 / 1024).toFixed(1)}MB > ${(maxSize / 1024 / 1024).toFixed(0)}MB limit)`,
          });
          continue;
        }

        // Read file and compute hash
        const buffer = readFileSync(fullPath);
        const hash = contentHash(buffer.toString('utf-8'));
        currentHashes[item.sourceId] = hash;

        // Skip unchanged files
        if (previousHashes[item.sourceId] === hash) {
          unchangedCount++;
          continue;
        }

        // Parse document
        const format = detectFormat(item.sourceId);
        if (!format) continue;

        const parsed = await documentParser.parse(buffer, format, item.sourceId);

        // Skip empty documents
        if (!parsed.content.trim()) {
          errors.push({ sourceId: item.sourceId, error: 'Empty document after parsing' });
          continue;
        }

        const provenance: SourceProvenance = {
          type: 'file',
          path: fullPath,
          fetchedAt: new Date().toISOString(),
          title: parsed.title,
        };

        const doc: SourceDocument = {
          sourceId: item.sourceId,
          title: parsed.title,
          content: parsed.content,
          provenance,
          domainHints: config.domainHints,
          contentHash: hash,
          modifiedAt: item.modifiedAt,
        };

        upserted.push(doc);

        if (previousHashes[item.sourceId]) {
          updatedCount++;
        } else {
          newCount++;
        }
      } catch (err) {
        errors.push({
          sourceId: item.sourceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Detect deletions: files in previous hashes that no longer exist
    const currentSourceIds = new Set(discovered.map(d => d.sourceId));
    const deleted = Object.keys(previousHashes).filter(id => !currentSourceIds.has(id));

    const newCursor: SyncCursor = {
      connectorType: this.type,
      sourceId: rootDir,
      lastSyncAt: new Date().toISOString(),
      state: { hashes: currentHashes },
    };

    return {
      upserted,
      deleted,
      cursor: newCursor,
      stats: {
        discovered: discovered.length,
        new: newCount,
        updated: updatedCount,
        deleted: deleted.length,
        unchanged: unchangedCount,
        errors: errors.length,
      },
      errors,
    };
  }
}
