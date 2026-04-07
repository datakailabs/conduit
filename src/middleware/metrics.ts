/**
 * Prometheus Metrics — Lightweight metrics collection and /metrics endpoint.
 *
 * Collects: HTTP request counts/durations, active connections, rate limit hits,
 * and business metrics (asks, extracts, context queries). No external dependencies.
 *
 * Prometheus scrape: GET /metrics
 */

import type { Request, Response, NextFunction } from 'express';

// ─── Metric Storage ──────────────────────────────────────────────────

interface HistogramBucket {
  le: number;
  count: number;
}

interface RequestMetric {
  count: number;
  duration_sum: number;
  duration_count: number;
  buckets: HistogramBucket[];
  status_2xx: number;
  status_4xx: number;
  status_5xx: number;
}

const DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

class MetricsCollector {
  private requests = new Map<string, RequestMetric>();
  private rateLimitHits = 0;
  private activeConnections = 0;
  private startTime = Date.now();

  // Business metrics
  private askCount = 0;
  private askStreamCount = 0;
  private contextCount = 0;
  private extractCount = 0;

  // Chat metrics
  private chatTotal = 0;
  private chatNoResultsTotal = 0;
  private chatSourcesBuckets: HistogramBucket[] = [0, 1, 2, 3, 5, 8, 10, 15, 20].map(le => ({ le, count: 0 }));
  private chatSourcesSum = 0;
  private chatSourcesCount = 0;
  private chatRetrievalBuckets: HistogramBucket[] = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000].map(le => ({ le, count: 0 }));
  private chatRetrievalSum = 0;
  private chatRetrievalCount = 0;
  private chatSynthesisBuckets: HistogramBucket[] = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000].map(le => ({ le, count: 0 }));
  private chatSynthesisSum = 0;
  private chatSynthesisCount = 0;

  private getOrCreate(key: string): RequestMetric {
    let metric = this.requests.get(key);
    if (!metric) {
      metric = {
        count: 0,
        duration_sum: 0,
        duration_count: 0,
        buckets: DURATION_BUCKETS.map(le => ({ le, count: 0 })),
        status_2xx: 0,
        status_4xx: 0,
        status_5xx: 0,
      };
      this.requests.set(key, metric);
    }
    return metric;
  }

  recordRequest(method: string, route: string, status: number, durationMs: number): void {
    const key = `${method}:${route}`;
    const metric = this.getOrCreate(key);

    metric.count++;
    metric.duration_sum += durationMs;
    metric.duration_count++;

    for (const bucket of metric.buckets) {
      if (durationMs <= bucket.le) bucket.count++;
    }

    if (status >= 200 && status < 300) metric.status_2xx++;
    else if (status >= 400 && status < 500) metric.status_4xx++;
    else if (status >= 500) metric.status_5xx++;

    // Track business metrics
    if (route.includes('/ask')) {
      this.askCount++;
    } else if (route.includes('/context')) {
      this.contextCount++;
    } else if (route.includes('/extract')) {
      this.extractCount++;
    }
  }

  recordRateLimitHit(): void {
    this.rateLimitHits++;
  }

  recordAskStream(): void {
    this.askStreamCount++;
  }

  recordChat(): void {
    this.chatTotal++;
  }

  recordChatNoResults(): void {
    this.chatNoResultsTotal++;
  }

  recordChatSources(count: number): void {
    this.chatSourcesSum += count;
    this.chatSourcesCount++;
    for (const bucket of this.chatSourcesBuckets) {
      if (count <= bucket.le) bucket.count++;
    }
  }

  recordChatLatency(phase: 'retrieval' | 'synthesis', ms: number): void {
    if (phase === 'retrieval') {
      this.chatRetrievalSum += ms;
      this.chatRetrievalCount++;
      for (const bucket of this.chatRetrievalBuckets) {
        if (ms <= bucket.le) bucket.count++;
      }
    } else {
      this.chatSynthesisSum += ms;
      this.chatSynthesisCount++;
      for (const bucket of this.chatSynthesisBuckets) {
        if (ms <= bucket.le) bucket.count++;
      }
    }
  }

  connectionOpened(): void {
    this.activeConnections++;
  }

  connectionClosed(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
  }

  /** External stats to include in metrics output */
  private externalStats: Map<string, () => Record<string, number>> = new Map();

  registerExternalStats(name: string, fn: () => Record<string, number>): void {
    this.externalStats.set(name, fn);
  }

  /** Format all metrics in Prometheus exposition format */
  serialize(): string {
    const lines: string[] = [];
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    // Process info
    lines.push('# HELP conduit_info Conduit server info');
    lines.push('# TYPE conduit_info gauge');
    lines.push('conduit_info{version="1.0.0"} 1');

    // Uptime
    lines.push('# HELP conduit_uptime_seconds Server uptime in seconds');
    lines.push('# TYPE conduit_uptime_seconds gauge');
    lines.push(`conduit_uptime_seconds ${uptimeSeconds}`);

    // Active connections
    lines.push('# HELP conduit_active_connections Current active HTTP connections');
    lines.push('# TYPE conduit_active_connections gauge');
    lines.push(`conduit_active_connections ${this.activeConnections}`);

    // HTTP request total
    lines.push('# HELP conduit_http_requests_total Total HTTP requests');
    lines.push('# TYPE conduit_http_requests_total counter');
    for (const [key, metric] of this.requests) {
      const [method, route] = key.split(':');
      lines.push(`conduit_http_requests_total{method="${method}",route="${route}",status="2xx"} ${metric.status_2xx}`);
      lines.push(`conduit_http_requests_total{method="${method}",route="${route}",status="4xx"} ${metric.status_4xx}`);
      lines.push(`conduit_http_requests_total{method="${method}",route="${route}",status="5xx"} ${metric.status_5xx}`);
    }

    // HTTP request duration
    lines.push('# HELP conduit_http_request_duration_ms HTTP request duration in milliseconds');
    lines.push('# TYPE conduit_http_request_duration_ms histogram');
    for (const [key, metric] of this.requests) {
      const [method, route] = key.split(':');
      const labels = `method="${method}",route="${route}"`;
      for (const bucket of metric.buckets) {
        lines.push(`conduit_http_request_duration_ms_bucket{${labels},le="${bucket.le}"} ${bucket.count}`);
      }
      lines.push(`conduit_http_request_duration_ms_bucket{${labels},le="+Inf"} ${metric.duration_count}`);
      lines.push(`conduit_http_request_duration_ms_sum{${labels}} ${metric.duration_sum}`);
      lines.push(`conduit_http_request_duration_ms_count{${labels}} ${metric.duration_count}`);
    }

    // Rate limit hits
    lines.push('# HELP conduit_rate_limit_hits_total Total rate limit rejections');
    lines.push('# TYPE conduit_rate_limit_hits_total counter');
    lines.push(`conduit_rate_limit_hits_total ${this.rateLimitHits}`);

    // Business metrics
    lines.push('# HELP conduit_ask_total Total ask queries');
    lines.push('# TYPE conduit_ask_total counter');
    lines.push(`conduit_ask_total ${this.askCount}`);

    lines.push('# HELP conduit_ask_stream_total Total streamed ask queries');
    lines.push('# TYPE conduit_ask_stream_total counter');
    lines.push(`conduit_ask_stream_total ${this.askStreamCount}`);

    lines.push('# HELP conduit_context_total Total context queries');
    lines.push('# TYPE conduit_context_total counter');
    lines.push(`conduit_context_total ${this.contextCount}`);

    lines.push('# HELP conduit_extract_total Total extraction requests');
    lines.push('# TYPE conduit_extract_total counter');
    lines.push(`conduit_extract_total ${this.extractCount}`);

    // Chat metrics
    lines.push('# HELP conduit_chat_total Total chat queries');
    lines.push('# TYPE conduit_chat_total counter');
    lines.push(`conduit_chat_total ${this.chatTotal}`);

    lines.push('# HELP conduit_chat_no_results_total Chat queries with no results');
    lines.push('# TYPE conduit_chat_no_results_total counter');
    lines.push(`conduit_chat_no_results_total ${this.chatNoResultsTotal}`);

    lines.push('# HELP conduit_chat_sources_count Sources returned per chat query');
    lines.push('# TYPE conduit_chat_sources_count histogram');
    for (const bucket of this.chatSourcesBuckets) {
      lines.push(`conduit_chat_sources_count_bucket{le="${bucket.le}"} ${bucket.count}`);
    }
    lines.push(`conduit_chat_sources_count_bucket{le="+Inf"} ${this.chatSourcesCount}`);
    lines.push(`conduit_chat_sources_count_sum ${this.chatSourcesSum}`);
    lines.push(`conduit_chat_sources_count_count ${this.chatSourcesCount}`);

    lines.push('# HELP conduit_chat_retrieval_latency_ms Chat retrieval latency in milliseconds');
    lines.push('# TYPE conduit_chat_retrieval_latency_ms histogram');
    for (const bucket of this.chatRetrievalBuckets) {
      lines.push(`conduit_chat_retrieval_latency_ms_bucket{le="${bucket.le}"} ${bucket.count}`);
    }
    lines.push(`conduit_chat_retrieval_latency_ms_bucket{le="+Inf"} ${this.chatRetrievalCount}`);
    lines.push(`conduit_chat_retrieval_latency_ms_sum ${this.chatRetrievalSum}`);
    lines.push(`conduit_chat_retrieval_latency_ms_count ${this.chatRetrievalCount}`);

    lines.push('# HELP conduit_chat_synthesis_latency_ms Chat synthesis latency in milliseconds');
    lines.push('# TYPE conduit_chat_synthesis_latency_ms histogram');
    for (const bucket of this.chatSynthesisBuckets) {
      lines.push(`conduit_chat_synthesis_latency_ms_bucket{le="${bucket.le}"} ${bucket.count}`);
    }
    lines.push(`conduit_chat_synthesis_latency_ms_bucket{le="+Inf"} ${this.chatSynthesisCount}`);
    lines.push(`conduit_chat_synthesis_latency_ms_sum ${this.chatSynthesisSum}`);
    lines.push(`conduit_chat_synthesis_latency_ms_count ${this.chatSynthesisCount}`);

    // External stats (e.g., cache)
    for (const [name, fn] of this.externalStats) {
      try {
        const stats = fn();
        for (const [key, value] of Object.entries(stats)) {
          lines.push(`conduit_${name}_${key} ${value}`);
        }
      } catch { /* best-effort */ }
    }

    return lines.join('\n') + '\n';
  }
}

