# Conduit Architecture

**Created:** 2025-11-19
**Last Updated:** 2026-03-09
**Status:** Active - Phase 2 Complete + Connector Framework, Product Strategy Defined
**Owner:** DataKai

---

## Overview

**Conduit** is the knowledge processing engine of the DataKai stack - the AI infrastructure that powers Modular Knowledge Graphs, which power all DataKai products (Dojo, Navigator, Architect).

### Purpose

Conduit processes curated knowledge from Scriptorium and builds:
- **ArangoDB Graph**: Typed relationships between concepts (prerequisites, extensions, applications)
- **PostgreSQL + pgvector**: Semantic search over knowledge chunks
- **GraphQL API**: Unified interface for products to query both layers

### Tech Stack

| Layer | Technology | Version | License |
|-------|------------|---------|---------|
| API | Apollo Server | 4.x | MIT |
| Vector DB | PostgreSQL + pgvector | 16 | PostgreSQL + Apache 2.0 |
| Graph DB | ArangoDB | 3.12+ | Apache 2.0 |
| Embeddings | OpenAI / Ollama | - | - |
| Runtime | Node.js | 20 LTS | MIT |
| Content Source | Scriptorium Zettels | - | - |

---

## DataKai Knowledge Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                    PRODUCTS (User-Facing)                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │    Dojo      │  │  Navigator   │  │  Architect   │          │
│  │ Cert Prep    │  │ Career Path  │  │ Architecture │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         └──────────────────┼──────────────────┘                  │
│                            ▼                                      │
│                    GraphQL Queries                               │
└────────────────────────────┼──────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              MODULAR KNOWLEDGE GRAPHS (Assets)                   │
├─────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │  aws           │  │  snowflake     │  │  databricks    │   │
│  │  • s3, iam     │  │  • cortex      │  │  • unity-cat   │   │
│  │  • redshift    │  │  • iceberg     │  │  • delta-lake  │   │
│  │  • glue        │  │  • snowpark    │  │  • mlflow      │   │
│  └────────┬───────┘  └────────┬───────┘  └────────┬───────┘   │
│           └────────────────────┼────────────────────┘            │
└────────────────────────────────┼─────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│         CONDUIT (Knowledge Processing Engine)                    │
│              conduit.datakai.net                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  GraphQL API Layer:                                              │
│  • semanticSearch(query, domain?, topics?)                       │
│  • conceptGraph(zettelId, depth)                                 │
│  • prerequisitePath(from, to)                                    │
│  • relatedConcepts(zettelId, relationshipType?)                  │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         ArangoDB (Graph + Document Database)              │  │
│  │  • Zettels as document nodes                              │  │
│  │  • Typed relationships (EXTENDS, REQUIRES, APPLIES)       │  │
│  │  • Cross-domain concept mapping via AQL                   │  │
│  │  • Graph traversal with SHORTEST_PATH                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         PostgreSQL + pgvector (Vector Database)           │  │
│  │  • Zettel embeddings (per-paragraph chunks)               │  │
│  │  • Cosine similarity search via pgvector                  │  │
│  │  • Metadata filtering (domain, topics, knowledge_type)    │  │
│  │  • Supports pgvectorscale for production scale            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                   │
│  Ingestion Pipeline:                                             │
│  • Connectors (filesystem, GitHub, databases — pluggable)        │
│  • Document parser (Markdown, PDF, DOCX, HTML — 3-tier)          │
│  • LLM extraction (knowledge units from raw text)                │
│  • Text chunker (paragraph-based, 6000 char max)                 │
│  • Embeddings generator (OpenAI or Ollama — switchable)          │
│  • PostgreSQL + ArangoDB writers                                 │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                     ▲
                     │
    ┌────────────────┼────────────────┐
    │                │                │
Connectors      Anthology         REST API
(filesystem,    (MCP: ad-hoc      (direct
 GitHub, DB)     URL/PDF/YT)       ingestion)
