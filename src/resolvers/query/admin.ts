import { postgres } from '../../clients/postgres.js';
import { arangoClient } from '../../clients/arango/index.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { TenantContext } from '../../types/tenant.js';

export const adminQueries = {
  async stats(_: any, __: any, context: TenantContext) {
    requireAuth(context);

    const [arangoStats, postgresStats, domainCounts] = await Promise.all([
      arangoClient.getStats(context.organizationId),
      postgres.getStats(context.organizationId),
      arangoClient.getDomainCounts(context.organizationId),
    ]);

    let breakdown = domainCounts.map(d => ({
      domain: d.domain,
      zettelCount: d.count,
      topTopics: [],
    }));

    // Filter stats by Kai domain filters
    const f = context.kaiFilters;
    if (f && f.domains.length > 0) {
      breakdown = breakdown.filter(d => f.domains.includes(d.domain));
    }

    const filteredZettels = f?.domains.length
      ? breakdown.reduce((sum, d) => sum + d.zettelCount, 0)
      : arangoStats.totalZettels;

    return {
      totalZettels: filteredZettels,
      totalRelationships: arangoStats.totalRelationships,
      totalChunks: postgresStats.totalChunks,
      domainBreakdown: breakdown,
      lastUpdated: new Date().toISOString(),
    };
  },

  async organization(_: any, __: any, context: TenantContext) {
    requireAuth(context);

    return {
      id: context.organizationId,
      name: context.organizationId,
      isActive: true,
    };
  },
};
