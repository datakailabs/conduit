/**
 * Store Interfaces — Dependency Inversion for Data Layer
 *
 * Services depend on these abstractions, not on concrete ArangoDB/PostgreSQL clients.
 * Concrete implementations live in src/clients/.
 *
 * Interface Segregation:
 *   GraphCRUD       — zettel CRUD + relationship management
 *   GraphTraversal  — graph walks, shared-topic expansion, prerequisite paths
 *   GraphQuery      — domain/topic listing queries
 *   GraphTopology   — visualization-oriented endpoints (topology, neighborhood)
 *   GraphStore      — union of all graph interfaces + lifecycle
 *
 * Consumers depend on the narrowest interface they need:
 *   IngestionService → GraphCRUD
 *   GraphRAGService  → GraphTraversal
 *   Zettels route    → GraphCRUD + GraphTopology
 *   Resolvers        → GraphCRUD + GraphTraversal + GraphQuery
 */

import type { SourceProvenance } from './provenance.js';

// ─── Shared Domain Types ──────────────────────────────────────────────

export interface ZettelNode {
  id: string;
  organizationId: string;
  title: string;
  summary?: string;
  content: string;
  created: string;
  updated: string;
  domains: string[];
  topics: string[];
  knowledgeType: string;
  contextSource: string;
  sourceUrl?: string;
  provenance?: SourceProvenance;
}

export type RelationshipType =
  | 'EXTENDS'
  | 'REQUIRES'
  | 'APPLIES'
  | 'CONTRADICTS'
  | 'IMPLEMENTS';

export interface Relationship {
  type: RelationshipType;
  target: string;
  properties?: {
    how?: string;
    why?: string;
    where?: string;
    order?: number;
    pattern?: string;
    domain?: string;
  };
}

export interface ZettelWithRelationships {
  zettel: ZettelNode;
  relationships: Array<{
    type: string;
    target: ZettelNode;
    properties?: Record<string, any>;
  }>;
}

export interface SearchResult {
  score: number;
  zettelId: string;
  zettelTitle: string;
  section: string;
  content: string;
  chunkIndex: number;
  metadata: {
    domains: string[];
    topics: string[];
    knowledgeType: string;
    contextSource: string;
    sourceUrl?: string;
    provenance?: SourceProvenance;
    created: string;
    updated: string;
  };
}

export interface SearchFilter {
  domain?: string;
  topics?: string[];
  knowledgeType?: string;
}

// ─── VectorStore Interface ────────────────────────────────────────────

export interface VectorStore {
  initialize(): Promise<void>;

  upsertChunks(
    organizationId: string,
    chunks: Array<{
      id: string;
      vector: number[];
      payload: {
        zettelId: string;
        zettelTitle: string;
        section: string;
        content: string;
        chunkIndex: number;
        domains: string[];
        topics: string[];
        knowledgeType: string;
        contextSource: string;
        sourceUrl?: string;
        provenance?: SourceProvenance;
        created: string;
        updated: string;
      };
    }>
  ): Promise<void>;

  search(
    organizationId: string,
    vector: number[],
    limit?: number,
    filter?: SearchFilter
  ): Promise<SearchResult[]>;

  deleteZettelChunks(organizationId: string, zettelId: string): Promise<void>;

  updateChunkMetadata(
    organizationId: string,
    zettelId: string,
    metadata: {
      domains?: string[];
      topics?: string[];
      sourceUrl?: string | null;
      provenance?: SourceProvenance | null;
    }
  ): Promise<void>;

  getStats(organizationId?: string): Promise<{
    totalChunks: number;
    totalZettels: number;
    dimensions: number;
  }>;

  close(): Promise<void>;
}

// ─── Graph Store Interfaces (Segregated) ──────────────────────────────

/** Zettel CRUD + relationship management */
export interface GraphCRUD {
  upsertZettel(zettel: ZettelNode): Promise<void>;

  getZettel(organizationId: string, id: string): Promise<ZettelNode | null>;

  deleteZettel(organizationId: string, id: string): Promise<void>;

  createRelationships(
    organizationId: string,
    sourceId: string,
    relationships: Relationship[]
  ): Promise<void>;

  getStats(organizationId?: string): Promise<{
    totalZettels: number;
    totalRelationships: number;
  }>;
}

/** Graph walks, expansion, prerequisite paths */
export interface GraphTraversal {
  getZettelWithRelationships(
    organizationId: string,
    id: string,
    depth?: number
  ): Promise<ZettelWithRelationships | null>;

  traverseGraph(
    organizationId: string,
    startId: string,
    depth?: number
  ): Promise<ZettelNode[]>;

  findBySharedTopics(
    organizationId: string,
    topics: string[],
    domains: string[],
    excludeIds: string[],
    limit?: number
  ): Promise<Array<ZettelNode & { sharedCount: number }>>;

  findPrerequisitePath(
    organizationId: string,
    fromId: string,
    toId: string
  ): Promise<Array<{ id: string; title: string; type: string }> | null>;
}

/** Domain/topic listing queries */
export interface GraphQuery {
  getZettelsByTopic(
    organizationId: string,
    topic: string,
    limit?: number
  ): Promise<ZettelNode[]>;

  getZettelsByDomain(
    organizationId: string,
    domain: string,
    limit?: number
  ): Promise<ZettelNode[]>;
}

/** Topology visualization endpoints */
export interface GraphTopology {
  getTopology(
    organizationId: string,
    options?: { domain?: string; limit?: number }
  ): Promise<{
    nodes: Array<{ id: string; title: string; domains: string[]; topics: string[]; knowledgeType: string }>;
    edges: Array<{ source: string; target: string; type: string }>;
    total: number;
  }>;

  getTopologyOverview(organizationId: string): Promise<{
    clusters: Array<{ domain: string; count: number; topTopics: string[] }>;
    bridges: Array<{ source: string; target: string; count: number }>;
    totalZettels: number;
    totalEdges: number;
  }>;

  getDomainCounts(organizationId: string): Promise<
    Array<{ domain: string; count: number }>
  >;

  getNeighborhood(
    organizationId: string,
    zettelId: string,
    depth?: number,
    limit?: number
  ): Promise<{
    nodes: Array<{ id: string; title: string; domains: string[]; topics: string[]; knowledgeType: string; depth: number }>;
    edges: Array<{ source: string; target: string; type: string }>;
    center: string;
  }>;
}

// ─── Composite Interface ──────────────────────────────────────────────

/** Full graph store — lifecycle + all capabilities */
export interface GraphStore extends GraphCRUD, GraphTraversal, GraphQuery, GraphTopology {
  initialize(): Promise<void>;
  close(): Promise<void>;
}
