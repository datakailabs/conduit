/**
 * Rate Limiter — Sliding window per API key with configurable limits.
 *
 * Uses in-memory storage with automatic cleanup. For multi-instance deployments,
 * replace the in-memory store with a shared backend (Valkey/Redis).
 *
 * Rate limits apply after authentication (uses req.tenant.keyId).
 * Unauthenticated routes (health, auth) are not rate-limited.
 */

import type { Request, Response, NextFunction } from 'express';

// ─── Types ──────────────────────────────────────────────────────────

interface RateLimitConfig {
  /** Maximum requests in the window */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
}

interface BucketEntry {
  /** Timestamps of requests within the current window */
  timestamps: number[];
  /** Last time this bucket was accessed (for cleanup) */
  lastAccess: number;
}

// ─── Default Limits ─────────────────────────────────────────────────

/** Rate limits per endpoint category, per API key */
const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  // High-cost endpoints (LLM calls)
  ask:      { limit: 30,  windowMs: 60_000 },  // 30/min
  extract:  { limit: 20,  windowMs: 60_000 },  // 20/min

  // Medium-cost endpoints (DB + embedding queries)
  context:  { limit: 60,  windowMs: 60_000 },  // 60/min
  concepts: { limit: 60,  windowMs: 60_000 },  // 60/min
  zettels:  { limit: 120, windowMs: 60_000 },  // 120/min

  // Low-cost endpoints
  connectors: { limit: 10, windowMs: 60_000 },  // 10/min (syncs are heavy)
  dashboard:  { limit: 60, windowMs: 60_000 },  // 60/min

  // Default for unmatched routes
  default: { limit: 120, windowMs: 60_000 },    // 120/min
};

// ─── Sliding Window Store ───────────────────────────────────────────

class RateLimitStore {
  /** Map of "keyId:category" → bucket */
  private buckets = new Map<string, BucketEntry>();

  /** Interval handle for cleanup */
  private cleanupInterval: ReturnType<typeof setInterval>;

  /** Max age before bucket is cleaned up (2x longest window) */
  private maxIdleMs = 120_000;

  constructor() {
    // Clean up stale buckets every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    // Allow Node to exit without waiting for this timer
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  /**
   * Record a request and check if it's within limits.
   * Returns { allowed, remaining, resetMs }.
   */
  check(key: string, config: RateLimitConfig): {
    allowed: boolean;
    remaining: number;
    resetMs: number;
    total: number;
  } {
    const now = Date.now();
    const windowStart = now - config.windowMs;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [], lastAccess: now };
      this.buckets.set(key, bucket);
    }

    // Prune timestamps outside the window
    bucket.timestamps = bucket.timestamps.filter(t => t > windowStart);
    bucket.lastAccess = now;

    const count = bucket.timestamps.length;

    if (count >= config.limit) {
      // Find when the oldest request in window expires
      const oldestInWindow = bucket.timestamps[0];
      const resetMs = oldestInWindow + config.windowMs - now;
      return {
        allowed: false,
        remaining: 0,
        resetMs: Math.max(resetMs, 0),
        total: config.limit,
      };
    }

    // Allow and record
    bucket.timestamps.push(now);
    return {
      allowed: true,
      remaining: config.limit - count - 1,
      resetMs: config.windowMs,
      total: config.limit,
    };
  }

  /** Remove stale buckets */
  private cleanup(): void {
    const cutoff = Date.now() - this.maxIdleMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastAccess < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  /** For monitoring: number of tracked keys */
  get size(): number {
    return this.buckets.size;
  }

  /** Shutdown cleanup timer */
  close(): void {
    clearInterval(this.cleanupInterval);
  }
}

// ─── Singleton Store ────────────────────────────────────────────────

const store = new RateLimitStore();

// ─── Route Category Detection ───────────────────────────────────────

function getCategory(req: Request): string {
  // Use originalUrl (preserves full path even when mounted as sub-router)
  const url = req.originalUrl || req.path;
  const match = url.match(/^\/api\/v1\/(\w+)/);
  if (!match) return 'default';

  const segment = match[1];
  if (segment in DEFAULT_LIMITS) return segment;
  return 'default';
}

// ─── Middleware ──────────────────────────────────────────────────────

/**
 * Create rate limiting middleware.
 * Must be applied AFTER auth middleware (needs req.tenant).
 *
 * @param overrides - Override default limits for specific categories
 */
export function createRateLimiter(
  overrides: Partial<Record<string, RateLimitConfig>> = {}
) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip if no tenant (unauthenticated routes handle their own protection)
    if (!req.tenant) {
      next();
      return;
    }

    const category = getCategory(req);
    const config = limits[category] ?? DEFAULT_LIMITS.default;
    const bucketKey = `${req.tenant.keyId}:${category}`;

    const result = store.check(bucketKey, config);

    // Always set rate limit headers (RFC 6585 / draft-ietf-httpapi-ratelimit-headers)
    res.setHeader('RateLimit-Limit', result.total);
    res.setHeader('RateLimit-Remaining', result.remaining);
    res.setHeader('RateLimit-Reset', Math.ceil(result.resetMs / 1000));

    if (!result.allowed) {
      res.setHeader('Retry-After', Math.ceil(result.resetMs / 1000));
      res.status(429).json({
        error: 'Rate limit exceeded',
        limit: result.total,
        remaining: 0,
        retryAfterSeconds: Math.ceil(result.resetMs / 1000),
      });
      return;
    }

    next();
  };
}

/** Get the store instance (for monitoring/testing) */
export function getRateLimitStore(): RateLimitStore {
  return store;
}
