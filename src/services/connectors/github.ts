/**
 * GitHub Connector — Syncs documents from a GitHub repository.
 *
 * Uses the GitHub REST API to discover and fetch documentation files.
 * - Initial sync: Tree API (full manifest in 1 request) + raw content fetches
 * - Incremental sync: Compare API (changed files only) + selective fetches
 * - Cursor stores last commit SHA + content hashes for change detection
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
import { documentParser, detectFormat } from './parsers/index.js';

// ─── Settings ─────────────────────────────────────────────────────────

interface GitHubSettings {
  /** GitHub personal access token */
  token: string;
  /** Repository owner (user or org) */
  owner: string;
  /** Repository name */
  repo: string;
  /** Branch to sync (default: repo default branch) */
  branch?: string;
  /** Max file size in bytes (default: 1MB — GitHub Contents API limit) */
  maxFileSizeBytes?: number;
  /** GitHub API base URL (default: https://api.github.com) */
  apiBase?: string;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

interface CompareFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  sha: string;
  previous_filename?: string;
}

const DEFAULT_MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB (GitHub API limit for inline content)
const FETCH_CONCURRENCY = 10; // Parallel file fetches to avoid sequential bottleneck

/** Default patterns to include — high knowledge density files */
const DEFAULT_INCLUDE_PATTERNS = [
  'README*',
  'CONTRIBUTING*',
  'CHANGELOG*',
  'ARCHITECTURE*',
  'LICENSE*',
  'docs/**',
  '*.md',
];

// ─── Helpers ──────────────────────────────────────────────────────────

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
  return new RegExp(`^${regex}$`, 'i').test(filepath);
}

function shouldInclude(
  path: string,
  includePatterns?: string[],
  excludePatterns?: string[]
): boolean {
  if (excludePatterns?.length) {
    for (const pattern of excludePatterns) {
      if (matchesGlob(path, pattern)) return false;
    }
  }

  const includes = includePatterns?.length ? includePatterns : DEFAULT_INCLUDE_PATTERNS;
  for (const pattern of includes) {
    if (matchesGlob(path, pattern)) return true;
  }

  return false;
}

// ─── GitHub API Client ────────────────────────────────────────────────

class GitHubAPI {
  private token: string;
  private owner: string;
  private repo: string;
  private apiBase: string;

  constructor(settings: GitHubSettings) {
    this.token = settings.token;
    this.owner = settings.owner;
    this.repo = settings.repo;
    this.apiBase = settings.apiBase || 'https://api.github.com';
  }

  private async request<T>(path: string, accept?: string): Promise<T> {
    const url = `${this.apiBase}${path}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    }

    return res.json() as Promise<T>;
  }

  private async requestRaw(path: string): Promise<string> {
    const url = `${this.apiBase}${path}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    }