// ─── Singleton ───────────────────────────────────────────────────────

export const metrics = new MetricsCollector();

// ─── Middleware ──────────────────────────────────────────────────────

/**
 * Metrics collection middleware. Tracks request count, duration, and status.
 * Place early in the middleware chain (after cors/json, before routes).
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  metrics.connectionOpened();

  res.on('finish', () => {
    metrics.connectionClosed();

    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs / 1_000_000n);

    // Normalize route to avoid high cardinality (strip IDs)
    const route = normalizeRoute(req.originalUrl || req.path);

    // Skip health/ready/metrics from tracking
    if (route === '/health' || route === '/ready' || route === '/metrics') return;

    metrics.recordRequest(req.method, route, res.statusCode, durationMs);

    if (res.statusCode === 429) {
      metrics.recordRateLimitHit();
    }
  });

  next();
}

/**
 * Normalize routes for Prometheus labels to prevent cardinality explosion.
 * /api/v1/zettels/abc123 → /api/v1/zettels/:id
 */
function normalizeRoute(url: string): string {
  // Strip query string
  const path = url.split('?')[0];

  return path
    // Replace UUIDs and hex IDs
    .replace(/\/[a-f0-9]{8,}/gi, '/:id')
    // Replace org IDs
    .replace(/\/org_[a-z0-9]+/gi, '/:orgId')
    // Replace key IDs
    .replace(/\/key_[a-z0-9]+/gi, '/:keyId');
}
