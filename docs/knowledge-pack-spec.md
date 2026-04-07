# Knowledge Pack Specification v0.1

## What Is a Knowledge Pack

A knowledge pack is a portable, versioned, installable unit of domain knowledge. It contains zettels (knowledge units), their relationships, pre-computed embeddings, and metadata — everything a Conduit instance needs to make a domain queryable.

Think of it like a Python wheel (`.whl`) for knowledge: self-contained, versioned, platform-independent, installable with one command.

```
conduit install snowflake                    # install from registry
conduit install ./my-company-knowledge.ckp   # install from file
```

## File Format

A knowledge pack is a gzip-compressed tar archive with the extension `.ckp` (Conduit Knowledge Pack).

```
snowflake-2026.03.ckp
├── pack.toml              # Manifest (required)
├── zettels.jsonl           # Zettel documents (required)
├── relationships.jsonl     # Graph edges (required, may be empty)
├── embeddings.bin          # Pre-computed vector embeddings (optional)
├── embeddings.idx          # Embedding index: zettel_id → offset (optional)
└── LICENSE                 # License for the knowledge content (optional)
```

## Manifest — `pack.toml`

```toml
[pack]
id = "snowflake"                              # Unique identifier (lowercase, hyphens)
name = "Snowflake"                            # Human-readable name
version = "2026.03"                           # CalVer (YYYY.MM) or SemVer
description = "Snowflake data platform documentation and architectural patterns"
authors = ["DataKai <packs@datakai.com>"]
license = "CC-BY-4.0"                         # Content license (not code license)
homepage = "https://github.com/datakailabs/knowledge-packs"

[pack.stats]
zettels = 5650
relationships = 4230
domains = ["snowflake", "data-engineering", "cloud"]
knowledge_types = ["concept", "pattern", "technique", "reference", "gotcha"]

[pack.topics]
# Browsable topic index — what's inside this pack
# Each topic lists its zettel count for `conduit inspect`
cortex-search = 180
dynamic-tables = 145
iceberg = 210
external-tables = 95
snowpark = 320
streams = 88
tasks = 75
warehouses = 112
security = 190
sql = 410
data-sharing = 65
cortex-ai = 230
notebooks = 55
git-integration = 40
streamlit = 85

[pack.source]
type = "vendor-doc"                           # Where this knowledge came from
urls = [                                      # Primary source URLs
  "https://docs.snowflake.com",
  "https://github.com/snowflakedb",
]
crawled_at = "2026-03-15T00:00:00Z"          # When sources were last fetched
adapter = "anthology-html"                    # Which Anthology adapter produced this

[pack.embeddings]
model = "text-embedding-3-small"              # Embedding model used
dimensions = 1536                             # Vector dimensions
included = true                               # Whether embeddings.bin is present

[pack.compatibility]
conduit_min = "1.0"                           # Minimum Conduit version
conduit_max = ""                              # Maximum (empty = no cap)
```

## Zettels — `zettels.jsonl`

One JSON object per line. Every zettel is self-contained.

```json
{
  "id": "zettel-snowflake-cortex-search-overview",
  "title": "Snowflake Cortex Search — Hybrid Retrieval Service",
  "content": "Cortex Search is Snowflake's managed retrieval service that combines...",
  "summary": "Managed hybrid search service combining vector and keyword retrieval.",
  "domains": ["snowflake", "genai"],
  "topics": ["cortex-search", "retrieval", "hybrid-search", "vector-search", "rag"],
  "knowledge_type": "concept",
  "context_source": "vendor-doc",
  "source_url": "https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-search/cortex-search-overview",
  "provenance": {
    "type": "url",
    "url": "https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-search/cortex-search-overview",
    "adapter": "anthology-html",
    "fetched_at": "2026-03-15T00:00:00Z",
    "title": "Cortex Search Overview"
  },
  "created": "2026-03-15T00:00:00Z",
  "updated": "2026-03-15T00:00:00Z"
}
```

### Field Reference

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | yes | Globally unique. Convention: `zettel-{pack}-{slug}` |
| `title` | string | yes | 5-15 words |
| `content` | string | yes | Markdown. 2-4 self-contained paragraphs |
| `summary` | string | no | One sentence. Auto-generated if absent |
| `domains` | string[] | yes | Min 1. Broad categories |
| `topics` | string[] | yes | Min 3. Specific concepts |
| `knowledge_type` | enum | yes | concept, pattern, antipattern, principle, technique, gotcha, tool, reference |
| `context_source` | enum | yes | experience, research, discussion, article, vendor-doc, project |
| `source_url` | string | no | Where this knowledge came from |
| `provenance` | object | no | Structured source metadata |
| `created` | ISO 8601 | yes | When the zettel was created |
| `updated` | ISO 8601 | yes | When the zettel was last updated |

## Relationships — `relationships.jsonl`

