import { Router } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { IngestionService } from '../services/ingestion.js';
import { ConnectorManager } from '../services/connectors/index.js';
import type { SyncCursor } from '../types/connector.js';
import type { UsageMeter } from '../middleware/usage.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('connectors');

// ─── Validation Schemas ──────────────────────────────────────────────

const connectorConfigSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  settings: z.record(z.unknown()),
  domainHints: z.array(z.string()).max(10).optional(),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
});

const syncCursorSchema = z.object({
  connectorType: z.string(),
  sourceId: z.string(),
  lastSyncAt: z.string(),
  state: z.record(z.unknown()),
}).optional();

const syncRequestSchema = z.object({
  connector: connectorConfigSchema,
  cursor: syncCursorSchema,
});

const discoverRequestSchema = z.object({
  connector: connectorConfigSchema,
});

// ─── Router ──────────────────────────────────────────────────────────

export function createConnectorsRouter(usageMeter: UsageMeter, pool: Pool): Router {
  const router = Router();
  const ingestion = new IngestionService();
  const manager = new ConnectorManager(ingestion);

  /**
   * GET /api/v1/connectors/types
   * List available connector types
   */
  router.get('/types', (_req, res) => {
    res.json({ connectors: manager.listTypes() });
  });

  /**
   * POST /api/v1/connectors/discover
   * Discover available content in a source without syncing
   */
  router.post('/discover', async (req, res) => {
    try {
      const body = discoverRequestSchema.parse(req.body);
      const orgId = req.tenant!.organizationId;

      const connector = manager.get(body.connector.type);
      if (!connector) {
        res.status(400).json({
          error: `Unknown connector type: ${body.connector.type}`,
          available: manager.listTypes().map(t => t.type),
        });
        return;
      }

      const config = { ...body.connector, organizationId: orgId };

      const validationError = connector.validate(config);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const items = await connector.discover(config);

      res.json({
        type: body.connector.type,
        name: body.connector.name,
        items,
        total: items.length,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Connector discover failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/v1/connectors/sync
   * Run a sync cycle: fetch new/changed content, ingest it, detect deletions
   */
  router.post('/sync', (req, res, next) => {
    // Large repos can take several minutes to sync — extend timeout to 10 min
    req.setTimeout(600000);
    res.setTimeout(600000);
    next();
  }, async (req, res) => {
    const startedAt = new Date();
    try {
      const body = syncRequestSchema.parse(req.body);
      const orgId = req.tenant!.organizationId;
      const config = { ...body.connector, organizationId: orgId };

      const result = await manager.syncAndIngest(config, body.cursor as SyncCursor | undefined);

      // Record usage
      usageMeter.record(orgId, 'ingest', {
        source: 'connector',
        connectorType: body.connector.type,
        connectorName: body.connector.name,
        ...result.summary,
      });

      // Record sync history
      const durationMs = Date.now() - startedAt.getTime();
      const stats = result.sync.stats;
      const status = stats.errors > 0 && stats.new + stats.updated === 0 ? 'failed'
        : stats.errors > 0 ? 'partial' : 'success';
      pool.query(
        `INSERT INTO sync_history
         (organization_id, connector_type, connector_name, status,
          docs_discovered, docs_new, docs_updated, docs_deleted, docs_unchanged, docs_failed,
          duration_ms, cursor_state, error_summary, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [orgId, body.connector.type, body.connector.name, status,
         stats.discovered, stats.new, stats.updated, stats.deleted, stats.unchanged, stats.errors,
         durationMs, JSON.stringify(result.sync.cursor),
         result.sync.errors.length > 0 ? result.sync.errors.slice(0, 5).map(e => `${e.sourceId}: ${e.error}`).join('; ') : null,
         startedAt]
      ).catch(() => { /* non-critical */ });

      res.json({
        summary: result.summary,
        cursor: result.sync.cursor,
        stats: result.sync.stats,
        errors: result.sync.errors,
        ingestion: result.ingestion.map(i => ({
          sourceId: i.sourceId,
          zettelId: i.zettelId,
          success: i.result.success,
          chunksCreated: i.result.chunksCreated,
          error: i.result.error,
        })),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      if (error instanceof Error && error.message.startsWith('Invalid connector config:')) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof Error && error.message.startsWith('Unknown connector type:')) {
        res.status(400).json({ error: error.message });
        return;
      }
      log.error('Connector sync failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/v1/connectors/history
   * Get sync history for the organization
   */
  router.get('/history', async (req, res) => {
    try {
      const orgId = req.tenant!.organizationId;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const connectorName = req.query.name as string | undefined;

      let query = `SELECT * FROM sync_history WHERE organization_id = $1`;
      const params: unknown[] = [orgId];

      if (connectorName) {
        query += ` AND connector_name = $2`;
        params.push(connectorName);
      }

      query += ` ORDER BY completed_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await pool.query(query, params);
      res.json({
        history: result.rows.map(row => ({
          id: row.id,
          connectorType: row.connector_type,
          connectorName: row.connector_name,
          status: row.status,
          stats: {
            discovered: row.docs_discovered,
            new: row.docs_new,
            updated: row.docs_updated,
            deleted: row.docs_deleted,
            unchanged: row.docs_unchanged,
            failed: row.docs_failed,
          },
          durationMs: row.duration_ms,
          errorSummary: row.error_summary,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        })),
        total: result.rows.length,
      });
    } catch (error) {
      log.error('Sync history query failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
