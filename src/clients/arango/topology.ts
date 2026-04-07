import { aql, Database } from 'arangojs';
import { ZETTELS_COLLECTION, RELATIONSHIPS_COLLECTION } from './shared.js';
import type { GraphTopology } from '../../types/stores.js';

/** GraphTopology implementation backed by ArangoDB */
export function createTopology(db: Database): GraphTopology {
  return {
    async getTopology(
      organizationId: string,
      options?: { domain?: string; limit?: number }
    ): Promise<{
      nodes: Array<{ id: string; title: string; domains: string[]; topics: string[]; knowledgeType: string }>;
      edges: Array<{ source: string; target: string; type: string }>;
      total: number;
    }> {
      try {
        const zettelsCollection = db.collection(ZETTELS_COLLECTION);
        const edgesCollection = db.collection(RELATIONSHIPS_COLLECTION);
        const limit = options?.limit ?? 500;
        const domain = options?.domain;

        const nodesCursor = domain
          ? await db.query(aql`
              FOR z IN ${zettelsCollection}
              FILTER z.organizationId == ${organizationId}
              FILTER ${domain} IN z.domains
              LIMIT ${limit}
              RETURN { id: z._key, title: z.title, domains: z.domains, topics: z.topics, knowledgeType: z.knowledgeType }
            `)
          : await db.query(aql`
              FOR z IN ${zettelsCollection}
              FILTER z.organizationId == ${organizationId}
              LIMIT ${limit}
              RETURN { id: z._key, title: z.title, domains: z.domains, topics: z.topics, knowledgeType: z.knowledgeType }
            `);
        const nodes = await nodesCursor.all();
        const nodeIds = new Set(nodes.map((n: any) => n.id));

        const edgesCursor = await db.query(aql`
          FOR e IN ${edgesCollection}
          LET src = SPLIT(e._from, '/')[1]
          LET tgt = SPLIT(e._to, '/')[1]
          FILTER src IN ${[...nodeIds]} AND tgt IN ${[...nodeIds]}
          RETURN { source: src, target: tgt, type: e.type }
        `);
        const edges = await edgesCursor.all();

        const countCursor = domain
          ? await db.query(aql`
              FOR z IN ${zettelsCollection}
              FILTER z.organizationId == ${organizationId}
              FILTER ${domain} IN z.domains
              COLLECT WITH COUNT INTO total
              RETURN total
            `)
          : await db.query(aql`
              FOR z IN ${zettelsCollection}
              FILTER z.organizationId == ${organizationId}
              COLLECT WITH COUNT INTO total
              RETURN total
            `);
        const total = await countCursor.next() as number;

        return { nodes, edges, total };
      } catch (error) {
        console.error('❌ Failed to get topology:', error);
        throw error;
      }
    },

    async getTopologyOverview(organizationId: string): Promise<{
      clusters: Array<{ domain: string; count: number; topTopics: string[] }>;
      bridges: Array<{ source: string; target: string; count: number }>;
      totalZettels: number;
      totalEdges: number;
    }> {
      try {
        const zettelsCollection = db.collection(ZETTELS_COLLECTION);
        const edgesCollection = db.collection(RELATIONSHIPS_COLLECTION);

        const clusterCursor = await db.query(aql`
          FOR z IN ${zettelsCollection}
          FILTER z.organizationId == ${organizationId}
          FOR d IN (z.domains || [])
          COLLECT domain = d INTO group
          LET topics = (
            FOR t IN FLATTEN(group[*].z.topics)
            COLLECT topic = t WITH COUNT INTO cnt
            SORT cnt DESC
            LIMIT 5
            RETURN { topic: topic, count: cnt }
          )
          SORT LENGTH(group) DESC
          RETURN { domain, count: LENGTH(group), topTopics: topics }
        `);
        const clusters = await clusterCursor.all();

        const bridgeCursor = await db.query(aql`
          FOR e IN ${edgesCollection}
          LET srcDoc = DOCUMENT(e._from)
          LET tgtDoc = DOCUMENT(e._to)
          FILTER srcDoc != null AND tgtDoc != null
          FILTER srcDoc.organizationId == ${organizationId}
          LET srcDomain = (srcDoc.domains || [])[0]
          LET tgtDomain = (tgtDoc.domains || [])[0]
          FILTER srcDomain != null AND tgtDomain != null AND srcDomain != tgtDomain
          COLLECT src = srcDomain, tgt = tgtDomain WITH COUNT INTO cnt
          FILTER cnt >= 3
          SORT cnt DESC
          LIMIT 50
          RETURN { source: src, target: tgt, count: cnt }
        `);
        const bridges = await bridgeCursor.all();

        const totalCursor = await db.query(aql`
          LET zCount = LENGTH(FOR z IN ${zettelsCollection} FILTER z.organizationId == ${organizationId} RETURN 1)
          LET eCount = LENGTH(
            FOR e IN ${edgesCollection}
            LET srcDoc = DOCUMENT(e._from)
            FILTER srcDoc != null AND srcDoc.organizationId == ${organizationId}
            RETURN 1
          )
          RETURN { zettels: zCount, edges: eCount }
        `);
        const totals = await totalCursor.next() as { zettels: number; edges: number };

        return {
          clusters,
          bridges,
          totalZettels: totals.zettels,
          totalEdges: totals.edges,
        };
      } catch (error) {
        console.error('❌ Failed to get topology overview:', error);
        throw error;
      }
    },

    async getDomainCounts(organizationId: string): Promise<
      Array<{ domain: string; count: number }>
    > {
      try {
        const zettelsCollection = db.collection(ZETTELS_COLLECTION);
        const cursor = await db.query(aql`
          FOR z IN ${zettelsCollection}
          FILTER z.organizationId == ${organizationId}
          FOR d IN (z.domains || [])
          COLLECT domain = d WITH COUNT INTO cnt
          SORT cnt DESC
          RETURN { domain, count: cnt }
        `);
        return await cursor.all();
      } catch (error) {
        console.error('❌ Failed to get domain counts:', error);
        return [];
      }
    },

    async getNeighborhood(
      organizationId: string,
      zettelId: string,
      depth: number = 2,
      limit: number = 100
    ): Promise<{
      nodes: Array<{ id: string; title: string; domains: string[]; topics: string[]; knowledgeType: string; depth: number }>;
      edges: Array<{ source: string; target: string; type: string }>;
      center: string;
    }> {
      try {
        const zettelsCollection = db.collection(ZETTELS_COLLECTION);
        const edgesCollection = db.collection(RELATIONSHIPS_COLLECTION);

        const cursor = await db.query(aql`
          LET centerDoc = DOCUMENT(${zettelsCollection}, ${zettelId})
          LET traversed = (
            FOR v, e, p IN 1..${depth} ANY CONCAT("zettels/", ${zettelId}) ${edgesCollection}
            FILTER v.organizationId == ${organizationId}
            LIMIT ${limit}
            RETURN DISTINCT {
              node: { id: v._key, title: v.title, domains: v.domains, topics: v.topics, knowledgeType: v.knowledgeType, depth: LENGTH(p.edges) },
              edge: e ? { source: SPLIT(e._from, '/')[1], target: SPLIT(e._to, '/')[1], type: e.type } : null
            }
          )
          LET centerNode = { id: centerDoc._key, title: centerDoc.title, domains: centerDoc.domains, topics: centerDoc.topics, knowledgeType: centerDoc.knowledgeType, depth: 0 }
          RETURN {
            nodes: APPEND([centerNode], traversed[*].node),
            edges: traversed[* FILTER CURRENT.edge != null].edge
          }
        `);
        const result = await cursor.next() as { nodes: any[]; edges: any[] };

        return {
          nodes: result?.nodes || [],
          edges: result?.edges || [],
          center: zettelId,
        };
      } catch (error) {
        console.error('❌ Failed to get neighborhood:', error);
        throw error;
      }
    },
  };
}