One JSON object per line. Edges between zettels in this pack or referencing external zettel IDs.

```json
{
  "source": "zettel-snowflake-cortex-search-overview",
  "target": "zettel-snowflake-dynamic-tables",
  "type": "APPLIES",
  "properties": {
    "how": "Cortex Search indexes can be built on top of Dynamic Tables for real-time RAG",
    "domain": "snowflake"
  }
}
```

### Relationship Types

| Type | Meaning |
|------|---------|
| `EXTENDS` | Source extends or builds upon target |
| `REQUIRES` | Source requires target as a prerequisite |
| `APPLIES` | Source applies to or works with target |
| `CONTRADICTS` | Source contradicts or is an alternative to target |
| `IMPLEMENTS` | Source implements or is a concrete form of target |

### Cross-Pack References

Relationships can reference zettels from other installed packs:

```json
{
  "source": "zettel-snowflake-external-tables",
  "target": "zettel-aws-s3-bucket-config",
  "type": "REQUIRES",
  "properties": {
    "how": "Snowflake external tables read from S3 buckets",
    "why": "Cross-cloud data access pattern"
  }
}
```

If the target pack isn't installed, the edge is stored but inactive. When the target pack is installed later, the edge activates automatically.

## Embeddings — `embeddings.bin` + `embeddings.idx`

Pre-computed embeddings avoid the cost of re-embedding on install (~$0.02/1K chunks with text-embedding-3-small, but 250K chunks = $5 and 30+ minutes).

**`embeddings.idx`** — JSON Lines mapping zettel chunks to byte offsets:

```json
{"zettel_id": "zettel-snowflake-cortex-search-overview", "chunk_index": 0, "offset": 0, "length": 6144}
{"zettel_id": "zettel-snowflake-cortex-search-overview", "chunk_index": 1, "offset": 6144, "length": 6144}
```

**`embeddings.bin`** — Raw float32 vectors, concatenated. Each vector is `dimensions × 4` bytes (1536 × 4 = 6144 bytes for text-embedding-3-small).

If `pack.embeddings.included = false`, Conduit generates embeddings on install (slower but always fresh).

If the installing Conduit instance uses a different embedding model, pre-computed embeddings are ignored and regenerated.

## Installation

### Full Install

```bash
conduit install snowflake                    # Everything in the pack
conduit install snowflake-2026.03.ckp        # From local file
```

