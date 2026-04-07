import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module Mocks ────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  postgresConfig: {},
  arangoConfig: { url: 'http://localhost:8529', database: 'test', username: 'root', password: '' },
  embeddingsConfig: {
    provider: 'openai',
    dimensions: 1536,
    openai: { apiKey: 'test', model: 'text-embedding-3-small', dimensions: 1536 },
  },
}));

vi.mock('../../clients/postgres.js', () => ({
  postgres: { search: vi.fn(), initialize: vi.fn() },
}));

vi.mock('../../clients/arango/index.js', () => ({
  arangoClient: { traverseGraph: vi.fn(), initialize: vi.fn() },
}));

vi.mock('../embeddings/index.js', () => ({
  embeddingsService: { generateEmbedding: vi.fn(), generateEmbeddings: vi.fn(), dimensions: 1536, name: 'mock' },
}));

import { BuiltinParser } from '../connectors/parsers/builtin.js';
import { DocumentParserService, detectFormat } from '../connectors/parsers/index.js';
import { FilesystemConnector } from '../connectors/filesystem.js';
import { GitHubConnector } from '../connectors/github.js';
import { PostgreSQLConnector } from '../connectors/postgresql.js';
import type { ConnectorConfig } from '../../types/connector.js';

// ─── Built-in Parser Tests ───────────────────────────────────────────

describe('BuiltinParser', () => {
  const parser = new BuiltinParser();

  describe('markdown', () => {
    it('parses markdown with frontmatter', async () => {
      const input = Buffer.from([
        '---',
        'title: Test Document',
        'author: Alice',
        'created: 2026-01-01',
        '---',
        '',
        '# Test Document',
        '',
        'This is the content.',
      ].join('\n'));

      const result = await parser.parse(input, 'markdown', 'test.md');

      expect(result.title).toBe('Test Document');
      expect(result.format).toBe('markdown');
      expect(result.content).toContain('This is the content.');
      expect(result.metadata.author).toBe('Alice');
    });

    it('extracts title from heading when no frontmatter', async () => {
      const input = Buffer.from('# My Title\n\nSome content.');

      const result = await parser.parse(input, 'markdown', 'doc.md');

      expect(result.title).toBe('My Title');
    });

    it('falls back to filename for title', async () => {
      const input = Buffer.from('Just some text without headings.');

      const result = await parser.parse(input, 'markdown', 'my-notes.md');

      expect(result.title).toBe('my-notes');
    });
  });

  describe('html', () => {
    it('strips tags and extracts content', async () => {
      const input = Buffer.from([
        '<html><head><title>Page Title</title></head>',
        '<body>',
        '<nav>Navigation</nav>',
        '<main><p>Important content here.</p></main>',
        '<script>alert("bad")</script>',
        '</body></html>',
      ].join('\n'));

      const result = await parser.parse(input, 'html', 'page.html');

      expect(result.title).toBe('Page Title');
      expect(result.content).toContain('Important content here.');
      expect(result.content).not.toContain('alert');
      expect(result.content).not.toContain('<p>');
    });
  });

  describe('plain text', () => {
    it('parses plain text files', async () => {
      const input = Buffer.from('First line is the title.\n\nSecond paragraph.');

      const result = await parser.parse(input, 'txt', 'notes.txt');

      expect(result.title).toBe('notes');
      expect(result.content).toContain('Second paragraph.');
      expect(result.format).toBe('txt');
    });
  });

  describe('csv', () => {
    it('converts CSV rows to readable text', async () => {
      const input = Buffer.from('Name,Age,City\nAlice,30,London\nBob,25,Paris');

      const result = await parser.parse(input, 'csv', 'people.csv');

      expect(result.title).toBe('people');
      expect(result.content).toContain('Name: Alice');
      expect(result.content).toContain('Age: 30');
      expect(result.content).toContain('City: Paris');
      expect(result.metadata.rowCount).toBe(2);
    });
  });
});

// ─── Format Detection Tests ──────────────────────────────────────────

describe('detectFormat', () => {
  it('detects common file extensions', () => {
    expect(detectFormat('doc.md')).toBe('markdown');
    expect(detectFormat('doc.markdown')).toBe('markdown');
    expect(detectFormat('doc.txt')).toBe('txt');
    expect(detectFormat('doc.html')).toBe('html');
    expect(detectFormat('doc.htm')).toBe('html');
    expect(detectFormat('doc.pdf')).toBe('pdf');
    expect(detectFormat('doc.docx')).toBe('docx');
    expect(detectFormat('doc.pptx')).toBe('pptx');
    expect(detectFormat('doc.xlsx')).toBe('xlsx');
    expect(detectFormat('doc.csv')).toBe('csv');
  });

  it('returns null for unknown extensions', () => {
    expect(detectFormat('doc.xyz')).toBeNull();
    expect(detectFormat('doc.mp4')).toBeNull();
    expect(detectFormat('noext')).toBeNull();
  });

  it('is case-insensitive on extensions', () => {
    expect(detectFormat('DOC.MD')).toBe('markdown');
    expect(detectFormat('FILE.PDF')).toBe('pdf');
  });
});

