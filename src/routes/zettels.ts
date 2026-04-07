import { Router } from 'express';
import { z } from 'zod';
import { arangoClient } from '../clients/arango/index.js';
import { postgres } from '../clients/postgres.js';
import { ingestionService } from '../services/ingestion.js';
import { embeddingsService } from '../services/embeddings/index.js';
import { chunkZettelContent } from '../services/chunker.js';
import { randomUUID } from 'crypto';
import type { SourceProvenance } from '../types/provenance.js';
import type { GraphCRUD, GraphTopology, GraphTraversal, VectorStore } from '../types/stores.js';
import type { EmbeddingsProvider } from '../services/embeddings/types.js';
import type { IngestionService } from '../services/ingestion.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('zettels');

const provenanceSchema = z.object({
  type: z.enum(['url', 'pdf', 'database', 'file', 'api']),
  url: z.string().optional(),
  page: z.number().int().optional(),
  pageRange: z.string().optional(),
  query: z.string().optional(),
  table: z.string().optional(),
  path: z.string().optional(),
  endpoint: z.string().optional(),
  adapter: z.string().optional(),
  fetchedAt: z.string().optional(),
  title: z.string().optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  sourceUrl: z.string().url().nullable().optional(),
  provenance: provenanceSchema.nullable().optional(),
  domains: z.array(z.string()).optional(),
  topics: z.array(z.string()).min(3).optional(),
});

export interface ZettelsRouterDeps {
  graph: GraphCRUD & GraphTopology & Pick<GraphTraversal, 'getZettelWithRelationships'>;
  vectorStore: VectorStore;
  embeddings: EmbeddingsProvider;
  ingestion: IngestionService;
}

