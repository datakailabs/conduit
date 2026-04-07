import { aql, Database } from 'arangojs';
import { ZETTELS_COLLECTION, RELATIONSHIPS_COLLECTION, GRAPH_NAME, docToZettel } from './shared.js';
import type { GraphTraversal, ZettelNode, ZettelWithRelationships } from '../../types/stores.js';

/** GraphTraversal implementation backed by ArangoDB */
export function createTraversal(db: Database): GraphTraversal {
  return {
    async getZettelWithRelationships(
      organizationId: string,
      id: string,
      depth: number = 1
    ): Promise<ZettelWithRelationships | null> {
      try {
        const cursor = await db.query(aql`
          LET zettel = DOCUMENT(${`${ZETTELS_COLLECTION}/${id}`})
          FILTER zettel != null
          FILTER zettel.organizationId == ${organizationId}
          LET relationships = (
            FOR v, e IN 1..${depth} ANY zettel
            GRAPH ${GRAPH_NAME}
            FILTER v.organizationId == ${organizationId}
            RETURN {
              type: e.type,
              target: v,
              properties: UNSET(e, "_id", "_key", "_from", "_to", "_rev", "type", "organizationId")
            }
          )
          RETURN {
            zettel: zettel,
            relationships: relationships
          }
        `);

        const result = await cursor.next();
        if (!result || !result.zettel) return null;

        return {
          zettel: docToZettel(result.zettel),
          relationships: result.relationships.map((r: any) => ({
            type: r.type,
            target: docToZettel(r.target),
            properties: r.properties,
          })),
        };
      } catch (error) {
        console.error(`❌ Failed to get Zettel with relationships ${id}:`, error);
        throw error;
      }
    },

    async traverseGraph(
      organizationId: string,
      startId: string,
      depth: number = 2
    ): Promise<ZettelNode[]> {
      try {
        const cursor = await db.query(aql`
          FOR v IN 1..${depth} ANY
            DOCUMENT(${`${ZETTELS_COLLECTION}/${startId}`})
            GRAPH ${GRAPH_NAME}
            OPTIONS { uniqueVertices: "global", order: "bfs" }
          FILTER v.organizationId == ${organizationId}
          RETURN DISTINCT v
        `);

        const docs = await cursor.all();
        return docs.map(docToZettel);
      } catch (error) {
        console.error(`❌ Failed to traverse graph from ${startId}:`, error);
        throw error;
      }
    },

    async findBySharedTopics(
      organizationId: string,
      topics: string[],
      domains: string[],
      excludeIds: string[],
      limit: number = 5
    ): Promise<Array<ZettelNode & { sharedCount: number }>> {
      if (topics.length === 0 && domains.length === 0) return [];

      const collection = db.collection(ZETTELS_COLLECTION);

      try {
        const cursor = await db.query(aql`
          FOR z IN ${collection}
          FILTER z.organizationId == ${organizationId}
          FILTER z._key NOT IN ${excludeIds}
          LET sharedTopics = LENGTH(INTERSECTION(z.topics, ${topics}))
          LET sharedDomains = LENGTH(INTERSECTION(z.domains, ${domains}))
          LET shared = sharedTopics * 2 + sharedDomains
          FILTER shared > 0
          SORT shared DESC
          LIMIT ${limit}
          RETURN MERGE(z, { _sharedCount: shared })
        `);

        const docs = await cursor.all();
        return docs.map((doc: any) => ({
          ...docToZettel(doc),
          sharedCount: doc._sharedCount,
        }));
      } catch (error) {
        console.error(`❌ Failed to find by shared topics:`, error);
        return [];
      }
    },

    async findPrerequisitePath(
      organizationId: string,
      fromId: string,
      toId: string
    ): Promise<Array<{ id: string; title: string; type: string }> | null> {
      try {
        const cursor = await db.query(aql`
          FOR path IN OUTBOUND SHORTEST_PATH
            ${`${ZETTELS_COLLECTION}/${fromId}`} TO ${`${ZETTELS_COLLECTION}/${toId}`}
            GRAPH ${GRAPH_NAME}
            OPTIONS { weightAttribute: "order" }
            FILTER path.edges[*].type ALL == "REQUIRES"
          RETURN {
            vertices: path.vertices[*],
            edges: path.edges[*]
          }
        `);

        const result = await cursor.next();
        if (!result || !result.vertices || result.vertices.length === 0) return null;

        const vertices = result.vertices.filter(
          (v: any) => !v.organizationId || v.organizationId === organizationId
        );
        if (vertices.length !== result.vertices.length) return null;

        return vertices.map((node: any, index: number) => ({
          id: node._key || node.id,
          title: node.title,
          type: result.edges[index]?.type || 'START',
        }));
      } catch (error) {
        console.error(`❌ Failed to find prerequisite path from ${fromId} to ${toId}:`, error);
        throw error;
      }
    },
  };
}
