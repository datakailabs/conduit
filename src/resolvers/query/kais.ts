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

export const kaiQueries = {
  async kais(_: any, __: any, context: TenantContext) {
    requireAuth(context);
    return getStore().listKais(context.organizationId);
  },

  async kai(_: any, args: { id: string }, context: TenantContext) {
    requireAuth(context);
    const kai = await getStore().getKai(args.id);
    if (kai && kai.organizationId !== context.organizationId) return null;
    return kai;
  },
};