```

### Inter-Service Communication

```
┌──────────────────────────────────────────────┐
│         AI Agents (Claude Code, Dojo AI)      │
│         Discover + orchestrate via MCP        │
└─────┬──────────┬──────────┬─────────┬────────┘
      │          │          │         │
    MCP        MCP        MCP       MCP
      │          │          │         │
┌─────┴──┐ ┌────┴───┐ ┌────┴──┐ ┌────┴────┐
│  DKOS  │ │Chronicle│ │Arbiter│ │Anthology│
└────────┘ └────┬────┘ └───┬───┘ └────┬────┘
                │          │          │
              REST       REST       REST
                └──────────┴──────────┘
                           │
                    ┌──────┴──────┐
                    │   Conduit   │  ← REST/GraphQL
                    └─────────────┘
```

**Principle:** MCP for AI-agent orchestration, REST for service-to-service.
AI agents discover capabilities via MCP tool descriptions. Services call
each other via typed REST APIs with auth, versioning, and rate limiting.

---

## Core Capabilities

### 0. GraphRAG Retrieval (The Differentiator)

**CRITICAL**: Conduit uses **GraphRAG**, not vanilla RAG. The dual-store
architecture (pgvector + ArangoDB) exists specifically for this:

```
Query → Vector Search (seeds) → Graph Expansion (traverse neighbors)
      → Graph-Aware Re-Ranking → Structured Context Assembly → LLM Synthesis
```

**Why GraphRAG > RAG:**
- Vector search finds *textually similar* content
- Graph traversal finds *structurally related* content (EXTENDS, REQUIRES, APPLIES)
- Relationship topology enables LLM reasoning ("A REQUIRES B, B CONTRADICTS C")
- Graph centrality boosts ranking (connected to 3 hits > connected to 0)

**Endpoints:**
- `POST /api/v1/context` — GraphRAG retrieval (structured context)
- `POST /api/v1/ask` — GraphRAG + LLM synthesis (answers with sources)
- `POST /api/v1/ask?mode=swarm` — Multi-agent debate over graph context (premium)

### 1. Semantic Search (PostgreSQL + pgvector)

**Query**: Natural language search across all knowledge
**Returns**: Ranked chunks with metadata

```graphql
query {
  semanticSearch(
    query: "How does Kafka exactly-once delivery work?"
    domain: "data-engineering"
    topics: ["kafka"]
    limit: 5
  ) {
    score
    zettelId
    zettelTitle
    section
    content
    metadata {
      domains
      topics
      knowledgeType
      contextSource
    }
  }
}
```

**Use cases:**
- Dojo: Find relevant explanations for certification questions
- Navigator: Search learning materials by topic
- Architect: Discover patterns and solutions

---

### 2. Concept Graph (ArangoDB)

**Query**: Graph walk from a concept
**Returns**: Related concepts with typed relationships

```graphql
query {
  conceptGraph(
    zettelId: "zettel-20251116120000-exactly-once-delivery"
    depth: 2
  ) {
    concept {
      id
      title
      summary
    }
    relationships {
      type  # EXTENDS, REQUIRES, APPLIES, CONTRADICTS, IMPLEMENTS
      target {
        id
        title
        summary
      }
      properties {
        how
        why
        where
      }
    }
  }
}
```

**Use cases:**
- Navigator: Build prerequisite learning paths
- Dojo: Show related concepts for deeper learning
- Architect: Explore alternative patterns

---

### 3. Prerequisite Path (ArangoDB)

**Query**: Learning path between concepts
**Returns**: Ordered prerequisite chain

```graphql
query {
  prerequisitePath(
    from: "zettel-basics"
    to: "zettel-advanced-topic"
  ) {
    path {
      zettelId
      title
      relationshipType
    }
    totalSteps
  }
}
```

**Use cases:**
- Navigator: Generate personalized curricula
- Dojo: Identify knowledge gaps
- Architect: Understand concept dependencies

---

## Data Models

### ArangoDB Schema

**Collections:**
- `zettels`: Document collection for Zettel nodes
- `relationships`: Edge collection for typed relationships
- `knowledge_graph`: Named graph combining both

```javascript
// Document: Zettel
{
  _key: 'zettel-20251117161800-ldka-architecture',
  title: 'Log-Driven Knowledge Architecture (LDKA)',
  created: '2025-11-17T16:18:00-05:00',
  updated: '2025-11-17T16:18:00-05:00',
  domains: ['knowledge-systems', 'architecture'],
  topics: ['zettelkasten', 'knowledge-graph', 'event-sourcing'],
  knowledgeType: 'principle',
  contextSource: 'discussion',
  summary: 'Log-Driven Knowledge Architecture applies distributed systems principles...'
}

