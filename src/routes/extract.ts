import { Router } from 'express';
import { z } from 'zod';
import { ExtractorService } from '../services/extractor.js';
import type { UsageMeter } from '../middleware/usage.js';
import { createLogger } from '../lib/logger.js';
import { graphRAGService } from '../services/graphrag.js';

const log = createLogger('extract');

const provenanceSchema = z.object({
  type: z.enum(['url', 'pdf', 'database', 'file', 'api']),
  url: z.string().optional(),
  page: z.number().int().optional(),
  pageRange: z.string().optional(),
  query: z.string().optional(),
  table: z.string().optional(),
  path: z.string().optional(),
  endpoint: z.string().optional(),
  adapter: z.string().optional(),
  fetchedAt: z.string().optional(),
  title: z.string().optional(),
}).optional();

const extractSchema = z.object({
  text: z.string().min(100).max(200_000),
  contextSource: z.enum(['experience', 'research', 'discussion', 'article', 'vendor-doc', 'project']).default('experience'),
  domainHints: z.array(z.string()).max(5).default([]),
  maxUnits: z.number().int().min(1).max(50).default(20),
  dryRun: z.boolean().default(false),
  sourceUrl: z.string().url().optional(),
  provenance: provenanceSchema,
});

export function createExtractRouter(usageMeter: UsageMeter): Router {
  const router = Router();
  const extractor = new ExtractorService();

  router.post('/', async (req, res) => {
    try {
      const body = extractSchema.parse(req.body);
      const orgId = req.tenant!.organizationId;

      const result = await extractor.extract(orgId, body.text, {
        contextSource: body.contextSource,
        domainHints: body.domainHints,
        maxUnits: body.maxUnits,
        ingest: !body.dryRun,
        sourceUrl: body.sourceUrl,
        provenance: body.provenance,
      });

      // Invalidate query cache after new knowledge ingested
      if (!body.dryRun && result.novel > 0) {
        graphRAGService.invalidateCache(orgId);
      }

      // Record usage as 'ingest' event with extraction metadata
      usageMeter.record(orgId, 'ingest', {
        source: 'extraction',
        extracted: result.extracted,
        novel: result.novel,
        duplicates: result.duplicates,
        dryRun: body.dryRun,
      });

      res.json({
        ...result,
        dryRun: body.dryRun,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Extraction failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
