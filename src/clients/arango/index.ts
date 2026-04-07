import { Database } from 'arangojs';
import { arangoConfig } from '../../config.js';
import { ZETTELS_COLLECTION, RELATIONSHIPS_COLLECTION, GRAPH_NAME } from './shared.js';
import { createCRUD } from './crud.js';
import { createTraversal } from './traversal.js';
import { createQuery } from './query.js';
import { createTopology } from './topology.js';
import type { GraphStore } from '../../types/stores.js';

// Re-export domain types for backward compatibility
export type { ZettelNode, Relationship, RelationshipType, ZettelWithRelationships } from '../../types/stores.js';

class ArangoGraphStore implements GraphStore {
  private db: Database;
  private initialized = false;

  private crud!: ReturnType<typeof createCRUD>;
  private traversal!: ReturnType<typeof createTraversal>;
  private query!: ReturnType<typeof createQuery>;
  private topology!: ReturnType<typeof createTopology>;

  constructor() {
    this.db = new Database({
      url: arangoConfig.url,
      databaseName: arangoConfig.database,
      auth: {
        username: arangoConfig.username,
        password: arangoConfig.password || '',
      },
    });
    this.buildModules();
  }

  private buildModules(): void {
    this.crud = createCRUD(this.db);
    this.traversal = createTraversal(this.db);
    this.query = createQuery(this.db);
    this.topology = createTopology(this.db);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const systemDb = this.db.database('_system');
      const databases = await systemDb.listDatabases();

      if (!databases.includes(arangoConfig.database)) {
        console.log(`📦 Creating database: ${arangoConfig.database}`);
        await systemDb.createDatabase(arangoConfig.database);
      }

      this.db = this.db.database(arangoConfig.database);
      this.buildModules(); // Rebuild modules with correct db reference

      const zettelsCollection = this.db.collection(ZETTELS_COLLECTION);
      if (!(await zettelsCollection.exists())) {
        console.log(`📦 Creating collection: ${ZETTELS_COLLECTION}`);
        await zettelsCollection.create();

        await zettelsCollection.ensureIndex({
          type: 'persistent',
          fields: ['domains[*]'],
          name: 'idx_domains',
        });
        await zettelsCollection.ensureIndex({
          type: 'persistent',
          fields: ['topics[*]'],
          name: 'idx_topics',
        });
        await zettelsCollection.ensureIndex({
          type: 'persistent',
          fields: ['knowledgeType'],
          name: 'idx_knowledge_type',
        });
      }

      await zettelsCollection.ensureIndex({
        type: 'persistent',
        fields: ['organizationId'],
        name: 'idx_organization_id',
      });

      const relationshipsCollection = this.db.collection(RELATIONSHIPS_COLLECTION);
      if (!(await relationshipsCollection.exists())) {
        console.log(`📦 Creating edge collection: ${RELATIONSHIPS_COLLECTION}`);
        await this.db.createEdgeCollection(RELATIONSHIPS_COLLECTION);
      }

      const graph = this.db.graph(GRAPH_NAME);
      if (!(await graph.exists())) {
        console.log(`📦 Creating graph: ${GRAPH_NAME}`);
        await graph.create([
          {
            collection: RELATIONSHIPS_COLLECTION,
            from: [ZETTELS_COLLECTION],
            to: [ZETTELS_COLLECTION],
          },
        ]);
      }

      this.initialized = true;
      console.log('✅ ArangoDB graph store initialized');
    } catch (error) {
      console.error('❌ Failed to initialize ArangoDB:', error);
      throw error;
    }
  }

  // ─── GraphCRUD ─────────────────────────────────────────────────────
  upsertZettel: GraphStore['upsertZettel'] = (...args) => this.crud.upsertZettel(...args);
  getZettel: GraphStore['getZettel'] = (...args) => this.crud.getZettel(...args);
  deleteZettel: GraphStore['deleteZettel'] = (...args) => this.crud.deleteZettel(...args);
  createRelationships: GraphStore['createRelationships'] = (...args) => this.crud.createRelationships(...args);
  getStats: GraphStore['getStats'] = (...args) => this.crud.getStats(...args);

  // ─── GraphTraversal ────────────────────────────────────────────────
  getZettelWithRelationships: GraphStore['getZettelWithRelationships'] = (...args) => this.traversal.getZettelWithRelationships(...args);
  traverseGraph: GraphStore['traverseGraph'] = (...args) => this.traversal.traverseGraph(...args);
  findBySharedTopics: GraphStore['findBySharedTopics'] = (...args) => this.traversal.findBySharedTopics(...args);
  findPrerequisitePath: GraphStore['findPrerequisitePath'] = (...args) => this.traversal.findPrerequisitePath(...args);

  // ─── GraphQuery ────────────────────────────────────────────────────
  getZettelsByTopic: GraphStore['getZettelsByTopic'] = (...args) => this.query.getZettelsByTopic(...args);
  getZettelsByDomain: GraphStore['getZettelsByDomain'] = (...args) => this.query.getZettelsByDomain(...args);

  // ─── GraphTopology ─────────────────────────────────────────────────
  getTopology: GraphStore['getTopology'] = (...args) => this.topology.getTopology(...args);
  getTopologyOverview: GraphStore['getTopologyOverview'] = (...args) => this.topology.getTopologyOverview(...args);
  getDomainCounts: GraphStore['getDomainCounts'] = (...args) => this.topology.getDomainCounts(...args);
  getNeighborhood: GraphStore['getNeighborhood'] = (...args) => this.topology.getNeighborhood(...args);

  async close(): Promise<void> {
    this.db.close();
  }
}

// Singleton instance
export const arangoClient = new ArangoGraphStore();
