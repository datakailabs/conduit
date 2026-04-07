/**
 * Request Logging Middleware — Structured HTTP access logs.
 *
 * Logs every request with method, path, status, duration, and tenant context.
 * In production, outputs JSON for log aggregation (ELK, Datadog, etc.).
 */

import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../lib/logger.js';

const log = createLogger('http');

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  // Log after response completes
  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs / 1_000_000n);

    // Skip health checks and static assets from logs
    if (req.path === '/health' || req.path === '/ready' || req.path === '/metrics' || req.path.startsWith('/static')) {
      return;
    }

    const entry = {
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      durationMs,
      ...(req.tenant ? { org: req.tenant.organizationId, keyId: req.tenant.keyId } : {}),
      contentLength: res.getHeader('content-length'),
    };

    if (res.statusCode >= 500) {
      log.error('request failed', entry);
    } else if (res.statusCode >= 400) {
      log.warn('request error', entry);
    } else {
      log.info('request', entry);
    }
  });

  next();
}
