export interface SourceProvenance {
  type: 'url' | 'pdf' | 'database' | 'file' | 'api';
  url?: string;
  page?: number;
  pageRange?: string;
  query?: string;
  table?: string;
  path?: string;
  endpoint?: string;
  adapter?: string;
  fetchedAt?: string;
  title?: string;
}

/**
 * Normalize legacy sourceUrl string into SourceProvenance object.
 * Handles backward compatibility with old data.
 */
export function normalizeProvenance(
  sourceUrl?: string,
  provenance?: SourceProvenance | null
): SourceProvenance | undefined {
  if (provenance) return provenance;
  if (sourceUrl) return { type: 'url', url: sourceUrl };
  return undefined;
}