// Edge: Relationship (in relationships collection)
{
  _from: 'zettels/zettel-a',
  _to: 'zettels/zettel-b',
  type: 'EXTENDS',
  how: 'adds quality gates',
  where: 'between transformation layers'
}
```

**Relationship Types:**
- `EXTENDS`: Builds upon or enhances concept
- `REQUIRES`: Prerequisite knowledge
- `APPLIES`: Uses pattern in new context
- `CONTRADICTS`: Alternative approach
- `IMPLEMENTS`: Concrete realization

**Graph Queries (AQL):**
```aql
// Find related concepts
FOR v, e IN 1..2 OUTBOUND @startNode GRAPH 'knowledge_graph'
  RETURN { node: v, edge: e }

// Shortest path between concepts
FOR v IN OUTBOUND SHORTEST_PATH @from TO @to GRAPH 'knowledge_graph'
  RETURN v
```

---

### PostgreSQL Schema (pgvector)

```sql
-- Chunks table with vector embeddings
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zettel_id TEXT NOT NULL,
  zettel_title TEXT NOT NULL,
  section TEXT,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  embedding vector(1536),  -- OpenAI dimensions (768 for Ollama)

  -- Metadata for filtering
  domains TEXT[],
  topics TEXT[],
  knowledge_type TEXT,
  context_source TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vector similarity index
CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops);
```

**Tables:**
- `chunks`: Zettel chunks with embeddings
- `chunk_stats`: View for aggregated statistics

---

## Ingestion Pipeline

Three input paths feed into a unified ingestion pipeline:

```
┌─────────────────────────────────────────────────────────┐
│                    INPUT SOURCES                         │
├──────────────┬──────────────────┬────────────────────────┤
│  Connectors  │    Anthology     │      REST API          │
│  (stateful,  │   (stateless,    │   (manual, per-doc)    │
│  incremental │    one-shot,     │                        │
│  sync)       │    CLI/MCP)      │  POST /api/v1/extract  │
│              │                  │  POST /graphql ingest  │
│  Filesystem  │  Adapters:       │                        │
│  GitHub*     │   scriptorium    │  URL or raw text       │
│  PostgreSQL* │   markdown-dir   │                        │
│  Web*        │   url-list       │                        │
└──────┬───────┴────────┬─────────┴───────────┬────────────┘
       │                │                     │
       ▼                ▼                     ▼