    return res.text();
  }

  /** Get the default branch name */
  async getDefaultBranch(): Promise<string> {
    const repo = await this.request<{ default_branch: string }>(
      `/repos/${this.owner}/${this.repo}`
    );
    return repo.default_branch;
  }

  /** Get the latest commit SHA for a branch */
  async getBranchSHA(branch: string): Promise<string> {
    const ref = await this.request<{ object: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${branch}`
    );
    return ref.object.sha;
  }

  /** Get the full file tree (recursive) for a commit */
  async getTree(treeSHA: string): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
    const commit = await this.request<{ tree: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/commits/${treeSHA}`
    );
    return this.request<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${this.owner}/${this.repo}/git/trees/${commit.tree.sha}?recursive=1`
    );
  }

  /** Compare two commits to get changed files */
  async compare(base: string, head: string): Promise<{ files: CompareFile[]; total_commits: number }> {
    return this.request<{ files: CompareFile[]; total_commits: number }>(
      `/repos/${this.owner}/${this.repo}/compare/${base}...${head}`
    );
  }

  /** Get raw file content via Contents API */
  async getFileContent(path: string, ref: string): Promise<string> {
    return this.requestRaw(
      `/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(path)}?ref=${ref}`
    );
  }

  /** Get file content via Blobs API (for files fetched via Tree API) */
  async getBlob(sha: string): Promise<Buffer> {
    const blob = await this.request<{ content: string; encoding: string }>(
      `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`
    );
    if (blob.encoding === 'base64') {
      return Buffer.from(blob.content, 'base64');
    }
    return Buffer.from(blob.content, 'utf-8');
  }
}

// ─── Connector ────────────────────────────────────────────────────────

export class GitHubConnector implements Connector {
  readonly type = 'github';
  readonly description = 'Sync documentation from a GitHub repository';

  validate(config: ConnectorConfig): string | null {
    const s = config.settings as Partial<GitHubSettings>;

    if (!s.token || typeof s.token !== 'string') {
      return 'settings.token is required (GitHub personal access token)';
    }
    if (!s.owner || typeof s.owner !== 'string') {
      return 'settings.owner is required (repository owner)';
    }
    if (!s.repo || typeof s.repo !== 'string') {
      return 'settings.repo is required (repository name)';
    }

    return null;
  }

  async discover(config: ConnectorConfig): Promise<Array<{
    sourceId: string;
    title: string;
    modifiedAt: string;
    sizeBytes?: number;
  }>> {
    const settings = config.settings as unknown as GitHubSettings;
    const api = new GitHubAPI(settings);
    const branch = settings.branch || await api.getDefaultBranch();
    const commitSHA = await api.getBranchSHA(branch);
    const { tree } = await api.getTree(commitSHA);

    return tree
      .filter(entry => {
        if (entry.type !== 'blob') return false;
        const format = detectFormat(entry.path);
        if (!format) return false;
        return shouldInclude(entry.path, config.includePatterns, config.excludePatterns);
      })
      .map(entry => ({
        sourceId: entry.path,
        title: entry.path,
        modifiedAt: new Date().toISOString(), // Tree API doesn't have per-file timestamps
        sizeBytes: entry.size,
      }));
  }

  async sync(config: ConnectorConfig, cursor?: SyncCursor): Promise<SyncResult> {
    const settings = config.settings as unknown as GitHubSettings;
    const maxSize = settings.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
    const api = new GitHubAPI(settings);
    const branch = settings.branch || await api.getDefaultBranch();
    const headSHA = await api.getBranchSHA(branch);
    const previousSHA = cursor?.state?.commitSHA as string | undefined;
    const previousHashes = (cursor?.state?.hashes as Record<string, string>) || {};

    // Determine which files to process
    let filesToProcess: Array<{ path: string; sha: string; size?: number }>;
    let deletedPaths: string[] = [];
    let isIncremental = false;

    if (previousSHA && previousSHA !== headSHA) {
      // Incremental sync via Compare API
      isIncremental = true;
      try {
        const comparison = await api.compare(previousSHA, headSHA);
        filesToProcess = comparison.files
          .filter(f => f.status !== 'removed')
          .filter(f => {
            const format = detectFormat(f.filename);
            if (!format) return false;
            return shouldInclude(f.filename, config.includePatterns, config.excludePatterns);
          })
          .map(f => ({ path: f.filename, sha: f.sha }));

        deletedPaths = comparison.files
          .filter(f => f.status === 'removed')
          .filter(f => previousHashes[f.filename]) // Only report files we previously tracked
          .map(f => f.filename);
      } catch {
        // Compare may fail if base commit was force-pushed away — fall back to full sync
        isIncremental = false;
        filesToProcess = await this.getFullTree(api, headSHA, config, maxSize);
      }
    } else if (previousSHA === headSHA) {
      // No new commits — nothing to do
      return {
        upserted: [],
        deleted: [],
        cursor: {
          connectorType: this.type,
          sourceId: `${settings.owner}/${settings.repo}`,
          lastSyncAt: new Date().toISOString(),
          state: { commitSHA: headSHA, hashes: previousHashes },
        },
        stats: { discovered: 0, new: 0, updated: 0, deleted: 0, unchanged: Object.keys(previousHashes).length, errors: 0 },
        errors: [],
      };
    } else {
      // Initial sync — full tree
      filesToProcess = await this.getFullTree(api, headSHA, config, maxSize);
    }

    // Fetch and parse files (concurrent batches for performance)
    const upserted: SourceDocument[] = [];
    const errors: Array<{ sourceId: string; error: string }> = [];
    const currentHashes: Record<string, string> = isIncremental ? { ...previousHashes } : {};
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;

    const repoUrl = `https://github.com/${settings.owner}/${settings.repo}`;

    // Process a single file — returns result or null
    const processFile = async (file: { path: string; sha: string; size?: number }) => {
      // Skip oversized files
      if (file.size && file.size > maxSize) {
        return { error: { sourceId: file.path, error: `File too large (${(file.size / 1024).toFixed(0)}KB > ${(maxSize / 1024).toFixed(0)}KB limit)` } };
      }

      const rawContent = await api.getFileContent(file.path, headSHA);
      const hash = contentHash(rawContent);

      // Skip unchanged
      if (previousHashes[file.path] === hash) {
        return { hash, unchanged: true, path: file.path };
      }

      // Parse document
      const format = detectFormat(file.path);
      if (!format) return { hash, skip: true, path: file.path };

      const buffer = Buffer.from(rawContent, 'utf-8');
      const parsed = await documentParser.parse(buffer, format, file.path);

      if (!parsed.content.trim()) {
        return { hash, error: { sourceId: file.path, error: 'Empty document after parsing' }, path: file.path };
      }

      const provenance: SourceProvenance = {
        type: 'url',
        url: `${repoUrl}/blob/${branch}/${file.path}`,
        fetchedAt: new Date().toISOString(),
        title: parsed.title,
      };

      return {
        hash,
        path: file.path,
        doc: {
          sourceId: file.path,
          title: parsed.title,
          content: parsed.content,
          provenance,
          domainHints: config.domainHints,
          contentHash: hash,
          modifiedAt: new Date().toISOString(),
        } as SourceDocument,
        isUpdate: !!previousHashes[file.path],
      };
    };

    // Process in concurrent batches
    for (let i = 0; i < filesToProcess.length; i += FETCH_CONCURRENCY) {
      const batch = filesToProcess.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(processFile));

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'rejected') {
          errors.push({ sourceId: batch[j].path, error: String(result.reason) });
          continue;
        }
        const val = result.value;
        if (!val) continue;
        if (val.hash && val.path) currentHashes[val.path] = val.hash;
        if (val.error && typeof val.error === 'object' && 'sourceId' in val.error) {
          errors.push(val.error as { sourceId: string; error: string });
          continue;
        }
        if ((val as any).unchanged) { unchangedCount++; continue; }
        if ((val as any).skip) continue;
        if ((val as any).doc) {
          upserted.push((val as any).doc);
          if ((val as any).isUpdate) updatedCount++; else newCount++;
        }
      }
    }

    // For incremental syncs, remove deleted paths from hashes
    for (const path of deletedPaths) {
      delete currentHashes[path];
    }

    // For full syncs, detect deletions by comparing against previous hashes
    if (!isIncremental && previousSHA) {
      const currentPaths = new Set(Object.keys(currentHashes));
      for (const prevPath of Object.keys(previousHashes)) {
        if (!currentPaths.has(prevPath)) {
          deletedPaths.push(prevPath);
        }
      }
    }

    const newCursor: SyncCursor = {
      connectorType: this.type,
      sourceId: `${settings.owner}/${settings.repo}`,
      lastSyncAt: new Date().toISOString(),
      state: { commitSHA: headSHA, hashes: currentHashes },
    };

    return {
      upserted,
      deleted: deletedPaths,
      cursor: newCursor,
      stats: {
        discovered: filesToProcess.length,
        new: newCount,
        updated: updatedCount,
        deleted: deletedPaths.length,
        unchanged: unchangedCount,
        errors: errors.length,
      },
      errors,
    };
  }

  /** Get all matching files from the full tree */
  private async getFullTree(
    api: GitHubAPI,
    commitSHA: string,
    config: ConnectorConfig,
    maxSize: number
  ): Promise<Array<{ path: string; sha: string; size?: number }>> {
    const { tree } = await api.getTree(commitSHA);

    return tree
      .filter(entry => {
        if (entry.type !== 'blob') return false;
        const format = detectFormat(entry.path);
        if (!format) return false;
        return shouldInclude(entry.path, config.includePatterns, config.excludePatterns);
      })
      .map(entry => ({ path: entry.path, sha: entry.sha, size: entry.size }));
  }
}