// ─── Document Parser Service Tests ───────────────────────────────────

describe('DocumentParserService', () => {
  const service = new DocumentParserService();

  it('routes markdown to built-in parser', async () => {
    const input = Buffer.from('# Hello\n\nWorld.');

    const result = await service.parse(input, 'markdown', 'test.md');

    expect(result.title).toBe('Hello');
    expect(result.content).toContain('World.');
  });

  it('routes html to built-in parser', async () => {
    const input = Buffer.from('<html><body><p>Content</p></body></html>');

    const result = await service.parse(input, 'html', 'page.html');

    expect(result.content).toContain('Content');
  });
});

// ─── Filesystem Connector Tests ──────────────────────────────────────

describe('FilesystemConnector', () => {
  const connector = new FilesystemConnector();

  describe('validate', () => {
    it('rejects missing path', () => {
      const config: ConnectorConfig = {
        type: 'filesystem',
        name: 'test',
        organizationId: 'org_test',
        settings: {},
      };

      expect(connector.validate(config)).toContain('settings.path is required');
    });

    it('rejects non-existent path', () => {
      const config: ConnectorConfig = {
        type: 'filesystem',
        name: 'test',
        organizationId: 'org_test',
        settings: { path: '/nonexistent/path/xyz' },
      };

      expect(connector.validate(config)).toContain('does not exist');
    });

    it('accepts valid directory', () => {
      const config: ConnectorConfig = {
        type: 'filesystem',
        name: 'test',
        organizationId: 'org_test',
        settings: { path: '/tmp' },
      };

      expect(connector.validate(config)).toBeNull();
    });
  });

  describe('discover', () => {
    it('discovers supported files in a directory', async () => {
      // Create temp test files
      const { mkdtempSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const tmpDir = mkdtempSync('/tmp/conduit-test-');

      writeFileSync(join(tmpDir, 'doc1.md'), '# Doc 1\nContent');
      writeFileSync(join(tmpDir, 'doc2.txt'), 'Plain text');
      writeFileSync(join(tmpDir, 'ignore.mp4'), 'not a doc');

      const config: ConnectorConfig = {
        type: 'filesystem',
        name: 'test',
        organizationId: 'org_test',
        settings: { path: tmpDir },
      };

      const results = await connector.discover(config);

      expect(results).toHaveLength(2);
      expect(results.map(r => r.sourceId).sort()).toEqual(['doc1.md', 'doc2.txt']);

      // Cleanup
      const { rmSync } = await import('fs');
      rmSync(tmpDir, { recursive: true });
    });

    it('respects exclude patterns', async () => {
      const { mkdtempSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const tmpDir = mkdtempSync('/tmp/conduit-test-');

      writeFileSync(join(tmpDir, 'keep.md'), '# Keep');
      writeFileSync(join(tmpDir, 'skip.md'), '# Skip');

      const config: ConnectorConfig = {
        type: 'filesystem',
        name: 'test',
        organizationId: 'org_test',
        settings: { path: tmpDir },
        excludePatterns: ['skip.*'],
      };

      const results = await connector.discover(config);

      expect(results).toHaveLength(1);
      expect(results[0].sourceId).toBe('keep.md');

      const { rmSync } = await import('fs');
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('sync', () => {
    it('performs initial sync and returns all documents', async () => {
      const { mkdtempSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const tmpDir = mkdtempSync('/tmp/conduit-test-');

      writeFileSync(join(tmpDir, 'doc.md'), '# Test Doc\n\nSome content for testing.');

      const config: ConnectorConfig = {
        type: 'filesystem',
        name: 'test',
        organizationId: 'org_test',
        settings: { path: tmpDir },
      };

      const result = await connector.sync(config);

      expect(result.upserted).toHaveLength(1);
      expect(result.upserted[0].title).toBe('Test Doc');
      expect(result.upserted[0].content).toContain('Some content');
      expect(result.upserted[0].provenance.type).toBe('file');
      expect(result.stats.new).toBe(1);
      expect(result.stats.unchanged).toBe(0);
      expect(result.cursor.connectorType).toBe('filesystem');

      const { rmSync } = await import('fs');
      rmSync(tmpDir, { recursive: true });
    });

    it('skips unchanged files on subsequent sync', async () => {
      const { mkdtempSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const tmpDir = mkdtempSync('/tmp/conduit-test-');

      writeFileSync(join(tmpDir, 'doc.md'), '# Stable\n\nUnchanged content.');

      const config: ConnectorConfig = {
        type: 'filesystem',
        name: 'test',
        organizationId: 'org_test',
        settings: { path: tmpDir },
      };

      // First sync
      const first = await connector.sync(config);
      expect(first.stats.new).toBe(1);

      // Second sync with cursor from first
      const second = await connector.sync(config, first.cursor);
      expect(second.stats.unchanged).toBe(1);
      expect(second.stats.new).toBe(0);
      expect(second.upserted).toHaveLength(0);

      const { rmSync } = await import('fs');
      rmSync(tmpDir, { recursive: true });
    });

    it('detects deleted files', async () => {
      const { mkdtempSync, writeFileSync, unlinkSync } = await import('fs');
      const { join } = await import('path');
      const tmpDir = mkdtempSync('/tmp/conduit-test-');

      writeFileSync(join(tmpDir, 'temp.md'), '# Temporary\n\nWill be deleted.');

      const config: ConnectorConfig = {
        type: 'filesystem',
        name: 'test',
        organizationId: 'org_test',
        settings: { path: tmpDir },
      };

      const first = await connector.sync(config);
      expect(first.stats.new).toBe(1);

      // Delete the file
      unlinkSync(join(tmpDir, 'temp.md'));

      const second = await connector.sync(config, first.cursor);
      expect(second.deleted).toContain('temp.md');
      expect(second.stats.deleted).toBe(1);

      const { rmSync } = await import('fs');
      rmSync(tmpDir, { recursive: true });
    });

    it('detects modified files', async () => {
      const { mkdtempSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const tmpDir = mkdtempSync('/tmp/conduit-test-');

      writeFileSync(join(tmpDir, 'doc.md'), '# Version 1\n\nOriginal content.');

      const config: ConnectorConfig = {
        type: 'filesystem',
        name: 'test',
        organizationId: 'org_test',
        settings: { path: tmpDir },
      };

      const first = await connector.sync(config);

      // Modify the file
      writeFileSync(join(tmpDir, 'doc.md'), '# Version 2\n\nUpdated content.');

      const second = await connector.sync(config, first.cursor);
      expect(second.stats.updated).toBe(1);
      expect(second.upserted[0].title).toBe('Version 2');

      const { rmSync } = await import('fs');
      rmSync(tmpDir, { recursive: true });
    });
  });
});

// ─── GitHub Connector Tests ───────────────────────────────────────────

describe('GitHubConnector', () => {
  const connector = new GitHubConnector();

  describe('validate', () => {
    it('rejects missing token', () => {
      const config: ConnectorConfig = {
        type: 'github',
        name: 'test',
        organizationId: 'org_test',
        settings: { owner: 'datakailabs', repo: 'conduit' },
      };
      expect(connector.validate(config)).toContain('settings.token is required');
    });

    it('rejects missing owner', () => {
      const config: ConnectorConfig = {
        type: 'github',
        name: 'test',
        organizationId: 'org_test',
        settings: { token: 'ghp_test', repo: 'conduit' },
      };
      expect(connector.validate(config)).toContain('settings.owner is required');
    });

    it('rejects missing repo', () => {
      const config: ConnectorConfig = {
        type: 'github',
        name: 'test',
        organizationId: 'org_test',
        settings: { token: 'ghp_test', owner: 'datakailabs' },
      };
      expect(connector.validate(config)).toContain('settings.repo is required');
    });

    it('accepts valid config', () => {
      const config: ConnectorConfig = {
        type: 'github',
        name: 'test',
        organizationId: 'org_test',
        settings: { token: 'ghp_test', owner: 'datakailabs', repo: 'conduit' },
      };
      expect(connector.validate(config)).toBeNull();
    });
  });

  describe('discover (mocked)', () => {
    it('calls GitHub API and filters for supported files', async () => {
      // Mock fetch for GitHub API calls
      const mockTree = {
        tree: [
          { path: 'README.md', type: 'blob', sha: 'abc', size: 500 },
          { path: 'docs/guide.md', type: 'blob', sha: 'def', size: 1200 },
          { path: 'src/index.ts', type: 'blob', sha: 'ghi', size: 800 },
          { path: 'docs/images', type: 'tree', sha: 'jkl' },
          { path: 'package.json', type: 'blob', sha: 'mno', size: 300 },
          { path: 'dist/bundle.js', type: 'blob', sha: 'pqr', size: 50000 },
        ],
        truncated: false,
      };

      const originalFetch = global.fetch;
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ default_branch: 'main' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ object: { sha: 'commit123' } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tree: { sha: 'tree123' } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockTree) }) as any;

      const config: ConnectorConfig = {
        type: 'github',
        name: 'test-repo',
        organizationId: 'org_test',
        settings: { token: 'ghp_test', owner: 'datakailabs', repo: 'conduit' },
      };

      const results = await connector.discover(config);

      // Should find README.md and docs/guide.md (default patterns match these)
      // src/index.ts should be excluded (not in default include patterns)
      expect(results.some(r => r.sourceId === 'README.md')).toBe(true);
      expect(results.some(r => r.sourceId === 'docs/guide.md')).toBe(true);
      expect(results.some(r => r.sourceId === 'src/index.ts')).toBe(false);

      global.fetch = originalFetch;
    });
  });

  describe('sync (mocked)', () => {
    it('returns empty result when no new commits', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ default_branch: 'main' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ object: { sha: 'same123' } }) }) as any;

      const config: ConnectorConfig = {
        type: 'github',
        name: 'test-repo',
        organizationId: 'org_test',
        settings: { token: 'ghp_test', owner: 'datakailabs', repo: 'conduit' },
      };

      const cursor = {
        connectorType: 'github',
        sourceId: 'datakailabs/conduit',
        lastSyncAt: '2026-03-09T00:00:00Z',
        state: { commitSHA: 'same123', hashes: { 'README.md': 'abc123' } },
      };

      const result = await connector.sync(config, cursor);

      expect(result.upserted).toHaveLength(0);
      expect(result.deleted).toHaveLength(0);
      expect(result.stats.unchanged).toBe(1);

      global.fetch = originalFetch;
    });

    it('detects deleted files via Compare API', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ default_branch: 'main' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ object: { sha: 'new456' } }) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            files: [
              { filename: 'old-doc.md', status: 'removed', sha: 'xxx' },
            ],
            total_commits: 1,
          }),
        }) as any;

      const config: ConnectorConfig = {
        type: 'github',
        name: 'test-repo',
        organizationId: 'org_test',
        settings: { token: 'ghp_test', owner: 'datakailabs', repo: 'conduit' },
      };

      const cursor = {
        connectorType: 'github',
        sourceId: 'datakailabs/conduit',
        lastSyncAt: '2026-03-09T00:00:00Z',
        state: { commitSHA: 'old123', hashes: { 'old-doc.md': 'hash123' } },
      };

      const result = await connector.sync(config, cursor);

      expect(result.deleted).toContain('old-doc.md');
      expect(result.stats.deleted).toBe(1);

      global.fetch = originalFetch;
    });
  });
});