This:
1. Validates `pack.toml` (version compatibility, required fields)
2. Imports zettels into ArangoDB (`zettels` collection)
3. Imports relationships into ArangoDB (`relationships` edge collection)
4. Chunks zettel content (Conduit's standard chunking)
5. Loads pre-computed embeddings from `embeddings.bin` OR generates fresh embeddings
6. Upserts chunks with embeddings into PostgreSQL (`chunks` table)
7. Records pack metadata in a `knowledge_packs` table for version tracking
8. Creates a Kai scoped to this pack's domains (e.g., `kai_snowflake`)

### Topic-Scoped Install

Install only the parts of a pack you need:

```bash
conduit install aws --topics s3,iam,redshift     # Only S3, IAM, and Redshift knowledge
conduit install aws --topics security             # Only AWS security content
conduit install databricks --topics iceberg,unity-catalog
```

Topic-scoped installation filters zettels at install time — only zettels where **any of their topics** intersect with the requested topics get loaded. Relationships between included zettels are preserved; relationships to excluded zettels become inactive (same as cross-pack references).

This is useful for large packs like `aws` where you may only need a subset of services.

### Inspect a Pack

Browse what's inside before installing:

```bash
conduit inspect aws

  aws v2026.03 — AWS services documentation
  5,307 zettels, 4,100 relationships
  Domains: aws, data-engineering, security

  Topics (15):
    s3 ............... 1,200 zettels
    redshift ......... 1,050 zettels
    iam .............. 890 zettels
    glue ............. 650 zettels
    athena ........... 580 zettels
    emr .............. 420 zettels
    kinesis .......... 310 zettels
    security ......... 450 zettels
    storage .......... 380 zettels
    lambda ........... 290 zettels
    ...

  Install full:   conduit install aws
  Install scoped: conduit install aws --topics s3,iam
```

### Into Embedded Mode (future)

```python
from conduit import LocalConduit

conduit = LocalConduit("./my-knowledge-base")
conduit.install_pack("snowflake-2026.03.ckp")
conduit.install_pack("aws-2026.03.ckp", topics=["s3", "iam"])
retriever = conduit.as_retriever()
```

### Uninstall

```bash
conduit uninstall snowflake                  # Remove entire pack
conduit uninstall aws --topics redshift      # Remove only Redshift knowledge (keep rest)
```

Full uninstall removes all zettels, chunks, relationships, and embeddings with matching pack prefix. Deactivates cross-pack edges that referenced this pack's zettels.

Topic-scoped uninstall removes only zettels matching the specified topics. The pack remains installed with reduced scope.

## Versioning

Packs use **CalVer** (`YYYY.MM`) for vendor documentation (changes monthly with doc updates) or **SemVer** (`1.2.3`) for curated knowledge bases.

```bash
conduit update snowflake                     # Fetch latest version
conduit install snowflake==2026.01           # Install specific version
conduit list                                 # Show installed packs + versions
```

### Update Strategy

Pack updates are **full replacements**, not patches. The install process:
1. Validates new pack
2. Removes old version's data
3. Installs new version
4. Re-activates cross-pack edges

This keeps the format simple. Differential updates (patches) can come later if pack sizes become a problem.

## Building a Pack

### From Anthology (automated)

```bash
# Crawl vendor docs and build pack
anthology build-pack snowflake \
  --sources https://docs.snowflake.com \
  --adapter html \
  --output snowflake-2026.03.ckp
```

Anthology crawls, extracts knowledge units via LLM, builds relationships, generates embeddings, and packages everything.

### From Scriptoria (curated)

```bash
# Export curated zettels as a pack
scriptoria export-pack \
  --domain snowflake \
  --output snowflake-2026.03.ckp
```

Scriptoria exports its validated, human-curated zettels in pack format.

### From Scratch (manual)

Create `pack.toml`, write `zettels.jsonl` and `relationships.jsonl` by hand or script, optionally pre-compute embeddings, then:

```bash
conduit pack build ./my-pack-dir/ --output my-pack-2026.03.ckp
```

## Registry (future)

A public registry for discovering and distributing packs:

```bash
conduit search "snowflake cortex"
conduit install snowflake                    # Fetches from registry
conduit publish ./my-pack-2026.03.ckp        # Publish to registry
```

The registry is a simple HTTP API serving pack metadata and download URLs. Packs themselves can be hosted on GitHub Releases, S3, or any HTTP endpoint.

## Community Contributions

Knowledge packs can accept community contributions:

1. Fork the pack's source repo
2. Add/edit zettels in `zettels.jsonl`
3. Add relationships in `relationships.jsonl`
4. Submit PR — CI validates zettel format, checks for duplicates, runs quality checks via Scriptoria
5. Pack maintainer merges and publishes new version

This is the Scriptoria angle: Scriptoria validates contributed zettels against quality protocols before they enter a pack. The same quality gate that protects Conduit's knowledge graph protects the packs.

## Access Surfaces

The same pack, served through different interfaces. All support optional topic scoping:

| Surface | Full pack | Topic-scoped |
|---------|-----------|-------------|
| **CLI install** | `conduit install aws` | `conduit install aws --topics s3,iam` |
| **CLI query** | `conduit ask "..." --pack aws` | `conduit ask "..." --pack aws --topics s3` |
| **conduit-py** | `ConduitRetriever(pack="aws")` | `ConduitRetriever(pack="aws", topics=["s3", "iam"])` |
| **conduit-mcp** | `conduit_ask(query, pack="aws")` | `conduit_ask(query, pack="aws", topics=["s3"])` |
| **Embedded** | `conduit.install_pack("aws.ckp")` | `conduit.install_pack("aws.ckp", topics=["s3"])` |
| **REST API** | `POST /ask { pack: "aws" }` | `POST /ask { pack: "aws", topics: ["s3"] }` |

Topic scoping can happen at two points:
- **Install time** — only load matching zettels (smaller footprint, less storage)
- **Query time** — all zettels loaded, but retrieval filtered by topic (more flexible, instant topic switching)

## Example Packs

| Pack ID | Source | Zettels | Topics | Description |
|---------|--------|---------|--------|-------------|
| `aws` | docs.aws.amazon.com | ~5,307 | s3, redshift, iam, glue, athena, emr, kinesis, ... | AWS services documentation |
| `snowflake` | docs.snowflake.com | ~5,650 | cortex-search, dynamic-tables, iceberg, snowpark, ... | Snowflake platform documentation |
| `databricks` | docs.databricks.com | ~3,951 | unity-catalog, delta-lake, mlflow, spark, notebooks, ... | Databricks platform documentation |
| `genai` | Various | ~1,692 | rag, embeddings, prompt-engineering, agents, ... | Generative AI patterns and techniques |

These packs already exist as data in Conduit's knowledge graph. Packaging them as `.ckp` files makes them portable and installable.

### Install Patterns

```bash
# Full vendor stack
conduit install aws
conduit install snowflake
conduit install databricks

# Data engineer focused on Snowflake + AWS S3
conduit install snowflake
conduit install aws --topics s3,glue,iam

# ML engineer on Databricks
conduit install databricks --topics mlflow,unity-catalog,spark
conduit install genai

# Just exploring what's available
conduit inspect aws
conduit inspect snowflake --topics
```
