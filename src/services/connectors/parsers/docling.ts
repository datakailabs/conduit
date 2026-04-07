/**
 * Docling Parser — Layout-aware document parsing via IBM's Docling sidecar.
 *
 * Docling provides high-quality parsing for complex documents:
 * - Tables preserved as markdown tables
 * - Multi-column layouts handled correctly
 * - Headers/footers stripped
 * - 97.9% accuracy on table extraction benchmarks
 *
 * Requires docling-serve running as a Docker sidecar:
 *   docker run -p 5001:5001 ds4sd/docling-serve
 *
 * Falls back to built-in parsers if Docling is unavailable.
 */

import type { DocumentParser, DocumentFormat, ParsedDocument } from '../../../types/connector.js';

interface DoclingConvertResponse {
  document: {
    md_content: string;
    metadata?: {
      title?: string;
      author?: string;
      num_pages?: number;
      [key: string]: unknown;
    };
  };
}

export class DoclingParser implements DocumentParser {
  readonly supportedFormats: DocumentFormat[] = ['pdf', 'docx', 'pptx', 'html'];

  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:5001') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Check if the Docling sidecar is reachable */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async parse(input: Buffer, format: DocumentFormat, filename?: string): Promise<ParsedDocument> {
    const mimeTypes: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      html: 'text/html',
    };

    const mime = mimeTypes[format];
    if (!mime) {
      throw new Error(`DoclingParser does not support format: ${format}`);
    }

    const formData = new FormData();
    const blob = new Blob([input], { type: mime });
    formData.append('files', blob, filename || `document.${format}`);
    formData.append('to_format', 'md');

    const res = await fetch(`${this.baseUrl}/v1/convert`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120_000), // 2 min timeout for large docs
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Docling conversion failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as DoclingConvertResponse;
    const content = data.document.md_content.trim();
    const meta = data.document.metadata || {};

    const title =
      (meta.title && String(meta.title).trim()) ||
      content.match(/^#\s+(.+)$/m)?.[1] ||
      filename?.replace(/\.[^.]+$/, '') ||
      'Untitled';

    return {
      content,
      title,
      format,
      metadata: {
        author: meta.author ? String(meta.author) : undefined,
        pageCount: meta.num_pages,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        parser: 'docling',
      },
    };
  }
}
