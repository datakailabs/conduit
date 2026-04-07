import { Router } from 'express';
import { z } from 'zod';
import { postgres } from '../clients/postgres.js';
import { arangoClient } from '../clients/arango/index.js';
import type { UsageMeter } from '../middleware/usage.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('dashboard');

const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function createDashboardRouter(usageMeter: UsageMeter): Router {
  const router = Router();

  // GET /stats — Org-scoped stats summary
  router.get('/stats', async (req, res) => {
    try {
      const orgId = req.tenant!.organizationId;

      const [pgStats, graphStats, usage] = await Promise.all([
        postgres.getStats(orgId),
        arangoClient.getStats(orgId),
        usageMeter.getUsageStats(orgId),
      ]);

      res.json({
        knowledge: {
          totalZettels: graphStats.totalZettels,
          totalChunks: pgStats.totalChunks,
          totalRelationships: graphStats.totalRelationships,
          embeddingDimensions: pgStats.dimensions,
        },
        usage: {
          totalEvents: usage.total,
          byType: usage.byType,
        },
      });
    } catch (error) {
      log.error('Failed to get stats', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /usage — Daily usage buckets
  router.get('/usage', async (req, res) => {
    try {
      const { days } = usageQuerySchema.parse(req.query);
      const orgId = req.tenant!.organizationId;

      const usage = await usageMeter.getUsageOverTime(orgId, days);
      res.json({ days, usage });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Failed to get usage', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /recent-queries — Last N search/context queries
  router.get('/recent-queries', async (req, res) => {
    try {
      const { limit } = recentQuerySchema.parse(req.query);
      const orgId = req.tenant!.organizationId;

      const queries = await usageMeter.getRecentQueries(orgId, limit);
      res.json({ queries });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Failed to get recent queries', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
