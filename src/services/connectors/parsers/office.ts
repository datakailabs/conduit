/**
 * Office Document Parser — Extracts text from DOCX and PPTX files.
 *
 * Uses mammoth for DOCX (high-quality HTML→text conversion).
 * Uses officeparser for PPTX and XLSX.
 */

import type { DocumentParser, DocumentFormat, ParsedDocument } from '../../../types/connector.js';

export class OfficeParser implements DocumentParser {
  readonly supportedFormats: DocumentFormat[] = ['docx', 'pptx', 'xlsx'];

  async parse(input: Buffer, format: DocumentFormat, filename?: string): Promise<ParsedDocument> {
    switch (format) {
      case 'docx': return this.parseDocx(input, filename);
      case 'pptx':
      case 'xlsx': return this.parseWithOfficeParser(input, format, filename);
      default:
        throw new Error(`OfficeParser does not support format: ${format}`);
    }
  }

  private async parseDocx(input: Buffer, filename?: string): Promise<ParsedDocument> {
    // Dynamic import — mammoth is an optional dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mammoth: any;
    try {
      const mod = 'mammoth';
      mammoth = await import(/* @vite-ignore */ mod);
    } catch {
      throw new Error('mammoth is not installed. Run: pnpm add mammoth');
    }

    const result = await mammoth.extractRawText({ buffer: input });
    const content = (result.value as string).trim();

    // Extract title from first line or filename
    const firstLine = content.split('\n').find((l: string) => l.trim().length > 0);
    const title = filename?.replace(/\.docx$/, '') || firstLine?.slice(0, 100) || 'Untitled Document';

    const messages = result.messages as Array<{ message: string }>;

    return {
      content,
      title,
      format: 'docx',
      metadata: {
        wordCount: content.split(/\s+/).filter(Boolean).length,
        warnings: messages.length > 0
          ? messages.map((m: { message: string }) => m.message)
          : undefined,
      },
    };
  }

  private async parseWithOfficeParser(
    input: Buffer,
    format: DocumentFormat,
    filename?: string
  ): Promise<ParsedDocument> {
    // Dynamic import — officeparser is an optional dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let officeparser: any;
    try {
      const mod = 'officeparser';
      officeparser = await import(/* @vite-ignore */ mod);
    } catch {
      throw new Error('officeparser is not installed. Run: pnpm add officeparser');
    }

    const content = (await officeparser.parseOfficeAsync(input)).trim();
    const ext = format === 'pptx' ? '.pptx' : '.xlsx';
    const title = filename?.replace(new RegExp(`\\${ext}$`), '') || `Untitled ${format.toUpperCase()}`;

    return {
      content,
      title,
      format,
      metadata: {
        wordCount: content.split(/\s+/).filter(Boolean).length,
      },
    };
  }
}
