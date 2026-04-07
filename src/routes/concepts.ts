/**
 * Concept Matching API — Maps question text to knowledge graph concepts.
 *
 * Designed for Dojo integration: given a question's text and domain,
 * returns matching concept nodes with provenance (source doc URLs).
 * Supports single and batch matching.
 */

import { Router } from 'express';
import { z } from 'zod';
import { graphRAGService } from '../services/graphrag.js';
import type { UsageMeter } from '../middleware/usage.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('concepts');

// ─── Validation Schemas ─────────────────────────────────────────────

const matchOneSchema = z.object({
  text: z.string().min(1).max(4000),
  domain: z.string().min(1).optional(),
  topics: z.array(z.string()).max(20).optional(),
  limit: z.number().int().min(1).max(10).default(3),
});

const matchBatchSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1).max(4000),
      domain: z.string().min(1).optional(),
      topics: z.array(z.string()).max(20).optional(),
    })
  ).min(1).max(50),
  limit: z.number().int().min(1).max(5).default(3),
});

// ─── Router ─────────────────────────────────────────────────────────

export function createConceptsRouter(usageMeter: UsageMeter): Router {
  const router = Router();

  /**
   * POST /api/v1/concepts/match
   *
   * Match a single question to knowledge graph concepts.
   * Returns concept nodes with confidence scores and source doc URLs.
   */
  router.post('/match', async (req, res) => {
    try {
      const body = matchOneSchema.parse(req.body);
      const orgId = req.tenant!.organizationId;

      const query = buildConceptQuery(body.text, body.domain, body.topics);
      const retrieval = await graphRAGService.retrieve(orgId, query, body.limit);

      const concepts = retrieval.results.map(r => ({
        conceptId: r.zettelId,
        title: r.title,
        confidence: Math.round(r.score * 100) / 100,
        domains: r.domains,
        topics: r.topics,
        sourceDocUrl: r.provenance?.url || r.sourceUrl || null,
        sourceDocType: r.provenance?.type || null,
        knowledgeType: r.knowledgeType,
        relationships: r.relationships.map(rel => ({
          type: rel.type,
          targetId: rel.targetId,
          targetTitle: rel.targetTitle,
        })),
      }));

      usageMeter.record(orgId, 'concept_match', {
        query: body.text.slice(0, 200),
        domain: body.domain,
        matchCount: concepts.length,
      });

      res.json({
        concepts,
        matchCount: concepts.length,
        retrieval: retrieval.stats,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Concept match failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/v1/concepts/match/batch
   *
   * Match multiple questions to knowledge graph concepts in one call.
   * Designed for Dojo's publish pipeline to retroactively link questions.
   */
  router.post('/match/batch', async (req, res) => {
    try {
      const body = matchBatchSchema.parse(req.body);
      const orgId = req.tenant!.organizationId;

      const results: Array<{
        questionId: string;
        concepts: Array<{
          conceptId: string;
          title: string;
          confidence: number;
          domains: string[];
          sourceDocUrl: string | null;
        }>;
      }> = [];

      // Process sequentially to avoid overwhelming the embeddings API
      for (const question of body.questions) {
        const query = buildConceptQuery(question.text, question.domain, question.topics);
        const retrieval = await graphRAGService.retrieve(orgId, query, body.limit);

        results.push({
          questionId: question.id,
          concepts: retrieval.results.map(r => ({
            conceptId: r.zettelId,
            title: r.title,
            confidence: Math.round(r.score * 100) / 100,
            domains: r.domains,
            sourceDocUrl: r.provenance?.url || r.sourceUrl || null,
          })),
        });
      }

      usageMeter.record(orgId, 'concept_match_batch', {
        questionCount: body.questions.length,
        totalMatches: results.reduce((sum, r) => sum + r.concepts.length, 0),
      });

      res.json({
        results,
        questionsProcessed: results.length,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Concept batch match failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// ─── Query Building ─────────────────────────────────────────────────

function buildConceptQuery(
  text: string,
  domain?: string,
  topics?: string[]
): string {
  let query = text;

  // Prepend domain for better vector similarity
  if (domain) {
    query = `${domain}: ${query}`;
  }

  // Append topics as context
  if (topics?.length) {
    query += `\n\nTopics: ${topics.join(', ')}`;
  }

  return query;
}
