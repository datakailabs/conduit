import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import matter from 'gray-matter';
import { arangoClient } from '../clients/arango/index.js';
import { postgres } from '../clients/postgres.js';
import { embeddingsService } from './embeddings/index.js';
import { chunkZettelContent, extractSummary } from './chunker.js';
import type { VectorStore, GraphCRUD, ZettelNode, Relationship } from '../types/stores.js';
import type { EmbeddingsProvider } from './embeddings/types.js';
import type { SourceProvenance } from '../types/provenance.js';

export interface ZettelFrontmatter {
  id: string;
  title: string;
  created: string;
  updated: string;
  domains: string[];
  topics: string[];
  knowledge_type: string;
  context_source: string;
}

export interface IngestResult {
  success: boolean;
  zettelId?: string;
  chunksCreated: number;
  relationshipsCreated: number;
  error?: string;
}

export class IngestionService {
  private vectorStore: VectorStore;
  private graphStore: GraphCRUD;
  private embeddings: EmbeddingsProvider;

  constructor(deps?: {
    vectorStore?: VectorStore;
    graphStore?: GraphCRUD;
    embeddings?: EmbeddingsProvider;
  }) {
    this.vectorStore = deps?.vectorStore ?? postgres;
    this.graphStore = deps?.graphStore ?? arangoClient;
    this.embeddings = deps?.embeddings ?? embeddingsService;
  }

