import { arangoClient } from '../../clients/arango/index.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { TenantContext } from '../../types/tenant.js';

export const graphQueries = {
  async conceptGraph(
    _: any,
    args: { zettelId: string; depth?: number; relationshipTypes?: string[] },
    context: TenantContext
  ) {
    requireAuth(context);

    const depth = args.depth || 1;
    const data = await arangoClient.getZettelWithRelationships(
      context.organizationId,
      args.zettelId,
      depth
    );

    if (!data) return null;

    return {
      concept: data.zettel,
      relationships: data.relationships,
      depth,
    };
  },

  async prerequisitePath(
    _: any,
    args: { from: string; to: string },
    context: TenantContext
  ) {
    requireAuth(context);

    const path = await arangoClient.findPrerequisitePath(
      context.organizationId,
      args.from,
      args.to
    );

    if (!path) return null;

    return {
      path: path.map((step, index) => ({
        zettelId: step.id,
        title: step.title,
        relationshipType: step.type,
        order: index,
      })),
      totalSteps: path.length,
      estimatedTime: `${path.length * 30} minutes`,
    };
  },

  async relatedConcepts(
    _: any,
    args: { zettelId: string; relationshipType?: string; limit?: number },
    context: TenantContext
  ) {
    requireAuth(context);

    const data = await arangoClient.getZettelWithRelationships(
      context.organizationId,
      args.zettelId
    );

    if (!data) return [];

    let relationships = data.relationships;
    if (args.relationshipType) {
      relationships = relationships.filter((r) => r.type === args.relationshipType);
    }
    if (args.limit) {
      relationships = relationships.slice(0, args.limit);
    }
    return relationships;
  },
};
