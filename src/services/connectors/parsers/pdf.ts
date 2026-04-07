/**
 * PDF Parser — Extracts text from PDF documents.
 *
 * Uses pdfjs-dist (Mozilla's PDF.js) for text extraction.
 * For layout-aware parsing (tables, multi-column), use the Docling parser instead.
 */

import type { DocumentParser, DocumentFormat, ParsedDocument } from '../../../types/connector.js';

export class PdfParser implements DocumentParser {
  readonly supportedFormats: DocumentFormat[] = ['pdf'];

  async parse(input: Buffer, _format: DocumentFormat, filename?: string): Promise<ParsedDocument> {
    // Dynamic import — pdfjs-dist is an optional dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pdfjs: any;
    try {
      const mod = 'pdfjs-dist';
      pdfjs = await import(/* @vite-ignore */ mod);
    } catch {
      throw new Error(
        'pdfjs-dist is not installed. Run: pnpm add pdfjs-dist'
      );
    }

    const data = new Uint8Array(input);
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = (textContent.items as Array<{ str?: string }>)
        .filter((item): item is { str: string } => typeof item.str === 'string')
        .map(item => item.str)
        .join(' ');
      if (pageText.trim()) {
        pages.push(pageText.trim());
      }
    }

    const content = pages.join('\n\n');

    // Try to extract title from PDF metadata
    const metadata = await doc.getMetadata().catch(() => null);
    const info = metadata?.info as Record<string, unknown> | undefined;
    const pdfTitle = info?.Title ? String(info.Title) : undefined;
    const pdfAuthor = info?.Author ? String(info.Author) : undefined;

    const title =
      (pdfTitle && pdfTitle.trim()) ||
      filename?.replace(/\.pdf$/, '') ||
      content.split('\n')[0]?.slice(0, 100) ||
      'Untitled PDF';

    return {
      content,
      title,
      format: 'pdf',
      metadata: {
        author: pdfAuthor || undefined,
        pageCount: doc.numPages,
        wordCount: content.split(/\s+/).filter(Boolean).length,
      },
    };
  }
}