// ─── PostgreSQL Connector Tests ───────────────────────────────────────

describe('PostgreSQLConnector', () => {
  const connector = new PostgreSQLConnector();

  describe('validate', () => {
    it('rejects missing connectionString', () => {
      const config: ConnectorConfig = {
        type: 'postgresql',
        name: 'test',
        organizationId: 'org_test',
        settings: { query: 'SELECT 1', columns: { id: 'id', title: 'title', content: 'body' } },
      };
      expect(connector.validate(config)).toContain('settings.connectionString is required');
    });

    it('rejects missing query', () => {
      const config: ConnectorConfig = {
        type: 'postgresql',
        name: 'test',
        organizationId: 'org_test',
        settings: {
          connectionString: 'postgresql://localhost/test',
          columns: { id: 'id', title: 'title', content: 'body' },
        },
      };
      expect(connector.validate(config)).toContain('settings.query is required');
    });

    it('rejects non-SELECT queries', () => {
      const config: ConnectorConfig = {
        type: 'postgresql',
        name: 'test',
        organizationId: 'org_test',
        settings: {
          connectionString: 'postgresql://localhost/test',
          query: 'DROP TABLE users',
          columns: { id: 'id', title: 'title', content: 'body' },
        },
      };
      expect(connector.validate(config)).toContain('must be a SELECT statement');
    });

    it('rejects missing columns', () => {
      const config: ConnectorConfig = {
        type: 'postgresql',
        name: 'test',
        organizationId: 'org_test',
        settings: {
          connectionString: 'postgresql://localhost/test',
          query: 'SELECT * FROM docs',
        },
      };
      expect(connector.validate(config)).toContain('settings.columns is required');
    });

    it('rejects missing id column', () => {
      const config: ConnectorConfig = {
        type: 'postgresql',
        name: 'test',
        organizationId: 'org_test',
        settings: {
          connectionString: 'postgresql://localhost/test',
          query: 'SELECT * FROM docs',
          columns: { title: 'title', content: 'body' },
        },
      };
      expect(connector.validate(config)).toContain('settings.columns.id is required');
    });

    it('accepts valid config', () => {
      const config: ConnectorConfig = {
        type: 'postgresql',
        name: 'test',
        organizationId: 'org_test',
        settings: {
          connectionString: 'postgresql://localhost/test',
          query: 'SELECT id, title, body FROM articles',
          columns: { id: 'id', title: 'title', content: 'body' },
        },
      };
      expect(connector.validate(config)).toBeNull();
    });
  });
});