┌─────────────────────────────────────────────────────────┐
│              DOCUMENT PARSER SERVICE                     │
│                                                          │
│  3-tier resolution:                                      │
│  1. Built-in (zero deps): MD, HTML, TXT, CSV            │
│  2. Docling sidecar (layout-aware): PDF, DOCX, PPTX    │
│  3. npm fallback: pdfjs-dist, mammoth, officeparser     │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                INGESTION SERVICE                         │
│                                                          │
│  1. LLM Knowledge Extraction (optional)                 │
│     - Extract domains, topics, relationships            │
│     - Generate structured frontmatter                   │
│                                                          │
│  2. Text Chunker                                        │
│     - Split by headers and paragraphs                   │
│     - Keep chunks 100-500 words                         │
│     - Maintain section context                          │
│                                                          │
│  3. Embeddings Generator                                │
│     - OpenAI text-embedding-3-small (prod)              │
│     - Ollama nomic-embed-text (dev)                     │
│     - Generate vector for each chunk                    │
│                                                          │
│  4. Dual-Write                                          │
│     - ArangoDB: UPSERT zettel + relationship edges      │
│     - PostgreSQL: UPSERT chunks with vectors            │
└─────────────────────────────────────────────────────────┘
```

### Connector Framework

Connectors provide stateful, incremental sync from external data sources.

**Architecture:**
- `Connector` interface: `validate()`, `discover()`, `sync()` methods
- `ConnectorManager`: registry + orchestration (sync → parse → ingest)
- `DocumentParserService`: routes files to best available parser
- Incremental sync via SHA-256 content hashing in `SyncCursor`
- Deletion detection by comparing current scan against previous cursor

**Available connectors:**
- `filesystem` — recursive directory scanning with glob include/exclude patterns

**REST API:**
- `GET  /api/v1/connectors/types` — list registered connector types
- `POST /api/v1/connectors/discover` — preview source content
- `POST /api/v1/connectors/sync` — full sync cycle with cursor support

### Document Parser Tiers

| Tier | Parser | Formats | Dependencies |
|------|--------|---------|-------------|
| 1 | Built-in | MD, HTML, TXT, CSV | None (zero deps) |
| 2 | Docling sidecar | PDF, DOCX, PPTX, HTML | `docling-serve` container |
| 3 | npm fallback | PDF, DOCX, PPTX, XLSX | Optional: `pdfjs-dist`, `mammoth`, `officeparser` |

Resolution priority: Built-in → Docling (if sidecar detected) → npm fallback.

### Anthology (External)

Anthology is a separate Python CLI/MCP tool for one-shot bulk ingestion. It calls
Conduit's REST API (`POST /api/v1/extract`) and does not live inside Conduit.
See the Anthology project for details.

---

## API Surface

### REST API (`/api/v1/`)

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /auth/signup` | None | Self-service org + API key provisioning |
| `POST /context` | Bearer | GraphRAG retrieval (vector + graph) |
| `POST /ask` | Bearer | LLM synthesis over GraphRAG context (`?mode=swarm`) |
| `POST /extract` | Bearer | LLM knowledge extraction from URL/text |
| `GET/PUT/DELETE /zettels` | Bearer | Zettel CRUD + source inspection |
| `GET /connectors/types` | Bearer | List registered connector types |
| `POST /connectors/discover` | Bearer | Preview source content |
| `POST /connectors/sync` | Bearer | Incremental sync with cursor |
| `GET /dashboard/stats` | Bearer+Admin | Usage statistics |
| `*/organizations` | Platform | Org management |

### GraphQL (`/graphql`)

See `schema.graphql` for complete schema definition.

**Core Types:**
- `Zettel`: Knowledge unit
- `SearchResult`: Semantic search result
- `ConceptGraph`: Graph walk result
- `PrerequisitePath`: Learning path

**Queries:**
- `semanticSearch`: Vector similarity search
- `conceptGraph`: Graph exploration
- `prerequisitePath`: Shortest path between concepts
- `relatedConcepts`: Direct relationships
- `zettel`: Get single Zettel by ID

---

## Deployment

### Development

```bash
# Start dependencies
docker-compose up -d  # PostgreSQL + ArangoDB

# Run Conduit
pnpm install
pnpm dev
```

### Production

- **Hosting**: K3s on Hetzner (via Petra IaC)
- **Domain**: conduit.datakai.net (internal)
- **Registry**: ghcr.io/datakai/conduit
- **Network**: Private (not exposed to internet)
- **Access**: API key authentication (Dojo, Navigator, Architect only)

### CI/CD

Automated via GitHub Actions:
- **CI**: Typecheck → Unit tests → Integration tests (on PR/push)
- **Build**: Docker build → Push to ghcr.io (on main)
- **Release**: Semantic versioning via release-please

---

## Security

**Authentication:**
- Bearer token authentication via `ApiKeyStore` (SHA-256 hashed keys)
- Self-service signup (`POST /api/v1/auth/signup`) with org provisioning
- Platform key for admin operations (org/key management)
- Separate key types: `standard` vs `admin`
- Legacy `OrganizationStore` for backward-compatible GraphQL auth

**Network:**
- Conduit not publicly accessible
- Products → Conduit via private network
- Rate limiting on all endpoints
- Request logging for audit

