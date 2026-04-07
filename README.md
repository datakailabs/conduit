# Conduit

**The knowledge graph engine.** Graph-augmented retrieval for AI applications.

Conduit combines vector search with knowledge graph traversal to deliver retrieval that understands how concepts relate — not just how they're similar. Install a knowledge pack and query it in 3 lines of Python.

```python
pip install 'conduit-ai[local]'
```

```python
from conduit_ai import LocalConduit

conduit = LocalConduit("./my-knowledge-base")
conduit.install_pack("snowflake-2026.04.ckp")

results = conduit.search("How does Cortex Search work?")
```

## Why Conduit

Every RAG system does vector search — find chunks similar to the query. Conduit does that **plus** graph traversal: when it finds a relevant concept, it walks relationships to discover connected concepts the query didn't mention.

A question about "Iceberg external tables" doesn't just find Iceberg docs — it walks edges to find related IAM configuration, Glue catalog setup, and cross-platform compatibility patterns. That's the difference between keyword-in-context retrieval and knowledge-aware retrieval.

## Quick Start

### Embedded (no server, no infrastructure)

```bash
pip install 'conduit-ai[local]'
```

```python
from conduit_ai import LocalConduit

# Create a local knowledge base (DuckDB under the hood)
conduit = LocalConduit("./my-kb")

# Install a knowledge pack
conduit.install_pack("snowflake-2026.04.ckp")

# Search with graph-augmented retrieval
results = conduit.search("How does dynamic tables work?", limit=5)
for r in results:
    print(f"{r['score']:.3f} [{r['path']}] {r['title']}")

# Use as a LangChain retriever
retriever = conduit.as_retriever()
docs = retriever.invoke("Cortex Search vs Vector Search")
```

### Server (full features)

```bash
git clone https://github.com/datakailabs/conduit.git
cd conduit
cp .env.example .env  # Fill in your values
docker compose up -d  # Start Postgres + ArangoDB
npm ci
npx tsc --skipLibCheck
node dist/src/server.js
```

```bash
# Ask a question
curl -X POST http://localhost:4000/api/v1/ask \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "How does Snowflake Cortex Search work?", "limit": 5}'

# Get raw context (no LLM synthesis)
curl -X POST http://localhost:4000/api/v1/context \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "Delta Live Tables patterns", "limit": 10, "format": "json"}'
```

## Architecture

```
                    ┌──────────────────────────┐
                    │     Conduit Engine        │
                    │                          │
  Query ──────────► │  Vector Search (pgvector) │
                    │         +                │
                    │  Graph Traversal (Arango) │
                    │         +                │
                    │  LLM Synthesis (OpenAI)   │
                    │                          │
                    └──────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         REST API        GraphQL         Python SDK
```

**Retrieval pipeline:**
1. Embed query → vector similarity search → top-K candidates
2. Walk knowledge graph 1-2 hops from candidates → discover related concepts
3. Merge vector results + graph discoveries → rerank by combined score
4. (Optional) Synthesize answer via LLM with graph-augmented context

## Knowledge Packs

Knowledge packs are portable, versioned units of domain knowledge. Install them to make domains instantly queryable.

```bash
# Inspect a pack
conduit inspect snowflake-2026.04.ckp

# Install (full)
conduit install snowflake-2026.04.ckp

# Install (topic-scoped)
conduit install aws-2026.04.ckp --topics s3,iam,redshift
```

Seed packs available at [datakailabs/knowledge-packs](https://github.com/datakailabs/knowledge-packs):

| Pack | Zettels | Topics | Description |
|------|---------|--------|-------------|
| `snowflake` | 5,634 | cortex-search, iceberg, snowpark, ... | Snowflake platform |
| `aws` | 3,466 | s3, redshift, iam, glue, athena, ... | AWS services |
| `databricks` | 4,173 | unity-catalog, delta-lake, mlflow, ... | Databricks platform |
| `genai` | 1,671 | rag, embeddings, prompt-engineering, ... | GenAI patterns |

Build your own packs from any content. See the [Knowledge Pack Spec](docs/knowledge-pack-spec.md).

## Integration

### Python SDK

```bash
pip install conduit-ai                    # API client only
pip install 'conduit-ai[langchain]'       # + LangChain retriever
pip install 'conduit-ai[local]'           # + embedded engine (DuckDB)
pip install 'conduit-ai[all]'             # Everything
```

### LangChain Retriever

```python
from conduit_ai.retriever import ConduitRetriever

retriever = ConduitRetriever(
    api_key="ck_...",
    endpoint="http://localhost:4000",
)

# Drops into any chain
chain = {"context": retriever, "question": RunnablePassthrough()} | prompt | llm
```

### MCP Server (Claude Code, Cursor, Pi, OpenCode)

```bash
pip install conduit-mcp
```

Gives AI coding agents access to your knowledge graph via MCP tools:
- `conduit_ask` — synthesized answers with sources
- `conduit_context` — raw knowledge units with graph relationships
- `conduit_search` — lightweight title/score search

See [conduit-mcp](https://github.com/datakailabs/conduit-mcp) for setup.

### CLI

```bash
conduit ask "How does Cortex Search work?"
conduit inspect snowflake-2026.04.ckp
conduit install snowflake-2026.04.ckp --topics cortex-search,iceberg
conduit list
```

## Deployment Modes

| | Embedded | Server |
|---|---|---|
| **Install** | `pip install 'conduit-ai[local]'` | Docker Compose / k8s |
| **Storage** | DuckDB (single file) | PostgreSQL + ArangoDB |
| **Graph** | In-memory | ArangoDB (full AQL) |
| **LLM** | Bring your own | Built-in (OpenAI/Ollama) |
| **Multi-user** | No | Yes |
| **API** | Python only | REST + GraphQL |
| **Scale** | ~50K zettels | ~500K+ |
| **Use case** | Notebooks, prototypes, CLI | Production, teams, chatbots |

## Tech Stack

- **TypeScript / Node.js** — server runtime
- **PostgreSQL + pgvector** — vector embeddings with HNSW indexes
- **ArangoDB** — knowledge graph with multi-hop traversal
- **OpenAI** — embeddings (text-embedding-3-small) and synthesis
- **DuckDB** — embedded mode storage + vector search
- **GraphQL** — query API for topology, search, and knowledge exploration

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). We welcome knowledge pack contributions, bug fixes, and feature proposals.

## License

Conduit is licensed under [AGPL-3.0](LICENSE). The Python SDK ([conduit-py](https://github.com/datakailabs/conduit-py)) is Apache-2.0.
