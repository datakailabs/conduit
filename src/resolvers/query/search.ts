import { postgres } from '../../clients/postgres.js';
import { arangoClient } from '../../clients/arango/index.js';
import { embeddingsService } from '../../services/embeddings/index.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { TenantContext } from '../../types/tenant.js';

/** Apply kai domain filter to results (post-query) */
function applyKaiFilters(zettels: any[], context: TenantContext): any[] {
  const f = context.kaiFilters;
  if (!f) return zettels;
  let result = zettels;
  if (f.domains.length > 0) {
    result = result.filter(z => z.domains?.some((d: string) => f.domains.includes(d)));
  }
  if (f.topics.length > 0) {
    result = result.filter(z => z.topics?.some((t: string) => f.topics.includes(t)));
  }
  if (f.knowledgeTypes.length > 0) {
    result = result.filter(z => f.knowledgeTypes.includes(z.knowledgeType));
  }
  return result;
}

export const searchQueries = {
  async semanticSearch(
    _: any,
    args: {
      query: string;
      domain?: string;
      topics?: string[];
      knowledgeType?: string;
      limit?: number;
    },
    context: TenantContext
  ) {
    requireAuth(context);

    const f = context.kaiFilters;
    // If Kai has a single domain filter and no explicit domain arg, use it
    const domain = args.domain || (f?.domains.length === 1 ? f.domains[0] : undefined);
    const topics = args.topics || (f?.topics.length ? f.topics : undefined);
    const knowledgeType = args.knowledgeType || (f?.knowledgeTypes.length === 1 ? f.knowledgeTypes[0] : undefined);

    const queryEmbedding = await embeddingsService.generateEmbedding(args.query);
    const limit = args.limit || 10;
    const results = await postgres.search(
      context.organizationId,
      queryEmbedding,
      limit * 5,
      { domain, topics, knowledgeType }
    );

    // Post-filter for multi-domain kai filters
    let filtered = results;
    if (f && f.domains.length > 1) {
      filtered = results.filter(r =>
        r.metadata.domains?.some((d: string) => f.domains.includes(d))
      );
    }

    const deduped = new Map<string, typeof results[0]>();
    for (const result of filtered) {
      const existing = deduped.get(result.zettelId);
      if (!existing || result.score > existing.score) {
        deduped.set(result.zettelId, result);
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  },

  async zettel(_: any, args: { id: string }, context: TenantContext) {
    requireAuth(context);
    return await arangoClient.getZettel(context.organizationId, args.id);
  },

  async zettelsByTopic(
    _: any,
    args: { topic: string; domain?: string; limit?: number },
    context: TenantContext
  ) {
    requireAuth(context);

    const zettels = await arangoClient.getZettelsByTopic(
      context.organizationId,
      args.topic,
      args.limit || 50
    );

    let result = zettels;
    if (args.domain) {
      result = result.filter((z) => z.domains.includes(args.domain!));
    }
    return applyKaiFilters(result, context);
  },

  async zettelsByDomain(
    _: any,
    args: { domain: string; knowledgeType?: string; limit?: number },
    context: TenantContext
  ) {
    requireAuth(context);

    const zettels = await arangoClient.getZettelsByDomain(
      context.organizationId,
      args.domain,
      args.limit || 50
    );

    let result = zettels;
    if (args.knowledgeType) {
      result = result.filter((z) => z.knowledgeType === args.knowledgeType);
    }
    return applyKaiFilters(result, context);
  },
};
