import { arangoClient } from '../../clients/arango/index.js';
import type { TenantContext } from '../../types/tenant.js';

export const zettelTypeResolvers = {
  Zettel: {
    relationships: async (parent: any, _: any, context: TenantContext) => {
      const data = await arangoClient.getZettelWithRelationships(
        context.organizationId,
        parent.id
      );
      return data?.relationships || [];
    },
  },
};