  /**
   * Ingest a single Zettel from file path, scoped to organization
   */
  async ingestZettel(organizationId: string, filePath: string): Promise<IngestResult> {
    try {
      console.log(`📥 Ingesting Zettel: ${filePath}`);

      // 1. Read and parse file
      const fileContent = readFileSync(filePath, 'utf-8');
      const { data: frontmatter, content } = matter(fileContent);

      // Parse tags into domains and topics if needed
      this.parseTags(frontmatter);

      // Validate frontmatter
      if (!this.validateFrontmatter(frontmatter)) {
        return {
          success: false,
          chunksCreated: 0,
          relationshipsCreated: 0,
          error: 'Invalid frontmatter',
        };
      }

      const fm = frontmatter as unknown as ZettelFrontmatter;

      // 2. Extract summary
      const summary = extractSummary(content);

      // 3. Create ArangoDB node
      const zettelNode: ZettelNode = {
        id: fm.id,
        organizationId,
        title: fm.title,
        summary,
        content,
        created: fm.created,
        updated: fm.updated,
        domains: fm.domains,
        topics: fm.topics,
        knowledgeType: fm.knowledge_type,
        contextSource: fm.context_source,
      };

      await this.graphStore.upsertZettel(zettelNode);

      // 4. Extract and create relationships
      const relationships = this.extractRelationships(content);
      if (relationships.length > 0) {
        await this.graphStore.createRelationships(organizationId, fm.id, relationships);
      }

      // 5. Chunk content
      const textChunks = chunkZettelContent(content);

      // 6. Generate embeddings
      const chunkTexts = textChunks.map((chunk) => chunk.content);
      const embeddings = await this.embeddings.generateEmbeddings(chunkTexts);

      // 7. Prepare PostgreSQL chunks
      const pgChunks = textChunks.map((chunk, index) => ({
        id: randomUUID(),
        vector: embeddings[index],
        payload: {
          zettelId: fm.id,
          zettelTitle: fm.title,
          section: chunk.section,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          domains: fm.domains,
          topics: fm.topics,
          knowledgeType: fm.knowledge_type,
          contextSource: fm.context_source,
          created: fm.created,
          updated: fm.updated,
        },
      }));

      // 8. Upsert to PostgreSQL
      await this.vectorStore.upsertChunks(organizationId, pgChunks);

      console.log(`✅ Successfully ingested: ${fm.id}`);
      console.log(`   - Chunks created: ${pgChunks.length}`);
      console.log(`   - Relationships created: ${relationships.length}`);

      return {
        success: true,
        zettelId: fm.id,
        chunksCreated: pgChunks.length,
        relationshipsCreated: relationships.length,
      };
    } catch (error) {
      console.error(`❌ Failed to ingest Zettel from ${filePath}:`, error);
      return {
        success: false,
        chunksCreated: 0,
        relationshipsCreated: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Validate frontmatter has all required fields
   */
  private validateFrontmatter(frontmatter: any): boolean {
    const required = [
      'id',
      'title',
      'created',
      'updated',
      'domains',
      'topics',
      'knowledge_type',
      'context_source',
    ];

    for (const field of required) {
      if (!(field in frontmatter)) {
        console.error(`Missing required field: ${field}`);
        return false;
      }
    }

    // Validate arrays
    if (!Array.isArray(frontmatter.domains) || frontmatter.domains.length === 0) {
      console.error('domains must be a non-empty array');
      return false;
    }

    if (!Array.isArray(frontmatter.topics) || frontmatter.topics.length < 3) {
      console.error('topics must have at least 3 items');
      return false;
    }

    // Validate enum values
    const validKnowledgeTypes = ['concept', 'pattern', 'antipattern', 'principle', 'technique', 'gotcha', 'tool', 'reference'];
    if (!validKnowledgeTypes.includes(frontmatter.knowledge_type)) {
      console.error(`Invalid knowledge_type: "${frontmatter.knowledge_type}". Must be one of: ${validKnowledgeTypes.join(', ')}`);
      return false;
    }

    const validContextSources = ['experience', 'research', 'discussion', 'article', 'vendor-doc', 'project'];
    if (!validContextSources.includes(frontmatter.context_source)) {
      console.error(`Invalid context_source: "${frontmatter.context_source}". Must be one of: ${validContextSources.join(', ')}`);
      return false;
    }

    // Validate domain format (open taxonomy, format-validated)
    const DOMAIN_REGEX = /^[a-z][a-z0-9-]{1,30}$/;
    for (const d of frontmatter.domains) {
      if (!DOMAIN_REGEX.test(d)) {
        console.error(`Invalid domain format: "${d}". Must be lowercase, hyphenated, 2-31 chars`);
        return false;
      }
    }
    if (frontmatter.domains.length > 3) {
      console.error(`Too many domains: ${frontmatter.domains.length} (max 3)`);
      return false;
    }

    return true;
  }

  /**
   * Parse tags array into domains and topics if needed
   */
  private parseTags(frontmatter: any): void {
    if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
      // Extract domains and topics from tags array
      const domains: string[] = [];
      const topics: string[] = [];

      for (const tag of frontmatter.tags) {
        if (typeof tag === 'string') {
          if (tag.startsWith('domain/')) {
            domains.push(tag.replace('domain/', ''));
          } else if (tag.startsWith('topic/')) {
            topics.push(tag.replace('topic/', ''));
          }
        }
      }

      // Set domains and topics if not already set
      if (!frontmatter.domains && domains.length > 0) {
        frontmatter.domains = domains;
      }
      if (!frontmatter.topics && topics.length > 0) {
        frontmatter.topics = topics;
      }
    }
  }

  /**
   * Extract relationships from ## Related section
   */
  private extractRelationships(content: string): Relationship[] {
    const relationships: Relationship[] = [];
    const lines = content.split('\n');

    let inRelatedSection = false;

    for (const line of lines) {
      // Start of Related section
      if (line.trim() === '## Related') {
        inRelatedSection = true;
        continue;
      }

      // End of Related section (next ## heading)
      if (inRelatedSection && line.startsWith('## ') && line.trim() !== '## Related') {
        break;
      }

      // Parse relationship line
      if (inRelatedSection && line.trim().startsWith('- [[')) {
        const rel = this.parseRelationshipLine(line);
        if (rel) {
          relationships.push(rel);
        }
      }
    }

    return relationships;
  }

  /**
   * Parse a single relationship line
   * Format: - [[zettel-id]] - RELATIONSHIP_TYPE by doing X
   */
  private parseRelationshipLine(line: string): Relationship | null {
    // Extract [[zettel-id]]
    const zettelIdMatch = line.match(/\[\[(zettel-[^\]]+)\]\]/);
    if (!zettelIdMatch) return null;

    const targetId = zettelIdMatch[1];

    // Extract relationship description after the wikilink
    const description = line
      .substring(line.indexOf(']]') + 2)
      .replace(/^[\s-]+/, '')
      .trim();

    // Determine relationship type
    let type: Relationship['type'] = 'EXTENDS'; // default
    const properties: Relationship['properties'] = {};

    if (description.match(/EXTENDS/i)) {
      type = 'EXTENDS';
      const howMatch = description.match(/by\s+(.+?)(?:\s+where|\s+in|$)/i);
      const whereMatch = description.match(/(?:where|in)\s+(.+)$/i);

      if (howMatch) properties.how = howMatch[1].trim();
      if (whereMatch) properties.where = whereMatch[1].trim();
    } else if (description.match(/REQUIRES/i)) {
      type = 'REQUIRES';
      const whyMatch = description.match(/because\s+(.+?)(?:\s+for|$)/i);
      if (whyMatch) properties.why = whyMatch[1].trim();
    } else if (description.match(/APPLIES/i)) {
      type = 'APPLIES';
      const patternMatch = description.match(/pattern[:\s]+([^\s,]+)/i);
      const domainMatch = description.match(/(?:to|in)\s+(.+)$/i);

      if (patternMatch) properties.pattern = patternMatch[1].trim();
      if (domainMatch) properties.domain = domainMatch[1].trim();
    } else if (description.match(/IMPLEMENTS/i)) {
      type = 'IMPLEMENTS';
      const howMatch = description.match(/(?:mechanism|by)\s+(.+)$/i);
      if (howMatch) properties.how = howMatch[1].trim();
    } else if (description.match(/CONTRADICTS/i)) {
      type = 'CONTRADICTS';
    }

    return {
      type,
      target: targetId,
      properties: Object.keys(properties).length > 0 ? properties : undefined,
    };
  }

  /**
   * Ingest a structured knowledge unit directly (no file I/O).
   * Used by the extraction service to persist LLM-extracted knowledge.
   */
  async ingestKnowledgeUnit(organizationId: string, unit: {
    id: string;
    title: string;
    content: string;
    domains: string[];
    topics: string[];
    knowledgeType: string;
    contextSource: string;
    relationships?: Array<{ type: Relationship['type']; target: string; properties?: Record<string, string> }>;
    sourceUrl?: string;
    provenance?: SourceProvenance;
  }): Promise<IngestResult> {
    try {
      const now = new Date().toISOString();

      // 1. Extract summary
      const summary = extractSummary(`# ${unit.title}\n\n${unit.content}`);

      // 2. Create ArangoDB node
      const zettelNode: ZettelNode = {
        id: unit.id,
        organizationId,
        title: unit.title,
        summary,
        content: unit.content,
        created: now,
        updated: now,
        domains: unit.domains,
        topics: unit.topics,
        knowledgeType: unit.knowledgeType,
        contextSource: unit.contextSource,
        sourceUrl: unit.provenance?.url || unit.sourceUrl,
        provenance: unit.provenance,
      };

      await this.graphStore.upsertZettel(zettelNode);

      // 3. Create relationships if provided
      const relationships: Relationship[] = (unit.relationships || []).map(r => ({
        type: r.type,
        target: r.target,
        properties: r.properties,
      }));

      if (relationships.length > 0) {
        await this.graphStore.createRelationships(organizationId, unit.id, relationships);
      }

      // 4. Chunk content
      const textChunks = chunkZettelContent(unit.content);

      // 5. Generate embeddings
      const chunkTexts = textChunks.map((chunk) => chunk.content);
      const embeddings = await this.embeddings.generateEmbeddings(chunkTexts);

      // 6. Prepare and upsert PostgreSQL chunks
      const pgChunks = textChunks.map((chunk, index) => ({
        id: randomUUID(),
        vector: embeddings[index],
        payload: {
          zettelId: unit.id,
          zettelTitle: unit.title,
          section: chunk.section,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          domains: unit.domains,
          topics: unit.topics,
          knowledgeType: unit.knowledgeType,
          contextSource: unit.contextSource,
          sourceUrl: unit.provenance?.url || unit.sourceUrl,
          provenance: unit.provenance,
          created: now,
          updated: now,
        },
      }));

      await this.vectorStore.upsertChunks(organizationId, pgChunks);

      return {
        success: true,
        zettelId: unit.id,
        chunksCreated: pgChunks.length,
        relationshipsCreated: relationships.length,
      };
    } catch (error) {
      console.error(`❌ Failed to ingest knowledge unit ${unit.id}:`, error);
      return {
        success: false,
        chunksCreated: 0,
        relationshipsCreated: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Delete Zettel from both ArangoDB and PostgreSQL, scoped to organization
   */
  async deleteZettel(organizationId: string, zettelId: string): Promise<boolean> {
    try {
      console.log(`🗑️  Deleting Zettel: ${zettelId}`);

      await Promise.all([
        this.graphStore.deleteZettel(organizationId, zettelId),
        this.vectorStore.deleteZettelChunks(organizationId, zettelId),
      ]);

      console.log(`✅ Successfully deleted: ${zettelId}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to delete Zettel ${zettelId}:`, error);
      return false;
    }
  }
}

// Singleton instance
export const ingestionService = new IngestionService();
