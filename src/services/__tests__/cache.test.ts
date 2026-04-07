import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LRUCache, buildCacheKey } from '../../lib/cache.js';

describe('LRUCache', () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    cache = new LRUCache<string>({ maxSize: 3, ttlMs: 1000, name: 'test' });
  });

  it('stores and retrieves values', () => {
    cache.set('a', 'hello');
    expect(cache.get('a')).toBe('hello');
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts oldest entry when at capacity', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    cache.set('d', '4'); // should evict 'a'

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('d')).toBe('4');
  });

  it('refreshes LRU position on access', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');

    // Access 'a' to make it most recent
    cache.get('a');

    cache.set('d', '4'); // should evict 'b' (oldest untouched)

    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    cache.set('a', 'hello');

    expect(cache.get('a')).toBe('hello');

    vi.advanceTimersByTime(1100); // past 1000ms TTL

    expect(cache.get('a')).toBeUndefined();
    vi.useRealTimers();
  });

  it('invalidates entries by prefix', () => {
    cache.set('org1:query1:5', 'r1');
    cache.set('org1:query2:5', 'r2');
    cache.set('org2:query1:5', 'r3');

    const count = cache.invalidatePrefix('org1:');
    expect(count).toBe(2);
    expect(cache.get('org1:query1:5')).toBeUndefined();
    expect(cache.get('org2:query1:5')).toBe('r3');
  });

  it('clears all entries', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.getStats().size).toBe(0);
  });

  it('tracks hit/miss stats', () => {
    cache.set('a', '1');
    cache.get('a');     // hit
    cache.get('a');     // hit
    cache.get('miss');  // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe('66.7%');
  });
});

describe('buildCacheKey', () => {
  it('normalizes query case and whitespace', () => {
    const k1 = buildCacheKey('org1', 'What is  Snowflake?', 8);
    const k2 = buildCacheKey('org1', 'what is snowflake?', 8);
    expect(k1).toBe(k2);
  });

  it('differentiates by org and limit', () => {
    const k1 = buildCacheKey('org1', 'query', 5);
    const k2 = buildCacheKey('org2', 'query', 5);
    const k3 = buildCacheKey('org1', 'query', 10);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });
});
