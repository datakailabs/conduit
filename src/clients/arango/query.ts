import { aql, Database } from 'arangojs';
import { ZETTELS_COLLECTION, docToZettel } from './shared.js';
import type { GraphQuery, ZettelNode } from '../../types/stores.js';

/** GraphQuery implementation backed by ArangoDB */
export function createQuery(db: Database): GraphQuery {
  return {
    async getZettelsByTopic(
      organizationId: string,
      topic: string,
      limit: number = 50
    ): Promise<ZettelNode[]> {
      const collection = db.collection(ZETTELS_COLLECTION);

      try {
        const cursor = await db.query(aql`
          FOR z IN ${collection}
          FILTER z.organizationId == ${organizationId}
          FILTER ${topic} IN z.topics
          SORT z.updated DESC
          LIMIT ${limit}
          RETURN z
        `);

        const docs = await cursor.all();
        return docs.map(docToZettel);
      } catch (error) {
        console.error(`❌ Failed to get Zettels by topic ${topic}:`, error);
        throw error;
      }
    },

    async getZettelsByDomain(
      organizationId: string,
      domain: string,
      limit: number = 50
    ): Promise<ZettelNode[]> {
      const collection = db.collection(ZETTELS_COLLECTION);

      try {
        const cursor = await db.query(aql`
          FOR z IN ${collection}
          FILTER z.organizationId == ${organizationId}
          FILTER ${domain} IN z.domains
          SORT z.updated DESC
          LIMIT ${limit}
          RETURN z
        `);

        const docs = await cursor.all();
        return docs.map(docToZettel);
      } catch (error) {
        console.error(`❌ Failed to get Zettels by domain ${domain}:`, error);
        throw error;
      }
    },
  };
}
