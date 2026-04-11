/**
 * Conduit Insights — proactive cross-domain synthesis.
 *
 * Scans the knowledge graph for emergent connections across domains
 * that nobody queried for. Surfaces tensions, paradoxes, and
 * non-obvious dependencies between concepts.
 *
 * Inspired by nodepad's emergent thesis engine.
 */

import OpenAI from 'openai';
import { Pool } from 'pg';
import { extractionConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('insights');

// ─── Types ────────────────────────────────────────────────────────────

export interface Insight {
  thesis: string;
  bridgeDomains: string[];
  bridgeTopic: string;
  supportingZettels: { id: string; title: string; domain: string }[];
  confidence: number;
}

export interface InsightOptions {
  /** Number of insights to generate */
  count?: number;
  /** Domains to sample from (default: all) */
  domains?: string[];
  /** Exclude previously generated theses to avoid repeats */
  previousTheses?: string[];
}

// ─── Prompt ───────────────────────────────────────────────────────────

const INSIGHTS_SYSTEM = `You are an Emergent Insight engine for a knowledge graph.

Your job is to find **unspoken bridges** — insights that arise from the tension or intersection between different knowledge domains, ones that are implied by the data but not explicitly stated in any single knowledge unit.

## Rules
1. Find CROSS-DOMAIN connections. The knowledge units span multiple domains. Prioritise ideas that link at least two domains in a non-obvious way.
2. Look for tensions, paradoxes, inversions, or unexpected dependencies — not the dominant theme.
3. Be additive: say something the knowledge units imply but do not state. Never summarise.
4. Each insight should be 1-3 sentences. Sharp and specific — a thesis, a productive tension, or an actionable implication.
5. Include a one-word "bridge topic" that names the connection point.
6. Rate your confidence from 0.0 to 1.0 — higher means the evidence in the units strongly supports this insight.

## Output
Return ONLY valid JSON:
{
  "insights": [
    {
      "thesis": "The insight text (1-3 sentences)",
      "bridgeTopic": "one-word topic",
      "bridgeDomains": ["domain1", "domain2"],
      "supportingIndices": [0, 3, 7],
      "confidence": 0.85
    }
  ]
}`;

// ─── Service ──────────────────────────────────────────────────────────

export class InsightsService {
  private client: OpenAI;
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    this.client = new OpenAI(extractionConfig.clientConfig);
  }

  /**
   * Generate cross-domain insights by sampling diverse zettels
   * and asking the LLM to find emergent connections.
   */
  async generate(orgId: string, options: InsightOptions = {}): Promise<Insight[]> {
    const count = options.count ?? 3;
    const previousTheses = options.previousTheses ?? [];

    try {
      // 1. Sample diverse zettels across domains
      const zettels = await this.sampleDiverseZettels(orgId, options.domains);

      if (zettels.length < 4) {
        log.info('Not enough zettels for insight generation', { count: zettels.length });
        return [];
      }

      // 2. Build the prompt with sampled zettels
      const domains = [...new Set(zettels.map(z => z.domains).flat())];

      const avoidBlock = previousTheses.length > 0
        ? `\n\n## AVOID — these have already been generated, do not produce anything semantically close:\n${previousTheses.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`
        : '';

      const userPrompt = `Generate ${count} cross-domain insights from the following knowledge units.

The knowledge spans these domains: ${domains.join(', ')}.
${avoidBlock}

## Knowledge Units
${zettels.map((z, i) => `<unit index="${i}" domain="${z.domains[0] || 'general'}" type="${z.knowledge_type}">\nTitle: ${z.title}\n${z.content.slice(0, 400)}\n</unit>`).join('\n\n')}`;

      // 3. Call LLM
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: INSIGHTS_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return [];

      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed.insights)) return [];

      // 4. Map indices back to zettel metadata
      return parsed.insights.map((insight: any) => ({
        thesis: insight.thesis,
        bridgeDomains: insight.bridgeDomains || [],
        bridgeTopic: insight.bridgeTopic || 'general',
        confidence: insight.confidence ?? 0.5,
        supportingZettels: (insight.supportingIndices || [])
          .filter((i: number) => i < zettels.length)
          .map((i: number) => ({
            id: zettels[i].id,
            title: zettels[i].title,
            domain: zettels[i].domains[0] || 'general',
          })),
      }));
    } catch (error) {
      log.error('Insight generation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Sample zettels across domains for maximum diversity.
   * Takes a few from each domain, prioritizing domains with cross-domain edges.
   */
  private async sampleDiverseZettels(
    orgId: string,
    filterDomains?: string[]
  ): Promise<Array<{ id: string; title: string; content: string; domains: string[]; knowledge_type: string }>> {
    // Get distinct domains with counts
    const domainQuery = filterDomains?.length
      ? `SELECT unnest(domains) as domain, COUNT(*) as cnt FROM chunks WHERE organization_id = $1 AND domains && $2::text[] GROUP BY domain ORDER BY cnt DESC LIMIT 10`
      : `SELECT unnest(domains) as domain, COUNT(*) as cnt FROM chunks WHERE organization_id = $1 GROUP BY domain ORDER BY cnt DESC LIMIT 10`;

    const domainParams = filterDomains?.length
      ? [orgId, filterDomains]
      : [orgId];

    const { rows: domainRows } = await this.pool.query(domainQuery, domainParams);
    const domains = domainRows.map((r: any) => r.domain as string);

    if (domains.length < 2) return [];

    // Sample 3-4 zettels from each domain (diverse knowledge types)
    const allZettels: Array<{ id: string; title: string; content: string; domains: string[]; knowledge_type: string }> = [];
    const seenIds = new Set<string>();

    for (const domain of domains.slice(0, 6)) {
      const { rows } = await this.pool.query(
        `SELECT id, title, content, domains, knowledge_type FROM (
           SELECT DISTINCT ON (zettel_id) zettel_id as id, zettel_title as title, content, domains, knowledge_type
           FROM chunks
           WHERE organization_id = $1 AND $2 = ANY(domains)
         ) sub ORDER BY RANDOM() LIMIT 4`,
        [orgId, domain]
      );

      for (const row of rows) {
        if (!seenIds.has(row.id)) {
          seenIds.add(row.id);
          allZettels.push({
            id: row.id,
            title: row.title,
            content: row.content,
            domains: row.domains,
            knowledge_type: row.knowledge_type,
          });
        }
      }
    }

    // Shuffle for randomness across domains
    return allZettels.sort(() => Math.random() - 0.5).slice(0, 20);
  }
}
