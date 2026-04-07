/**
 * Built-in Document Parsers — Zero external dependency parsing for common formats.
 *
 * Handles: Markdown, plain text, HTML, CSV.
 * For PDF/DOCX/PPTX, delegates to the Docling sidecar or falls back to
 * lightweight npm packages (unpdf, mammoth).
 */

import matter from 'gray-matter';
import type { DocumentParser, DocumentFormat, ParsedDocument } from '../../../types/connector.js';

// ─── Markdown Parser ─────────────────────────────────────────────────

function parseMarkdown(input: Buffer, filename?: string): ParsedDocument {
  const raw = input.toString('utf-8');
  const { data: frontmatter, content } = matter(raw);

  const rawTitle =
    frontmatter.title ||
    content.match(/^#\s+(.+)$/m)?.[1] ||
    filename?.replace(/\.md$/, '') ||
    'Untitled';

  // Clean HTML tags and markdown escapes from title
  const title = rawTitle
    .replace(/<[^>]+>/g, '')
    .replace(/\\([.\-\\*_`[\](){}#+!|~])/g, '$1')
    .trim();

  // Clean markdown escapes from content (e.g. \- \. from AWS docs)
  const cleanedContent = content.trim()
    .replace(/\\([.\-\\*_`[\](){}#+!|~])/g, '$1');

  return {
    content: cleanedContent,
    title,
    format: 'markdown',
    metadata: {
      author: frontmatter.author,
      createdDate: frontmatter.created || frontmatter.date,
      modifiedDate: frontmatter.updated || frontmatter.modified,
      wordCount: content.split(/\s+/).filter(Boolean).length,
      // Preserve all frontmatter as metadata
      ...frontmatter,
    },
  };
}

// ─── Plain Text Parser ───────────────────────────────────────────────

function parsePlainText(input: Buffer, filename?: string): ParsedDocument {
  const content = input.toString('utf-8').trim();

  // Use first non-empty line as title
  const firstLine = content.split('\n').find(l => l.trim().length > 0) || 'Untitled';
  const title = filename?.replace(/\.txt$/, '') || firstLine.slice(0, 100);

  return {
    content,
    title,
    format: 'txt',
    metadata: {
      wordCount: content.split(/\s+/).filter(Boolean).length,
    },
  };
}

// ─── HTML Parser ─────────────────────────────────────────────────────

function stripHtmlTags(html: string): string {
  // Remove script and style blocks entirely
  let cleaned = html.replace(/<(script|style|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Replace block elements with newlines
  cleaned = cleaned.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function parseHtml(input: Buffer, filename?: string): ParsedDocument {
  const html = input.toString('utf-8');

  // Extract title from <title> or first <h1>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = titleMatch?.[1]?.trim() || filename?.replace(/\.html?$/, '') || 'Untitled';

  // Extract meta author
  const authorMatch = html.match(/<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i);

  const content = stripHtmlTags(html);

  return {
    content,
    title,
    format: 'html',
    metadata: {
      author: authorMatch?.[1],
      wordCount: content.split(/\s+/).filter(Boolean).length,
    },
  };
}

// ─── CSV Parser ──────────────────────────────────────────────────────

function parseCsv(input: Buffer, filename?: string): ParsedDocument {
  const raw = input.toString('utf-8').trim();
  const lines = raw.split('\n');

  if (lines.length === 0) {
    return { content: '', title: filename || 'Empty CSV', format: 'csv', metadata: {} };
  }

  // Parse header
  const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

  // Convert rows to readable text
  const rows = lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
    return headers.map((h, i) => `${h}: ${values[i] || ''}`).join(', ');
  });

  const content = rows.join('\n');
  const title = filename?.replace(/\.csv$/, '') || 'CSV Data';

  return {
    content,
    title,
    format: 'csv',
    metadata: {
      wordCount: content.split(/\s+/).filter(Boolean).length,
      columns: headers,
      rowCount: rows.length,
    },
  };
}

// ─── Built-in Parser ─────────────────────────────────────────────────

/** Parser for formats that need no external dependencies */
export class BuiltinParser implements DocumentParser {
  readonly supportedFormats: DocumentFormat[] = ['markdown', 'txt', 'html', 'csv'];

  async parse(input: Buffer, format: DocumentFormat, filename?: string): Promise<ParsedDocument> {
    switch (format) {
      case 'markdown': return parseMarkdown(input, filename);
      case 'txt': return parsePlainText(input, filename);
      case 'html': return parseHtml(input, filename);
      case 'csv': return parseCsv(input, filename);
      default:
        throw new Error(`BuiltinParser does not support format: ${format}`);
    }
  }
}
