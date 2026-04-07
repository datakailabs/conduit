import { ingestionService } from '../../services/ingestion.js';
import { requireAdminContext } from '../../middleware/require-auth.js';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { scriptoriumConfig } from '../../config.js';
import type { TenantContext } from '../../types/tenant.js';

export const ingestionMutations = {
  async ingestZettel(
    _: any,
    args: { filePath: string },
    context: TenantContext
  ) {
    requireAdminContext(context);
    return await ingestionService.ingestZettel(context.organizationId, args.filePath);
  },

  async reindexAll(
    _: any,
    args: { path?: string },
    context: TenantContext
  ) {
    requireAdminContext(context);

    const zettelPath = args.path || scriptoriumConfig.zettelPath;
    const startTime = Date.now();

    try {
      const files = await readdir(zettelPath);
      const zettelFiles = files.filter((f) => f.endsWith('.md'));

      let processed = 0;
      let chunksCreated = 0;
      let relationshipsCreated = 0;
      const errors: string[] = [];

      for (const file of zettelFiles) {
        const filePath = join(zettelPath, file);
        const result = await ingestionService.ingestZettel(
          context.organizationId,
          filePath
        );

        if (result.success) {
          processed++;
          chunksCreated += result.chunksCreated;
          relationshipsCreated += result.relationshipsCreated;
        } else {
          errors.push(`${file}: ${result.error}`);
        }
      }

      const duration = Math.round((Date.now() - startTime) / 1000);

      return {
        success: errors.length === 0,
        zettelsProcessed: processed,
        chunksCreated,
        relationshipsCreated,
        errors,
        duration: `${duration}s`,
      };
    } catch (error) {
      return {
        success: false,
        zettelsProcessed: 0,
        chunksCreated: 0,
        relationshipsCreated: 0,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        duration: '0s',
      };
    }
  },

  async deleteZettel(
    _: any,
    args: { id: string },
    context: TenantContext
  ) {
    requireAdminContext(context);
    return await ingestionService.deleteZettel(context.organizationId, args.id);
  },
};
