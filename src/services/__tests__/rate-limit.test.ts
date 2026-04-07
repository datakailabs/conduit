import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createRateLimiter } from '../../middleware/rate-limit.js';

function createNext() {
  return vi.fn() as unknown as ReturnType<typeof vi.fn>;
}

let testCounter = 0;

function mockReq(path: string, keyId?: string): Partial<Request> {
  const key = keyId ?? `key_test_${testCounter}`;
  return {
    path,
    originalUrl: path,
    tenant: { organizationId: 'org_test', keyId: key, keyType: 'api' as const, scope: 'admin' as const },
  };
}

function mockRes(): Partial<Response> & { _status: number; _json: unknown; _headers: Record<string, unknown> } {
  const res = {
    _status: 200,
    _json: null as unknown,
    _headers: {} as Record<string, unknown>,
    status(code: number) { res._status = code; return res; },
    json(data: unknown) { res._json = data; return res; },
    setHeader(name: string, value: unknown) { res._headers[name] = value; },
  } as unknown as Partial<Response> & { _status: number; _json: unknown; _headers: Record<string, unknown> };
  return res;
}

describe('Rate Limiter', () => {
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeEach(() => {
    testCounter++;
    // Create with very low limits for testing
    limiter = createRateLimiter({
      ask: { limit: 3, windowMs: 60_000 },
      default: { limit: 5, windowMs: 60_000 },
    });
  });

  it('allows requests under the limit', () => {
    const req = mockReq('/api/v1/ask');
    const res = mockRes();
    const next = createNext();

    limiter(req as Request, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res._headers['RateLimit-Remaining']).toBe(2);
  });

  it('blocks requests over the limit', () => {
    const next = createNext();

    // Use up the limit (3 for ask)
    for (let i = 0; i < 3; i++) {
      const req = mockReq('/api/v1/ask');
      const res = mockRes();
      limiter(req as Request, res as unknown as Response, next);
    }
    expect(next).toHaveBeenCalledTimes(3);

    // 4th request should be blocked
    const req = mockReq('/api/v1/ask');
    const res = mockRes();
    const blockedNext = createNext();
    limiter(req as Request, res as unknown as Response, blockedNext);

    expect(blockedNext).not.toHaveBeenCalled();
    expect(res._status).toBe(429);
    expect((res._json as { error: string }).error).toBe('Rate limit exceeded');
  });

  it('sets rate limit headers on every response', () => {
    const req = mockReq('/api/v1/context');
    const res = mockRes();
    const next = createNext();

    limiter(req as Request, res as unknown as Response, next);

    expect(res._headers['RateLimit-Limit']).toBeDefined();
    expect(res._headers['RateLimit-Remaining']).toBeDefined();
    expect(res._headers['RateLimit-Reset']).toBeDefined();
  });

  it('sets Retry-After header on 429 responses', () => {
    const next = createNext();

    for (let i = 0; i < 3; i++) {
      limiter(mockReq('/api/v1/ask') as Request, mockRes() as unknown as Response, next);
    }

    const res = mockRes();
    limiter(mockReq('/api/v1/ask') as Request, res as unknown as Response, createNext());

    expect(res._status).toBe(429);
    expect(res._headers['Retry-After']).toBeDefined();
    expect(typeof res._headers['Retry-After']).toBe('number');
  });

  it('isolates limits per API key', () => {
    const next = createNext();

    // Exhaust limit for key_a
    for (let i = 0; i < 3; i++) {
      limiter(mockReq('/api/v1/ask', 'key_a') as Request, mockRes() as unknown as Response, next);
    }

    // key_b should still be allowed
    const res = mockRes();
    const nextB = createNext();
    limiter(mockReq('/api/v1/ask', 'key_b') as Request, res as unknown as Response, nextB);
    expect(nextB).toHaveBeenCalled();
  });

  it('isolates limits per endpoint category', () => {
    const next = createNext();

    // Exhaust ask limit (3)
    for (let i = 0; i < 3; i++) {
      limiter(mockReq('/api/v1/ask') as Request, mockRes() as unknown as Response, next);
    }

    // Context should still work (different category)
    const nextCtx = createNext();
    limiter(mockReq('/api/v1/context') as Request, mockRes() as unknown as Response, nextCtx);
    expect(nextCtx).toHaveBeenCalled();
  });

  it('skips rate limiting for unauthenticated requests', () => {
    const req = { path: '/api/v1/something' } as Request;  // no tenant
    const res = mockRes();
    const next = createNext();

    limiter(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('uses default limit for unknown routes', () => {
    const req = mockReq('/api/v1/unknown');
    const res = mockRes();
    const next = createNext();

    limiter(req as Request, res as unknown as Response, next);

    // Default limit is 5 in our test config
    expect(res._headers['RateLimit-Limit']).toBe(5);
    expect(res._headers['RateLimit-Remaining']).toBe(4);
  });
});