export function createZettelsRouter(deps?: Partial<ZettelsRouterDeps>): Router {
  const graph = deps?.graph ?? (arangoClient as ZettelsRouterDeps['graph']);
  const vectorStore = deps?.vectorStore ?? postgres;
  const emb = deps?.embeddings ?? embeddingsService;
  const ingest = deps?.ingestion ?? ingestionService;
  const router = Router();

  // GET /api/v1/zettels/topology/overview — Cluster-level map (domains + bridges)
  router.get('/topology/overview', async (req, res) => {
    try {
      const orgId = req.tenant!.organizationId;
      const overview = await graph.getTopologyOverview(orgId);
      res.json(overview);
    } catch (error) {
      log.error('Topology overview failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/zettels/topology/neighborhood/:id — Explore from a specific node
  router.get('/topology/neighborhood/:id', async (req, res) => {
    try {
      const orgId = req.tenant!.organizationId;
      const depth = Math.min(parseInt(req.query.depth as string) || 2, 3);
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 300);
      const result = await graph.getNeighborhood(orgId, req.params.id, depth, limit);
      res.json(result);
    } catch (error) {
      log.error('Neighborhood query failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/zettels/:id — Get full zettel
  router.get('/:id', async (req, res) => {
    try {
      const orgId = req.tenant!.organizationId;
      const zettel = await graph.getZettelWithRelationships(orgId, req.params.id, 1);

      if (!zettel) {
        res.status(404).json({ error: 'Zettel not found' });
        return;
      }

      res.json({
        id: zettel.zettel.id,
        title: zettel.zettel.title,
        content: zettel.zettel.content,
        domains: zettel.zettel.domains,
        topics: zettel.zettel.topics,
        knowledgeType: zettel.zettel.knowledgeType,
        contextSource: zettel.zettel.contextSource,
        sourceUrl: zettel.zettel.sourceUrl,
        provenance: zettel.zettel.provenance,
        created: zettel.zettel.created,
        updated: zettel.zettel.updated,
        relationships: zettel.relationships.map(r => ({
          type: r.type,
          targetId: r.target.id,
          targetTitle: r.target.title,
        })),
      });
    } catch (error) {
      log.error('Get zettel failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/v1/zettels/:id — Update zettel content/metadata
  router.patch('/:id', async (req, res) => {
    try {
      const body = patchSchema.parse(req.body);
      const orgId = req.tenant!.organizationId;
      const zettelId = req.params.id;

      // Verify zettel exists and belongs to this org
      const existing = await graph.getZettel(orgId, zettelId);
      if (!existing) {
        res.status(404).json({ error: 'Zettel not found' });
        return;
      }

      // Merge updates
      const updatedProvenance = body.provenance !== undefined
        ? (body.provenance ?? undefined)
        : existing.provenance;
      const updated = {
        ...existing,
        title: body.title ?? existing.title,
        content: body.content ?? existing.content,
        domains: body.domains ?? existing.domains,
        topics: body.topics ?? existing.topics,
        sourceUrl: body.sourceUrl !== undefined ? (body.sourceUrl ?? undefined) : existing.sourceUrl,
        provenance: updatedProvenance as SourceProvenance | undefined,
        updated: new Date().toISOString(),
      };

      // Update ArangoDB
      await graph.upsertZettel(updated);

      // If content or title changed, re-embed and update pgvector
      // If only metadata changed (sourceUrl, domains, topics), update chunks without re-embedding
      if (body.content || body.title) {
        // Delete old chunks
        await vectorStore.deleteZettelChunks(orgId, zettelId);

        // Re-chunk and re-embed
        const textChunks = chunkZettelContent(updated.content);
        const chunkTexts = textChunks.map(c => c.content);
        const embeddings = await emb.generateEmbeddings(chunkTexts);

        const pgChunks = textChunks.map((chunk, index) => ({
          id: randomUUID(),
          vector: embeddings[index],
          payload: {
            zettelId: updated.id,
            zettelTitle: updated.title,
            section: chunk.section,
            content: chunk.content,
            chunkIndex: chunk.chunkIndex,
            domains: updated.domains,
            topics: updated.topics,
            knowledgeType: updated.knowledgeType,
            contextSource: updated.contextSource,
            sourceUrl: updated.sourceUrl,
            provenance: updated.provenance,
            created: updated.created,
            updated: updated.updated,
          },
        }));

        await vectorStore.upsertChunks(orgId, pgChunks);
      } else if (body.sourceUrl !== undefined || body.provenance !== undefined || body.domains || body.topics) {
        // Metadata-only update — patch chunks in place without re-embedding
        await vectorStore.updateChunkMetadata(orgId, zettelId, {
          domains: body.domains,
          topics: body.topics,
          sourceUrl: body.sourceUrl,
          provenance: body.provenance,
        });
      }

      res.json({
        id: updated.id,
        title: updated.title,
        content: updated.content,
        domains: updated.domains,
        topics: updated.topics,
        sourceUrl: updated.sourceUrl,
        provenance: updated.provenance,
        updated: updated.updated,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Patch zettel failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/v1/zettels/:id — Delete zettel from both stores
  router.delete('/:id', async (req, res) => {
    try {
      const orgId = req.tenant!.organizationId;
      const zettelId = req.params.id;

      const existing = await graph.getZettel(orgId, zettelId);
      if (!existing) {
        res.status(404).json({ error: 'Zettel not found' });
        return;
      }

      await ingest.deleteZettel(orgId, zettelId);
      res.json({ deleted: true, id: zettelId });
    } catch (error) {
      log.error('Delete zettel failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/zettels — List zettels or get topology for visualization
  // Query params: view=topology, domain=aws, limit=500
  router.get('/', async (req, res) => {
    try {
      const orgId = req.tenant!.organizationId;
      const domain = req.query.domain as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 500, 2000);

      if (req.query.view === 'topology') {
        const topology = await graph.getTopology(orgId, { domain, limit });
        res.json(topology);
        return;
      }

      // Default: list zettels (lightweight, paginated)
      const topology = await graph.getTopology(orgId, { domain, limit });
      res.json({ zettels: topology.nodes, total: topology.total });
    } catch (error) {
      log.error('List zettels failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
