import { aql, Database } from 'arangojs';
import { ZETTELS_COLLECTION, RELATIONSHIPS_COLLECTION, docToZettel } from './shared.js';
import type { GraphCRUD, ZettelNode, Relationship } from '../../types/stores.js';

/** GraphCRUD implementation backed by ArangoDB */
export function createCRUD(db: Database): GraphCRUD {
  return {
    async upsertZettel(zettel: ZettelNode): Promise<void> {
      const collection = db.collection(ZETTELS_COLLECTION);

      try {
        const doc = {
          _key: zettel.id,
          ...zettel,
          created: new Date(zettel.created).toISOString(),
          updated: new Date(zettel.updated).toISOString(),
        };

        const exists = await collection.documentExists(zettel.id);
        if (exists) {
          await collection.update(zettel.id, doc);
        } else {
          await collection.save(doc);
        }

        console.log(`✅ Upserted Zettel node: ${zettel.id}`);
      } catch (error) {
        console.error(`❌ Failed to upsert Zettel ${zettel.id}:`, error);
        throw error;
      }
    },

    async getZettel(organizationId: string, id: string): Promise<ZettelNode | null> {
      const collection = db.collection(ZETTELS_COLLECTION);

      try {
        const exists = await collection.documentExists(id);
        if (!exists) return null;

        const doc = await collection.document(id);
        if (doc.organizationId && doc.organizationId !== organizationId) {
          return null;
        }
        return docToZettel(doc);
      } catch (error) {
        console.error(`❌ Failed to get Zettel ${id}:`, error);
        throw error;
      }
    },

    async deleteZettel(organizationId: string, id: string): Promise<void> {
      const zettelsCollection = db.collection(ZETTELS_COLLECTION);
      const edgesCollection = db.collection(RELATIONSHIPS_COLLECTION);

      try {
        const exists = await zettelsCollection.documentExists(id);
        if (exists) {
          const doc = await zettelsCollection.document(id);
          if (doc.organizationId && doc.organizationId !== organizationId) {
            throw new Error(`Zettel ${id} does not belong to organization ${organizationId}`);
          }
        }

        await db.query(aql`
          FOR e IN ${edgesCollection}
          FILTER e._from == ${`${ZETTELS_COLLECTION}/${id}`}
             OR e._to == ${`${ZETTELS_COLLECTION}/${id}`}
          REMOVE e IN ${edgesCollection}
        `);

        if (exists) {
          await zettelsCollection.remove(id);
        }

        console.log(`✅ Deleted Zettel: ${id}`);
      } catch (error) {
        console.error(`❌ Failed to delete Zettel ${id}:`, error);
        throw error;
      }
    },

    async createRelationships(
      organizationId: string,
      sourceId: string,
      relationships: Relationship[]
    ): Promise<void> {
      const edgeCollection = db.collection(RELATIONSHIPS_COLLECTION);

      try {
        for (const rel of relationships) {
          await db.query(aql`
            FOR e IN ${edgeCollection}
            FILTER e._from == ${`${ZETTELS_COLLECTION}/${sourceId}`}
               AND e._to == ${`${ZETTELS_COLLECTION}/${rel.target}`}
               AND e.type == ${rel.type}
            REMOVE e IN ${edgeCollection}
          `);

          await edgeCollection.save({
            _from: `${ZETTELS_COLLECTION}/${sourceId}`,
            _to: `${ZETTELS_COLLECTION}/${rel.target}`,
            type: rel.type,
            organizationId,
            ...rel.properties,
          });
        }

        console.log(`✅ Created ${relationships.length} relationships for ${sourceId}`);
      } catch (error) {
        console.error(`❌ Failed to create relationships for ${sourceId}:`, error);
        throw error;
      }
    },

    async getStats(organizationId?: string): Promise<{
      totalZettels: number;
      totalRelationships: number;
    }> {
      try {
        if (organizationId) {
          const zettelsCollection = db.collection(ZETTELS_COLLECTION);
          const edgesCollection = db.collection(RELATIONSHIPS_COLLECTION);

          const [zettelCursor, edgeCursor] = await Promise.all([
            db.query(aql`
              FOR z IN ${zettelsCollection}
              FILTER z.organizationId == ${organizationId}
              COLLECT WITH COUNT INTO count
              RETURN count
            `),
            db.query(aql`
              FOR e IN ${edgesCollection}
              FILTER e.organizationId == ${organizationId}
              COLLECT WITH COUNT INTO count
              RETURN count
            `),
          ]);

          const zettelCount = (await zettelCursor.next()) || 0;
          const edgeCount = (await edgeCursor.next()) || 0;

          return { totalZettels: zettelCount, totalRelationships: edgeCount };
        }

        const zettelsCollection = db.collection(ZETTELS_COLLECTION);
        const edgesCollection = db.collection(RELATIONSHIPS_COLLECTION);

        const [zettelCount, edgeCount] = await Promise.all([
          zettelsCollection.count(),
          edgesCollection.count(),
        ]);

        return {
          totalZettels: zettelCount.count,
          totalRelationships: edgeCount.count,
        };
      } catch (error) {
        console.error('❌ Failed to get ArangoDB stats:', error);
        throw error;
      }
    },
  };
}
