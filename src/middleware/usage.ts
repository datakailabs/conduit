import type { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

export type EventType = 'search' | 'ingest' | 'delete' | 'context' | 'ask' | 'concept_match' | 'concept_match_batch';

export class UsageMeter {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Record a usage event. Fire-and-forget (doesn't block the response).
   */
  record(
    organizationId: string,
    eventType: EventType,
    metadata: Record<string, unknown> = {}
  ): void {
    this.pool
      .query(
        `INSERT INTO usage_events (organization_id, event_type, metadata)
         VALUES ($1, $2, $3)`,
        [organizationId, eventType, JSON.stringify(metadata)]
      )
      .catch(() => {
        // Silently ignore — non-critical metering
      });
  }

  /**
   * Get usage stats for an organization.
   */
  async getUsageStats(
    organizationId: string
  ): Promise<{ total: number; byType: Record<string, number> }> {
    const result = await this.pool.query(
      `SELECT event_type, COUNT(*)::int as count
       FROM usage_events
       WHERE organization_id = $1
       GROUP BY event_type`,
      [organizationId]
    );

    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows) {
      byType[row.event_type] = row.count;
      total += row.count;
    }

    return { total, byType };
  }

  /**
   * Get usage over time (daily buckets).
   */
  async getUsageOverTime(
    organizationId: string,
    days: number = 30
  ): Promise<Array<{ date: string; eventType: string; count: number }>> {
    const result = await this.pool.query(
      `SELECT
         DATE(created_at) as date,
         event_type,
         COUNT(*)::int as count
       FROM usage_events
       WHERE organization_id = $1
         AND created_at >= NOW() - INTERVAL '1 day' * $2
       GROUP BY DATE(created_at), event_type
       ORDER BY date DESC, event_type`,
      [organizationId, days]
    );

    return result.rows.map((row) => ({
      date: row.date.toISOString().split('T')[0],
      eventType: row.event_type,
      count: row.count,
    }));
  }

  /**
   * Get recent queries (search + context events).
   */
  async getRecentQueries(
    organizationId: string,
    limit: number = 20
  ): Promise<
    Array<{ eventType: string; metadata: Record<string, unknown>; createdAt: string }>
  > {
    const result = await this.pool.query(
      `SELECT event_type, metadata, created_at
       FROM usage_events
       WHERE organization_id = $1
         AND event_type IN ('search', 'context')
       ORDER BY created_at DESC
       LIMIT $2`,
      [organizationId, limit]
    );

    return result.rows.map((row) => ({
      eventType: row.event_type,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

/**
 * Middleware factory that records usage events after response completes.
 */
export function createUsageMiddleware(meter: UsageMeter, eventType: EventType) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.tenant) {
      meter.record(req.tenant.organizationId, eventType, {
        path: req.path,
        method: req.method,
      });
    }
    next();
  };
}
