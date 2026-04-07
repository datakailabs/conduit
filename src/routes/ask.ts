import { Router } from 'express';
import { z } from 'zod';
import { graphRAGService } from '../services/graphrag.js';
import { synthesisService } from '../services/synthesis.js';
import type { UsageMeter } from '../middleware/usage.js';
import type { ChatLogger } from '../middleware/chat-logger.js';
import type { ThreadResolver } from '../services/thread-resolver.js';
import { createLogger } from '../lib/logger.js';
import { metrics } from '../middleware/metrics.js';

const log = createLogger('ask');

const askSchema = z.object({
  query: z.string().min(1).max(2000),
  thread_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(20).default(8),
  mode: z.enum(['standard', 'swarm']).default('standard'),
  stream: z.boolean().default(false),
});

export function createAskRouter(usageMeter: UsageMeter, chatLogger: ChatLogger, threadResolver: ThreadResolver): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const body = askSchema.parse(req.body);
      const orgId = req.tenant!.organizationId;
      const kaiId = req.headers['x-kai-id'] as string | undefined;
      const totalStart = process.hrtime.bigint();

      // Thread resolution: rewrite follow-up queries using conversation context
      let effectiveQuery = body.query;
      let rewrittenQuery: string | undefined;
      let conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [];

      if (body.thread_id) {
        const threadCtx = await threadResolver.resolve(orgId, body.thread_id, body.query);
        effectiveQuery = threadCtx.rewrittenQuery;
        conversationHistory = threadCtx.conversationHistory;
        if (effectiveQuery !== body.query) {
          rewrittenQuery = effectiveQuery;
        }
      }

      // GraphRAG retrieval
      const retrievalStart = process.hrtime.bigint();
      const retrieval = await graphRAGService.retrieve(orgId, effectiveQuery, body.limit);
      const retrievalMs = Number((process.hrtime.bigint() - retrievalStart) / 1_000_000n);

      metrics.recordChat();
      metrics.recordChatLatency('retrieval', retrievalMs);
      metrics.recordChatSources(retrieval.results.length);

      const sources = retrieval.results.map((r) => ({
        id: r.zettelId,
        title: r.title,
        content: r.content,
        score: r.score,
        path: r.path,
        domains: r.domains,
        sourceUrl: r.sourceUrl,
        provenance: r.provenance,
      }));

      if (retrieval.results.length === 0) {
        metrics.recordChatNoResults();
        const totalMs = Number((process.hrtime.bigint() - totalStart) / 1_000_000n);
        const noResultAnswer = "I don't have relevant knowledge to answer this question.";

        chatLogger.record({
          organizationId: orgId,
          kaiId,
          keyId: req.tenant!.keyId,
          cognitoSub: req.tenant!.cognitoSub,
          query: body.query,
          answer: noResultAnswer,
          sources: [],
          retrievalStats: retrieval.stats,
          mode: body.mode,
          streamed: body.stream,
          threadId: body.thread_id,
          rewrittenQuery,
          sourceCount: 0,
          retrievalMs,
          totalLatencyMs: totalMs,
        });

        if (body.stream) {
          sendSSE(res, 'retrieval', { query: body.query, sources: [], retrieval: retrieval.stats, ...(rewrittenQuery && { rewrittenQuery }) });
          sendSSE(res, 'token', { token: noResultAnswer });
          sendSSE(res, 'done', { mode: 'standard' });
          res.end();
        } else {
          res.json({
            query: body.query,
            answer: noResultAnswer,
            sources: [],
            retrieval: retrieval.stats,
          });
        }
        return;
      }

      // ─── Streaming mode ──────────────────────────────────────────
      if (body.stream) {
        if (body.mode === 'swarm') {
          res.status(400).json({ error: 'Streaming is not supported with swarm mode' });
          return;
        }

        metrics.recordAskStream();

        // Set up SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no', // Disable nginx buffering
        });

        // Send retrieval metadata first
        sendSSE(res, 'retrieval', {
          query: body.query,
          sources,
          retrieval: retrieval.stats,
          ...(rewrittenQuery && { rewrittenQuery }),
        });

        // Stream synthesis tokens
        const synthesisStart = process.hrtime.bigint();
        const answerTokens: string[] = [];

        await synthesisService.synthesizeStream(
          effectiveQuery,
          retrieval.structuredContext,
          {
            onToken: (token) => {
              answerTokens.push(token);
              sendSSE(res, 'token', { token });
            },
            onDone: (result) => {
              const synthesisMs = Number((process.hrtime.bigint() - synthesisStart) / 1_000_000n);
              const totalMs = Number((process.hrtime.bigint() - totalStart) / 1_000_000n);

              metrics.recordChatLatency('synthesis', synthesisMs);

              sendSSE(res, 'done', {
                mode: result.mode,
                model: result.model,
              });

              // Record usage
              usageMeter.record(orgId, 'ask', {
                query: body.query,
                resultCount: retrieval.results.length,
                ...retrieval.stats,
                mode: body.mode,
                ...(result.model ? { model: result.model } : {}),
                streamed: true,
              });

              // Record chat log
              chatLogger.record({
                organizationId: orgId,
                kaiId,
                keyId: req.tenant!.keyId,
                cognitoSub: req.tenant!.cognitoSub,
                query: body.query,
                answer: answerTokens.join(''),
                sources,
                retrievalStats: retrieval.stats,
                mode: body.mode,
                model: result.model,
                streamed: true,
                threadId: body.thread_id,
                rewrittenQuery,
                sourceCount: sources.length,
                retrievalMs,
                synthesisMs,
                totalLatencyMs: totalMs,
              });

              res.end();
            },
            onError: (error) => {
              sendSSE(res, 'error', { error: error.message });
              res.end();
            },
          },
          conversationHistory.length > 0 ? { conversationHistory } : undefined,
        );
        return;
      }

      // ─── Standard (non-streaming) mode ────────────────────────────
      const synthesisStart = process.hrtime.bigint();
      const synthesis = await synthesisService.synthesize(
        effectiveQuery,
        retrieval.structuredContext,
        body.mode,
        conversationHistory.length > 0 ? { conversationHistory } : undefined
      );
      const synthesisMs = Number((process.hrtime.bigint() - synthesisStart) / 1_000_000n);
      const totalMs = Number((process.hrtime.bigint() - totalStart) / 1_000_000n);

      metrics.recordChatLatency('synthesis', synthesisMs);

      // Record usage
      usageMeter.record(orgId, 'ask', {
        query: body.query,
        resultCount: retrieval.results.length,
        ...retrieval.stats,
        mode: body.mode,
        ...(synthesis.model ? { model: synthesis.model } : {}),
        ...(synthesis.swarm ? { swarm: synthesis.swarm } : {}),
      });

      // Record chat log
      chatLogger.record({
        organizationId: orgId,
        kaiId,
        keyId: req.tenant!.keyId,
        cognitoSub: req.tenant!.cognitoSub,
        query: body.query,
        answer: synthesis.answer,
        sources,
        retrievalStats: retrieval.stats,
        mode: body.mode,
        model: synthesis.model,
        streamed: false,
        threadId: body.thread_id,
        rewrittenQuery,
        sourceCount: sources.length,
        retrievalMs,
        synthesisMs,
        totalLatencyMs: totalMs,
      });

      res.json({
        query: body.query,
        answer: synthesis.answer,
        mode: synthesis.mode,
        sources,
        retrieval: retrieval.stats,
        ...(rewrittenQuery && { rewrittenQuery }),
        ...(synthesis.swarm && { swarm: synthesis.swarm }),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      if (error instanceof Error && error.message.startsWith('Swarm engine error:')) {
        res.status(502).json({ error: error.message });
        return;
      }
      log.error('Ask query failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// ─── SSE Helper ──────────────────────────────────────────────────────

function sendSSE(res: import('express').Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
