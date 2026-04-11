#!/bin/bash
# Export a Conduit knowledge domain as a .ckp (Knowledge Pack) file
# Usage: ./scripts/export-pack.sh <domain> [output_dir]
#
# Example:
#   ./scripts/export-pack.sh snowflake ./packs/
#   → creates ./packs/snowflake-2026.03.ckp

set -euo pipefail

DOMAIN="${1:?Usage: export-pack.sh <domain> [output_dir]}"
OUTPUT_DIR="${2:-.}"
DATE=$(date +%Y.%m)
PACK_NAME="${DOMAIN}-${DATE}"
WORK_DIR=$(mktemp -d)

# Database config (from env or defaults)
PG_HOST="${POSTGRES_HOST:-localhost}"
PG_PORT="${POSTGRES_PORT:-5434}"
PG_USER="${POSTGRES_USER:-conduit}"
PG_PASS="${POSTGRES_PASSWORD:-your-password}"
PG_DB="${POSTGRES_DB:-conduit}"

ARANGO_HOST="${ARANGO_HOST:-localhost}"
ARANGO_PORT="${ARANGO_PORT:-8529}"
ARANGO_PASS="${ARANGO_PASSWORD:-your-password}"
ARANGO_DB="conduit"

echo "=== Exporting knowledge pack: ${DOMAIN} ==="
echo "  Working dir: ${WORK_DIR}"
echo ""

# ─── Step 1: Export zettels from ArangoDB ─────────────────────────────

echo "Step 1: Exporting zettels from ArangoDB..."

curl -s -u "root:${ARANGO_PASS}" "http://${ARANGO_HOST}:${ARANGO_PORT}/_db/${ARANGO_DB}/_api/cursor" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"FOR z IN zettels FILTER '${DOMAIN}' IN z.domains RETURN { id: z._key, title: z.title, content: z.content, summary: z.summary, domains: z.domains, topics: z.topics, knowledge_type: z.knowledgeType, context_source: z.contextSource, source_url: z.sourceUrl, provenance: z.provenance, created: z.created, updated: z.updated }\", \"batchSize\": 10000}" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('result', [])
with open('${WORK_DIR}/zettels.jsonl', 'w') as f:
    for z in results:
        f.write(json.dumps(z, ensure_ascii=False) + '\n')
print(f'  Exported {len(results)} zettels')
"

# ─── Step 2: Export relationships from ArangoDB ───────────────────────

echo "Step 2: Exporting relationships..."

curl -s -u "root:${ARANGO_PASS}" "http://${ARANGO_HOST}:${ARANGO_PORT}/_db/${ARANGO_DB}/_api/cursor" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"LET zettel_ids = (FOR z IN zettels FILTER '${DOMAIN}' IN z.domains RETURN z._id) FOR r IN relationships FILTER r._from IN zettel_ids OR r._to IN zettel_ids RETURN { source: SPLIT(r._from, '/')[1], target: SPLIT(r._to, '/')[1], type: r.type, properties: { how: r.how, why: r.why, where: r.where, domain: r.domain } }\", \"batchSize\": 50000}" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('result', [])
with open('${WORK_DIR}/relationships.jsonl', 'w') as f:
    for r in results:
        # Clean null properties
        if r.get('properties'):
            r['properties'] = {k: v for k, v in r['properties'].items() if v is not None}
            if not r['properties']:
                del r['properties']
        f.write(json.dumps(r, ensure_ascii=False) + '\n')
print(f'  Exported {len(results)} relationships')
"

# ─── Step 3: Build manifest ──────────────────────────────────────────

echo "Step 3: Building manifest..."

ZETTEL_COUNT=$(wc -l < "${WORK_DIR}/zettels.jsonl")
REL_COUNT=$(wc -l < "${WORK_DIR}/relationships.jsonl")

# Extract topics from zettels
TOPICS_JSON=$(python3 -c "
import json, sys
from collections import Counter
topics = Counter()
with open('${WORK_DIR}/zettels.jsonl') as f:
    for line in f:
        z = json.loads(line)
        for t in z.get('topics', []):
            topics[t] += 1
# Top 30 topics
for topic, count in topics.most_common(30):
    print(f'{topic} = {count}')
")

# Extract knowledge types
KTYPES=$(python3 -c "
import json
from collections import Counter
ktypes = Counter()
with open('${WORK_DIR}/zettels.jsonl') as f:
    for line in f:
        z = json.loads(line)
        kt = z.get('knowledge_type', 'concept')
        ktypes[kt] += 1
print(json.dumps(sorted(ktypes.keys())))
")

# Extract unique domains
DOMAINS=$(python3 -c "
import json
domains = set()
with open('${WORK_DIR}/zettels.jsonl') as f:
    for line in f:
        z = json.loads(line)
        for d in z.get('domains', []):
            domains.add(d)
print(json.dumps(sorted(domains)))
")

cat > "${WORK_DIR}/pack.toml" << TOML
[pack]
id = "${DOMAIN}"
name = "$(echo ${DOMAIN} | sed 's/-/ /g' | sed 's/\b\(.\)/\u\1/g')"
version = "${DATE}"
description = "${DOMAIN} domain knowledge — extracted from vendor documentation and curated sources"
authors = ["DataKai <packs@datakai.com>"]
license = "CC-BY-4.0"
homepage = "https://github.com/datakailabs/knowledge-packs"

[pack.stats]
zettels = ${ZETTEL_COUNT}
relationships = ${REL_COUNT}
domains = ${DOMAINS}
knowledge_types = ${KTYPES}

[pack.topics]
${TOPICS_JSON}

[pack.source]
type = "vendor-doc"
crawled_at = "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

[pack.embeddings]
model = "text-embedding-3-small"
dimensions = 1536
included = false

[pack.compatibility]
conduit_min = "1.0"
conduit_max = ""
TOML

echo "  Manifest written"

# ─── Step 4: Package as .ckp ─────────────────────────────────────────

echo "Step 4: Packaging..."

mkdir -p "${OUTPUT_DIR}"
tar -czf "${OUTPUT_DIR}/${PACK_NAME}.ckp" -C "${WORK_DIR}" pack.toml zettels.jsonl relationships.jsonl

SIZE=$(du -h "${OUTPUT_DIR}/${PACK_NAME}.ckp" | cut -f1)
echo ""
echo "=== Pack exported ==="
echo "  File: ${OUTPUT_DIR}/${PACK_NAME}.ckp"
echo "  Size: ${SIZE}"
echo "  Zettels: ${ZETTEL_COUNT}"
echo "  Relationships: ${REL_COUNT}"

# Cleanup
rm -rf "${WORK_DIR}"
