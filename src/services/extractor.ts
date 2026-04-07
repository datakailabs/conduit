import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { extractionConfig } from '../config.js';
import { postgres } from '../clients/postgres.js';
import { embeddingsService } from './embeddings/index.js';
import { ingestionService } from './ingestion.js';
import { arangoClient } from '../clients/arango/index.js';
import type { VectorStore, GraphCRUD, RelationshipType } from '../types/stores.js';
import type { EmbeddingsProvider } from './embeddings/types.js';
import type { IngestionService } from './ingestion.js';
import type { SourceProvenance } from '../types/provenance.js';
import { enrichDomains } from './connectors/domain-enrichment.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface ExtractedUnit {
  title: string;
  content: string;
  domains: string[];
  topics: string[];
  knowledgeType: 'concept' | 'pattern' | 'antipattern' | 'principle' | 'technique' | 'gotcha' | 'tool' | 'reference';
  contextSource: 'experience' | 'research' | 'discussion' | 'article' | 'vendor-doc' | 'project';
  confidence: number;
  relationships: Array<{
    type: 'EXTENDS' | 'REQUIRES' | 'APPLIES' | 'CONTRADICTS' | 'IMPLEMENTS';
    targetTitle: string;
    reason: string;
  }>;
}

interface LLMExtractionResponse {
  units: ExtractedUnit[];
  discardedCount: number;
  summary: string;
}

export interface ExtractionUnitResult {
  id: string;
  title: string;
  knowledgeType: string;
  domains: string[];
  topics: string[];
  isDuplicate: boolean;
  duplicateOf?: string;
  similarityScore?: number;
  ingested?: boolean;
}

export interface ExtractionResult {
  extracted: number;
  novel: number;
  duplicates: number;
  discarded: number;
  units: ExtractionUnitResult[];
  summary: string;
  dryRun: boolean;
}

export interface ExtractOptions {
  contextSource?: string;
  domainHints?: string[];
  maxUnits?: number;
  ingest?: boolean;
  sourceUrl?: string;
  provenance?: SourceProvenance;
}

// ─── Extraction Prompt ────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction engine. Your job is to identify discrete, reusable knowledge units from raw text (session transcripts, documents, CCC files).

## What to Extract
- **Concepts**: Definitions, fundamentals, core ideas that ground understanding
- **Patterns**: Recurring approaches, design patterns, implementation strategies
- **Antipatterns**: Common mistakes, known failure modes, approaches that seem right but cause problems
- **Principles**: Guidelines, best practices, rules of thumb, trade-off resolutions
- **Techniques**: Specific methods, workflows, deployment procedures, migration strategies
- **Gotchas**: Surprising behaviors, non-obvious pitfalls, edge cases that catch people off guard
- **Tools**: Technology-specific knowledge, library usage, platform capabilities
- **References**: Authoritative sources, documentation pointers, specification details

## What to Filter Out (Operational Noise)
- File paths, commit hashes, PR numbers
- Routine actions ("opened file", "ran tests", "committed changes")
- Temporary state (TODOs, in-progress items, session-specific context)
- Conversational filler ("let me check", "sounds good")

## Output Format
Return a JSON object with this exact structure:
{
  "units": [
    {
      "title": "5-10 word descriptive title",
      "content": "2-4 paragraphs of self-contained knowledge. Should be understandable without the original context. Include the WHY, not just the WHAT.",
      "domains": ["broad-category"],
      "topics": ["specific-topic-1", "specific-topic-2", "specific-topic-3"],
      "knowledgeType": "concept|pattern|antipattern|principle|technique|gotcha|tool|reference",
      "contextSource": "experience|research|discussion|article|vendor-doc|project",
      "confidence": 0.0-1.0,
      "relationships": [
        {
          "type": "EXTENDS|REQUIRES|APPLIES|CONTRADICTS|IMPLEMENTS",
          "targetTitle": "title of related concept (human-readable)",
          "reason": "why this relationship exists"
        }
      ]
    }
  ],
  "discardedCount": 0,
  "summary": "One sentence summarizing what was extracted"
}

