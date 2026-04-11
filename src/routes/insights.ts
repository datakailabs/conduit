import { Router } from 'express';
import { z } from 'zod';
import type { InsightsService } from '../services/insights.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('insights');

const insightsSchema = z.object({
  count: z.number().int().min(1).max(10).default(3),
  domains: z.array(z.string()).optional(),
  previousTheses: z.array(z.string()).optional(),
});

export function createInsightsRouter(insightsService: InsightsService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const body = insightsSchema.parse(req.body);
      const orgId = req.tenant!.organizationId;

      const insights = await insightsService.generate(orgId, {
        count: body.count,
        domains: body.domains,
        previousTheses: body.previousTheses,
      });

      res.json({
        insights,
        count: insights.length,
        domains: body.domains || 'all',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Insight generation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