**Data Privacy:**
- Multi-tenant isolation via `organizationId` on all data
- Content from Scriptorium, connectors, and direct ingestion
- No PII stored in knowledge graph
- GDPR compliant (no user data)

---

## Success Metrics

### Phase 1 (MVP) ✅ Complete

- [x] GraphQL schema and Apollo Server
- [x] Database clients (PostgreSQL + ArangoDB)
- [x] Ingestion pipeline (Zettel → chunks → embeddings)
- [x] Switchable embeddings (OpenAI/Ollama)
- [x] Health endpoint for K8s probes
- [x] Dockerfile and container build

### Phase 2 (Database Migration) ✅ Complete

- [x] Migrate from Qdrant → PostgreSQL + pgvector
- [x] Migrate from Neo4j → ArangoDB
- [x] CI/CD pipeline (GitHub Actions)
- [x] Integration tests with testcontainers
- [x] All workflows green

### Phase 2.5 (Knowledge Extraction) ✅ Complete

- [x] `POST /api/v1/extract` — LLM-powered knowledge extraction
- [x] Dedup via embedding similarity
- [x] Confidence filtering, relationship resolution
- [x] Anthology MCP server integration

### Phase 2.6 (Console + Anthology Pipeline) ✅ Complete

- [x] Conduit Console SPA at `/`
- [x] Self-service signup with hashed API keys
- [x] Anthology → Conduit end-to-end pipeline
- [x] Relevance filtering on context endpoint

### Phase 2.7 (GraphRAG Retrieval) ✅ Complete

- [x] Graph-expanded retrieval (vector seeds → graph walk)
- [x] Graph-aware re-ranking (connectivity boost)
- [x] Structured context assembly (relationship topology)
- [x] `POST /api/v1/ask` — LLM synthesis over GraphRAG context
- [x] Swarm Engine integration for premium answers (`?mode=swarm`)

### Phase 2.8 (Edge Backfill + Source Provenance) ✅ Complete

- [x] Automated edge backfill via LLM analysis
- [x] Structured `SourceProvenance` (url, pdf, database, file, api)
- [x] Dual-write provenance (JSONB) + backward compat `source_url`

### Phase 2.9 (Console UX + Data Hygiene) ✅ Complete

- [x] Knowledge topology (force-directed graph visualization)
- [x] Click-to-edit/delete zettels with provenance editor
- [x] Ask view (chat-style, position-fixed input)
- [x] Domain color legend (collapsible, filterable)
- [x] Org consolidation: all data under `org_datakai`
- [x] Removed fallback hacks, consistent dual-store scoping

### Phase 2.10 (Connector Framework) ✅ Complete

- [x] Pluggable `Connector` interface with discover/sync lifecycle
- [x] `ConnectorManager` with registry + sync-to-ingest orchestration
- [x] 3-tier document parser: built-in → Docling sidecar → npm fallback
- [x] `FilesystemConnector` with incremental sync (SHA-256 hashing)
- [x] REST API: `/api/v1/connectors/{types,discover,sync}`
- [x] Console UI: unified Import view (URL | Text | Connector modes)
- [x] 20 unit tests for parsers, connector, and manager

### Phase 3 (Product Ship + Production Hardening) — NEXT

- [ ] Chat widget (embeddable JS, product last-mile)
- [ ] Docker Compose deployment package (self-hosted)
- [ ] More connectors (GitHub, PostgreSQL, web crawler, Notion)
- [ ] API hardening (rate limiting, caching, observability)
- [ ] Slack/Teams integration
- [ ] E2E testing

### Phase 4 (Knowledge Expansion)

- [ ] RAPTOR pipeline for Anthology (vendor docs)
- [ ] Multi-domain Knowledge Graphs
- [ ] Cross-domain relationship discovery
- [ ] conduit-client TypeScript package
- [ ] Knowledge marketplace

---

See `docs/architecture.svg` for the visual architecture diagram.

*Last Updated: 2026-03-09*
*Next Review: After Phase 3 Product Ship*
