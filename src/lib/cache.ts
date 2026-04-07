/**
 * LRU Query Cache — In-memory cache with TTL and size limits.
 *
 * Caches GraphRAG retrieval results to avoid repeated embedding + vector
 * search + graph traversal for identical queries. For multi-instance
 * deployments, replace with Valkey (Redis-compatible) backend.
 *
 * Cache key: orgId:normalizedQuery:limit
 * Default: 256 entries, 5 minute TTL
 */

// ─── Types ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  key: string;
}

interface CacheConfig {
  /** Maximum entries before LRU eviction */
  maxSize: number;
  /** TTL in milliseconds */
  ttlMs: number;
  /** Name for logging */
  name: string;
}

// ─── LRU Cache ───────────────────────────────────────────────────────

export class LRUCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  private config: CacheConfig;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      maxSize: config.maxSize ?? 256,
      ttlMs: config.ttlMs ?? 5 * 60 * 1000, // 5 minutes
      name: config.name ?? 'cache',
    };
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }

    // Move to end (most recently used)
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;

    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete existing to update position
    this.entries.delete(key);

    // Evict oldest if at capacity
    if (this.entries.size >= this.config.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.evictions++;
      }
    }

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.config.ttlMs,
      key,
    });
  }

  /** Invalidate entries matching a prefix (e.g., orgId) */
  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        count++;
      }
    }
    if (count > 0) {
      // Debug logging omitted to avoid config dependency in test environments
    }
    return count;
  }

  /** Clear all entries */
  clear(): void {
    const size = this.entries.size;
    this.entries.clear();
    if (size > 0) {
    }
  }

  /** Stats for monitoring */
  getStats(): { size: number; maxSize: number; hits: number; misses: number; evictions: number; hitRate: string } {
    const total = this.hits + this.misses;
    return {
      size: this.entries.size,
      maxSize: this.config.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0 ? (this.hits / total * 100).toFixed(1) + '%' : '0%',
    };
  }
}

// ─── Cache Key Builder ──────────────────────────────────────────────

/**
 * Normalize query for cache key: lowercase, collapse whitespace, trim.
 * "What is  Snowflake?" and "what is snowflake?" → same key.
 */
export function buildCacheKey(orgId: string, query: string, limit: number): string {
  const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${orgId}:${normalized}:${limit}`;
}
