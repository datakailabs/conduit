/**
 * Text Chunking Service
 * Splits Zettel content into semantic chunks for vector embedding
 */

// Max chunk size to prevent Ollama context window overflow
// nomic-embed-text has 8192 token limit (~6000 chars safe with overhead)
const MAX_CHUNK_CHARS = 6000;

export interface TextChunk {
  section: string;
  content: string;
  chunkIndex: number;
}

/**
 * Extract summary from Zettel content (first 1-2 paragraphs after title)
 */
export function extractSummary(content: string): string {
  const lines = content.split('\n').filter((line) => line.trim());

  // Skip title (first # heading)
  let startIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('# ')) {
      startIndex = i + 1;
      break;
    }
  }

  // Find first ## heading (start of Core Concept section)
  let endIndex = lines.length;
  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      endIndex = i;
      break;
    }
  }

  // Join the summary paragraphs
  const summaryLines = lines.slice(startIndex, endIndex);
  return summaryLines.join('\n').trim();
}

/**
 * Hard split content at character limit (emergency fallback)
 */
function hardSplitAtLimit(content: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > maxChars) {
    // Try to split at last paragraph boundary before limit
    let splitPoint = maxChars;
    const lastNewline = remaining.lastIndexOf('\n\n', maxChars);

    if (lastNewline > maxChars * 0.7) {
      // Use paragraph boundary if it's not too far back (>70% of max)
      splitPoint = lastNewline;
    }

    chunks.push(remaining.substring(0, splitPoint).trim());
    remaining = remaining.substring(splitPoint).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Chunk Zettel content by sections and paragraphs
 */
export function chunkZettelContent(content: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const lines = content.split('\n');

  let currentSection = 'summary';
  let currentChunk: string[] = [];
  let chunkIndex = 0;

  // Helper to finalize current chunk
  const finalizeChunk = () => {
    if (currentChunk.length > 0) {
      const chunkContent = currentChunk.join('\n').trim();

      if (chunkContent.length > 50) {
        // Check for non-ASCII characters that may cause embedding issues
        const hasNonASCII = /[^\x00-\x7F]/.test(chunkContent);
        if (hasNonASCII) {
          const unicodeChars = chunkContent.match(/[^\x00-\x7F]/g) || [];
          const uniqueUnicode = [...new Set(unicodeChars)].slice(0, 5).join(' ');
          console.warn(
            `⚠️  Non-ASCII characters detected in section "${currentSection}"`
          );
          console.warn(`   Characters: ${uniqueUnicode}${unicodeChars.length > 5 ? '...' : ''}`);
          console.warn(`   This may cause Ollama embedding failures`);
        }

        // Check if chunk exceeds max size
        if (chunkContent.length > MAX_CHUNK_CHARS) {
          console.warn(
            `⚠️  Large chunk detected in section "${currentSection}" (${chunkContent.length} chars)`
          );
          console.warn(`   Splitting to prevent Ollama overflow...`);

          // Hard split the oversized chunk
          const splits = hardSplitAtLimit(chunkContent, MAX_CHUNK_CHARS);
          console.warn(`   -> Created ${splits.length} sub-chunks`);

          splits.forEach((splitContent) => {
            chunks.push({
              section: currentSection,
              content: splitContent,
              chunkIndex: chunkIndex++,
            });
          });
        } else {
          // Normal chunk - add as-is
          chunks.push({
            section: currentSection,
            content: chunkContent,
            chunkIndex: chunkIndex++,
          });
        }
      }
      currentChunk = [];
    }
  };

  for (const line of lines) {
    // Skip title
    if (line.startsWith('# ')) {
      continue;
    }

    // New section detected
    if (line.startsWith('## ')) {
      finalizeChunk();
      currentSection = line
        .replace(/^##\s+/, '')
        .toLowerCase()
        .replace(/\s+/g, '-');
      continue;
    }

    // Empty line: potential paragraph boundary
    if (line.trim() === '') {
      // If current chunk is substantial, finalize it
      if (currentChunk.join('\n').trim().length > 300) {
        finalizeChunk();
      } else {
        // Otherwise, add the empty line as separator
        currentChunk.push('');
      }
      continue;
    }

    // Add line to current chunk
    currentChunk.push(line);
  }

  // Finalize any remaining chunk
  finalizeChunk();

  return chunks;
}

/**
 * Extract code blocks from content for special handling
 */
export function extractCodeBlocks(content: string): Array<{
  language: string;
  code: string;
  lineNumber: number;
}> {
  const codeBlocks: Array<{ language: string; code: string; lineNumber: number }> = [];
  const lines = content.split('\n');

  let inCodeBlock = false;
  let currentLanguage = '';
  let currentCode: string[] = [];
  let blockStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of code block
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        currentLanguage = line.replace(/^```/, '').trim();
        currentCode = [];
        blockStartLine = i + 1;
      } else {
        // End of code block
        inCodeBlock = false;
        codeBlocks.push({
          language: currentLanguage,
          code: currentCode.join('\n'),
          lineNumber: blockStartLine,
        });
      }
      continue;
    }

    // Inside code block
    if (inCodeBlock) {
      currentCode.push(line);
    }
  }

  return codeBlocks;
}
