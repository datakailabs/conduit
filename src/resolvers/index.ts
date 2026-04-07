import { dateTimeScalar } from './scalars.js';
import { searchQueries } from './query/search.js';
import { graphQueries } from './query/graph.js';
import { adminQueries } from './query/admin.js';
import { kaiQueries } from './query/kais.js';
import { ingestionMutations } from './mutation/ingestion.js';
import { kaiMutations } from './mutation/kais.js';
import { zettelTypeResolvers } from './types/zettel.js';

// Map lowercase stored values to uppercase GraphQL enum values.
// GraphQL enums are case-sensitive; DB stores lowercase.
const KNOWLEDGE_TYPE_MAP: Record<string, string> = {
  concept: 'CONCEPT',
  pattern: 'PATTERN',
  antipattern: 'ANTIPATTERN',
  principle: 'PRINCIPLE',
  technique: 'TECHNIQUE',
  gotcha: 'GOTCHA',
  tool: 'TOOL',
  reference: 'REFERENCE',
};

const CONTEXT_SOURCE_MAP: Record<string, string> = {
  experience: 'EXPERIENCE',
  research: 'RESEARCH',
  discussion: 'DISCUSSION',
  article: 'ARTICLE',
  'vendor-doc': 'VENDOR_DOC',
  project: 'PROJECT',
};

const enumResolvers = {
  KnowledgeType: Object.fromEntries(
    Object.entries(KNOWLEDGE_TYPE_MAP).map(([, v]) => [v, v])
  ),
  ContextSource: Object.fromEntries(
    Object.entries(CONTEXT_SOURCE_MAP).map(([, v]) => [v, v])
  ),
  // Resolve enum fields on types that carry them
  Zettel: {
    knowledgeType: (parent: any) => KNOWLEDGE_TYPE_MAP[parent.knowledgeType] ?? parent.knowledgeType?.toUpperCase(),
    contextSource: (parent: any) => CONTEXT_SOURCE_MAP[parent.contextSource] ?? parent.contextSource?.toUpperCase(),
  },
  ZettelMetadata: {
    knowledgeType: (parent: any) => KNOWLEDGE_TYPE_MAP[parent.knowledgeType] ?? parent.knowledgeType?.toUpperCase(),
    contextSource: (parent: any) => CONTEXT_SOURCE_MAP[parent.contextSource] ?? parent.contextSource?.toUpperCase(),
  },
};

export const resolvers = {
  DateTime: dateTimeScalar,
  Query: {
    ...searchQueries,
    ...graphQueries,
    ...adminQueries,
    ...kaiQueries,
  },
  Mutation: {
    ...ingestionMutations,
    ...kaiMutations,
  },
  ...zettelTypeResolvers,
  // Merge enum resolvers, but preserve zettelTypeResolvers.Zettel.relationships
  Zettel: {
    ...zettelTypeResolvers.Zettel,
    ...enumResolvers.Zettel,
  },
  ZettelMetadata: enumResolvers.ZettelMetadata,
  KnowledgeType: enumResolvers.KnowledgeType,
  ContextSource: enumResolvers.ContextSource,
};