## Rules
- Each unit MUST be self-contained — readable without surrounding context
- Topics MUST have at least 3 items
- Confidence below 0.5 means you're unsure — discard those and count them in discardedCount
- Relationships reference other concepts by human-readable title (we resolve IDs later)
- Do NOT extract trivially obvious information
- Do NOT create duplicate units from the same text
- Domains MUST be lowercase, hyphenated, 2-31 chars matching ^[a-z][a-z0-9-]+$. Max 3 per unit.
- Use BROAD domains only: data-engineering, aws, snowflake, databricks, security, genai, machine-learning, streaming, data-governance, architecture, infrastructure, cloud, devops
- Tool/service names are TOPICS not domains (spark, kafka, terraform, redshift, s3, dbt, mlflow → put these in topics)
- AWS service names are TOPICS not domains (redshift, s3, iam, glue, athena, emr, kinesis → topics under "aws" domain)`;

// ─── Service ──────────────────────────────────────────────────────────────

export class ExtractorService {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private dedupThreshold: number;
  private vectorStore: VectorStore;
  private graphStore: GraphCRUD;
  private embeddings: EmbeddingsProvider;
  private ingestion: IngestionService;

  constructor(deps?: {
    client?: OpenAI;
    vectorStore?: VectorStore;
    graphStore?: GraphCRUD;
    embeddings?: EmbeddingsProvider;
    ingestion?: IngestionService;
    model?: string;
    maxTokens?: number;
    dedupThreshold?: number;
  }) {
    this.client = deps?.client ?? new OpenAI(extractionConfig.clientConfig);
    this.model = deps?.model ?? extractionConfig.model;
    this.maxTokens = deps?.maxTokens ?? extractionConfig.maxTokens;
    this.dedupThreshold = deps?.dedupThreshold ?? extractionConfig.dedupThreshold;
    this.vectorStore = deps?.vectorStore ?? postgres;
    this.graphStore = deps?.graphStore ?? arangoClient;
    this.embeddings = deps?.embeddings ?? embeddingsService;
    this.ingestion = deps?.ingestion ?? ingestionService;
  }

  async extract(
    orgId: string,
    text: string,
    options: ExtractOptions = {}
  ): Promise<ExtractionResult> {
    const {
      contextSource = 'experience',
      domainHints = [],
      maxUnits = 20,
      ingest = true,
    } = options;

    // 1. Call LLM for extraction
    const llmResponse = await this.callLLM(text, contextSource, domainHints, maxUnits);

    // 2. Filter by confidence
    const confident = llmResponse.units.filter(u => u.confidence >= 0.5);
    const discarded = llmResponse.discardedCount + (llmResponse.units.length - confident.length);

    // 3. Pad topics if needed (ensure >= 3), enrich domains, enforce format
    const DOMAIN_REGEX = /^[a-z][a-z0-9-]{1,30}$/;
    for (const unit of confident) {
      while (unit.topics.length < 3) {
        unit.topics.push(unit.domains[0] || 'general');
      }
      // Enrich domains with keyword-based tagging (e.g. detect genai from content)
      unit.domains = enrichDomains(unit.title, unit.content, unit.domains);
      // Enforce domain format contract: lowercase, slugified, max 3
      unit.domains = unit.domains
        .map(d => d.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
        .filter(d => DOMAIN_REGEX.test(d))
        .slice(0, 3);
      if (unit.domains.length === 0) unit.domains = ['general'];
    }

    // 4. Dedup and ingest each unit
    const unitResults: ExtractionUnitResult[] = [];
    let novelCount = 0;
    let dupCount = 0;

    for (const unit of confident) {
      const dedupResult = await this.checkDuplicate(orgId, unit);

      if (dedupResult.isDuplicate) {
        dupCount++;
        unitResults.push({
          id: '',
          title: unit.title,
          knowledgeType: unit.knowledgeType,
          domains: unit.domains,
          topics: unit.topics,
          isDuplicate: true,
          duplicateOf: dedupResult.duplicateOf,
          similarityScore: dedupResult.score,
        });
        continue;
      }

      novelCount++;
      const unitId = `zettel-extract-${randomUUID().slice(0, 12)}`;

      if (ingest && !options.contextSource?.startsWith('__dry')) {
        // Resolve relationships to zettel IDs
        const resolvedRelationships = await this.resolveRelationships(orgId, unit.relationships);

        const result = await this.ingestion.ingestKnowledgeUnit(orgId, {
          id: unitId,
          title: unit.title,
          content: unit.content,
          domains: unit.domains,
          topics: unit.topics,
          knowledgeType: unit.knowledgeType,
          contextSource: unit.contextSource,
          relationships: resolvedRelationships,
          sourceUrl: options.sourceUrl,
          provenance: options.provenance,
        });

        unitResults.push({
          id: unitId,
          title: unit.title,
          knowledgeType: unit.knowledgeType,
          domains: unit.domains,
          topics: unit.topics,
          isDuplicate: false,
          similarityScore: dedupResult.score,
          ingested: result.success,
        });
      } else {
        unitResults.push({
          id: unitId,
          title: unit.title,
          knowledgeType: unit.knowledgeType,
          domains: unit.domains,
          topics: unit.topics,
          isDuplicate: false,
          similarityScore: dedupResult.score,
          ingested: false,
        });
      }
    }

    // 5. Second pass: resolve sibling relationships
    // Now that all units from this batch are in pgvector, re-resolve
    // relationships that couldn't find targets on first pass
    if (ingest && novelCount > 1) {
      const ingestedUnits = unitResults.filter((u) => u.ingested && u.id);
      const ingestedIds = new Set(ingestedUnits.map((u) => u.id));

      for (const unit of confident) {
        if (!unit.relationships || unit.relationships.length === 0) continue;

        const matchingResult = unitResults.find((u) => u.title === unit.title && u.ingested);
        if (!matchingResult?.id) continue;

        const resolved = await this.resolveRelationships(orgId, unit.relationships);
        // Only create edges that point to siblings (newly created in this batch)
        const siblingEdges = resolved.filter((r) => ingestedIds.has(r.target));

        if (siblingEdges.length > 0) {
          try {
            await this.graphStore.createRelationships(orgId, matchingResult.id, siblingEdges);
          } catch {
            // Sibling edge creation is best-effort
          }
        }
      }
    }

    return {
      extracted: confident.length,
      novel: novelCount,
      duplicates: dupCount,
      discarded,
      units: unitResults,
      summary: llmResponse.summary,
      dryRun: !ingest,
    };
  }

  private async callLLM(
    text: string,
    contextSource: string,
    domainHints: string[],
    maxUnits: number
  ): Promise<LLMExtractionResponse> {
    const userPrompt = [
      `Extract up to ${maxUnits} knowledge units from the following text.`,
      contextSource !== 'experience' ? `Context source: ${contextSource}` : '',
      domainHints.length > 0 ? `Domain hints: ${domainHints.join(', ')}` : '',
      '',
      '---TEXT START---',
      text,
      '---TEXT END---',
    ].filter(Boolean).join('\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.3,
      max_tokens: this.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { units: [], discardedCount: 0, summary: 'No response from LLM' };
    }

    try {
      const parsed = JSON.parse(content) as LLMExtractionResponse;

      // Validate structure
      if (!Array.isArray(parsed.units)) {
        return { units: [], discardedCount: 0, summary: 'Invalid response structure' };
      }

      // Validate each unit has required fields
      const validUnits = parsed.units.filter(u =>
        typeof u.title === 'string' &&
        typeof u.content === 'string' &&
        Array.isArray(u.domains) &&
        Array.isArray(u.topics) &&
        typeof u.knowledgeType === 'string' &&
        typeof u.confidence === 'number'
      );

      return {
        units: validUnits,
        discardedCount: parsed.discardedCount ?? (parsed.units.length - validUnits.length),
        summary: parsed.summary ?? '',
      };
    } catch {
      console.error('❌ Failed to parse LLM extraction response');
      return { units: [], discardedCount: 0, summary: 'Failed to parse LLM response' };
    }
  }

  private async checkDuplicate(
    orgId: string,
    unit: ExtractedUnit
  ): Promise<{ isDuplicate: boolean; duplicateOf?: string; score: number }> {
    try {
      const textToEmbed = `${unit.title}\n\n${unit.content}`;
      const embedding = await this.embeddings.generateEmbedding(textToEmbed);
      const results = await this.vectorStore.search(orgId, embedding, 1);

      if (results.length === 0) {
        return { isDuplicate: false, score: 0 };
      }

      const topMatch = results[0];
      if (topMatch.score >= this.dedupThreshold) {
        return {
          isDuplicate: true,
          duplicateOf: topMatch.zettelId,
          score: topMatch.score,
        };
      }

      return { isDuplicate: false, score: topMatch.score };
    } catch (error) {
      console.error('⚠️ Dedup check failed, treating as novel:', error);
      return { isDuplicate: false, score: 0 };
    }
  }

  private async resolveRelationships(
    orgId: string,
    relationships: ExtractedUnit['relationships']
  ): Promise<Array<{ type: RelationshipType; target: string; properties?: Record<string, string> }>> {
    const resolved: Array<{ type: RelationshipType; target: string; properties?: Record<string, string> }> = [];

    for (const rel of relationships) {
      try {
        const embedding = await this.embeddings.generateEmbedding(rel.targetTitle);
        const results = await this.vectorStore.search(orgId, embedding, 1);

        if (results.length > 0 && results[0].score >= 0.7) {
          resolved.push({
            type: rel.type,
            target: results[0].zettelId,
            properties: { why: rel.reason },
          });
        }
      } catch {
        // Relationship resolution is best-effort
      }
    }

    return resolved;
  }
}
