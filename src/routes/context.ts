import { Router } from 'express';
import { z } from 'zod';
import { graphRAGService } from '../services/graphrag.js';
import type { UsageMeter } from '../middleware/usage.js';
import type { RankedResult } from '../services/graphrag.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('context');

const contextSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(50).default(10),
  format: z.enum(['markdown', 'json']).default('markdown'),
});

export function createContextRouter(usageMeter: UsageMeter): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const body = contextSchema.parse(req.body);
      const orgId = req.tenant!.organizationId;

      // GraphRAG retrieval (with neighbor relationships for richer context)
      const retrieval = await graphRAGService.retrieve(orgId, body.query, body.limit, {
        fetchNeighborRelationships: true,
      });

      if (retrieval.results.length === 0) {
        const empty = body.format === 'markdown'
          ? { format: 'markdown', query: body.query, context: `No relevant knowledge found for: "${body.query}"`, resultCount: 0, retrieval: retrieval.stats }
          : { format: 'json', query: body.query, results: [], resultCount: 0, retrieval: retrieval.stats };
        usageMeter.record(orgId, 'context', { query: body.query, resultCount: 0, format: body.format });
        res.json(empty);
        return;
      }

      // Record usage
      usageMeter.record(orgId, 'context', {
        query: body.query,
        resultCount: retrieval.results.length,
        ...retrieval.stats,
        format: body.format,
      });

      // Format response
      if (body.format === 'markdown') {
        const markdown = formatAsMarkdown(body.query, retrieval.results);
        res.json({
          format: 'markdown', query: body.query, context: markdown,
          resultCount: retrieval.results.length, retrieval: retrieval.stats,
        });
      } else {
        res.json({
          format: 'json', query: body.query, results: retrieval.results,
          resultCount: retrieval.results.length, retrieval: retrieval.stats,
        });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Context query failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

function formatAsMarkdown(query: string, results: RankedResult[]): string {
  if (results.length === 0) {
    return `No relevant knowledge found for: "${query}"`;
  }

  const sections = results.map((r) => {
    let section = `## ${r.title}`;
    if (r.path === 'graph-edge') {
      section += ' *(discovered via graph edge)*';
    } else if (r.path === 'graph-topic') {
      section += ' *(discovered via shared topics)*';
    }
    section += `\n\n${r.content}`;

    if (r.relationships.length > 0) {
      section += '\n\n**Connections:**\n';
      section += r.relationships
        .map((rel) => `- ${rel.type} → ${rel.targetTitle}`)
        .join('\n');
    }

    if (r.domains.length > 0) {
      section += `\n\n*Domains: ${r.domains.join(', ')}*`;
    }

    return section;
  });

  // Knowledge graph topology section
  const resultIds = new Set(results.map((r) => r.zettelId));
  const topology: string[] = [];
  for (const r of results) {
    for (const rel of r.relationships) {
      if (resultIds.has(rel.targetId)) {
        topology.push(`- **${r.title}** —[${rel.type}]→ **${rel.targetTitle}**`);
      }
    }
  }

  let markdown = `# Knowledge Context\n\nQuery: "${query}"\n\n`;
  if (topology.length > 0) {
    markdown += `## Knowledge Graph Topology\n\n${topology.join('\n')}\n\n---\n\n`;
  }
  markdown += sections.join('\n\n---\n\n');

  return markdown;
}
