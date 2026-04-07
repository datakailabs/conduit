import { postgres } from '../../clients/postgres.js';
import { KaiStore } from '../../clients/kais.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { TenantContext } from '../../types/tenant.js';

let kaiStore: KaiStore | null = null;

function getStore(): KaiStore {
  if (!kaiStore) {
    kaiStore = new KaiStore(postgres.getPool());
  }
  return kaiStore;
}

export const kaiMutations = {
  async createKai(
    _: any,
    args: { name: string; description?: string; domains?: string[]; topics?: string[]; knowledgeTypes?: string[] },
    context: TenantContext
  ) {
    requireAuth(context);
    return getStore().createKai(context.organizationId, args.name, {
      description: args.description,
      domains: args.domains,
      topics: args.topics,
      knowledgeTypes: args.knowledgeTypes,
    });
  },

  async updateKai(
    _: any,
    args: { id: string; name?: string; domains?: string[]; topics?: string[]; knowledgeTypes?: string[] },
    context: TenantContext
  ) {
    requireAuth(context);
    const kai = await getStore().getKai(args.id);
    if (!kai || kai.organizationId !== context.organizationId) {
      throw new Error('Kai not found');
    }
    return getStore().updateKai(args.id, {
      name: args.name,
      domains: args.domains,
      topics: args.topics,
      knowledgeTypes: args.knowledgeTypes,
    });
  },

  async deleteKai(_: any, args: { id: string }, context: TenantContext) {
    requireAuth(context);
    const kai = await getStore().getKai(args.id);
    if (!kai || kai.organizationId !== context.organizationId) {
      throw new Error('Kai not found');
    }
    return getStore().deleteKai(args.id);
  },
};
