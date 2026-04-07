/**
 * Document Parser Service — Routes documents to the appropriate parser.
 *
 * Resolution order for PDF/DOCX/PPTX:
 *   1. Docling sidecar (layout-aware, highest quality)
 *   2. Built-in npm parsers (pdfjs-dist, mammoth, officeparser)
 *
 * Markdown, HTML, CSV, TXT always use the zero-dependency built-in parser.
 */

import { extname } from 'path';
import type { DocumentFormat, DocumentParser, ParsedDocument } from '../../../types/connector.js';
import { BuiltinParser } from './builtin.js';
import { DoclingParser } from './docling.js';
import { PdfParser } from './pdf.js';
import { OfficeParser } from './office.js';

const EXTENSION_MAP: Record<string, DocumentFormat> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'txt',
  '.text': 'txt',
  '.html': 'html',
  '.htm': 'html',
  '.csv': 'csv',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
};

/** Detect document format from file extension */
export function detectFormat(filename: string): DocumentFormat | null {
  const ext = extname(filename).toLowerCase();
  return EXTENSION_MAP[ext] || null;
}

export class DocumentParserService implements DocumentParser {
  readonly supportedFormats: DocumentFormat[] = [
    'markdown', 'txt', 'html', 'csv', 'pdf', 'docx', 'pptx', 'xlsx',
  ];

  private builtin = new BuiltinParser();
  private pdf = new PdfParser();
  private office = new OfficeParser();
  private docling: DoclingParser;
  private doclingAvailable: boolean | null = null;

  constructor(doclingUrl?: string) {
    this.docling = new DoclingParser(doclingUrl);
  }

  /** Check Docling availability (cached after first check) */
  private async checkDocling(): Promise<boolean> {
    if (this.doclingAvailable === null) {
      this.doclingAvailable = await this.docling.isAvailable();
      if (this.doclingAvailable) {
        console.log('📄 Docling sidecar detected — using layout-aware parsing');
      }
    }
    return this.doclingAvailable;
  }

  /** Reset Docling availability cache (e.g., after sidecar restart) */
  resetDoclingCache(): void {
    this.doclingAvailable = null;
  }

  async parse(input: Buffer, format: DocumentFormat, filename?: string): Promise<ParsedDocument> {
    // Formats always handled by built-in parser
    if (this.builtin.supportedFormats.includes(format)) {
      return this.builtin.parse(input, format, filename);
    }

    // For PDF/DOCX/PPTX: try Docling first, fall back to npm parsers
    if (this.docling.supportedFormats.includes(format)) {
      const hasDocling = await this.checkDocling();
      if (hasDocling) {
        try {
          return await this.docling.parse(input, format, filename);
        } catch (err) {
          console.warn(`⚠️  Docling parsing failed, falling back to built-in: ${err}`);
        }
      }
    }

    // Fallback to npm-based parsers
    if (format === 'pdf') {
      return this.pdf.parse(input, format, filename);
    }
    if (this.office.supportedFormats.includes(format)) {
      return this.office.parse(input, format, filename);
    }

    throw new Error(`No parser available for format: ${format}`);
  }
}

/** Singleton instance */
export const documentParser = new DocumentParserService();
