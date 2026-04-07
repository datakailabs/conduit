/**
 * Slack Formatting — converts ask results to Slack Block Kit format.
 *
 * Slack uses "mrkdwn" (not standard markdown):
 * - Bold: *text*
 * - Italic: _text_
 * - Code: `text`
 * - Links: <url|text>
 */

import type { AskInternalResult } from './ask-internal.js';
import { createHmac, timingSafeEqual } from 'crypto';

// Slack Block Kit types (minimal, no need for full SDK types)
interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
}

/**
 * Format an ask result as Slack Block Kit blocks.
 */
export function formatSlackResponse(result: AskInternalResult): { blocks: SlackBlock[]; text: string } {
  const blocks: SlackBlock[] = [];

  // Answer section
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: result.answer },
  });

  // Sources section (if any)
  if (result.sources.length > 0) {
    blocks.push({ type: 'divider' });

    const sourceLines = result.sources.slice(0, 5).map((s, i) => {
      const domains = s.domains.length > 0 ? ` [${s.domains.join(', ')}]` : '';
      const link = s.sourceUrl ? ` — <${s.sourceUrl}|View>` : '';
      return `${i + 1}. *${s.title}*${domains}${link}`;
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Sources (${result.sources.length}):*\n${sourceLines.join('\n')}`,
      },
    });

    // Retrieval stats footer
    const stats = result.retrieval;
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `GraphRAG: ${stats.vectorSeeds} vector · ${stats.graphEdge} graph · ${stats.graphTopic} topic`,
      }],
    });
  }

  // Fallback text for notifications
  const text = result.answer.slice(0, 300) + (result.answer.length > 300 ? '...' : '');

  return { blocks, text };
}

/**
 * Verify Slack request signature (HMAC-SHA256).
 *
 * Slack sends:
 * - X-Slack-Signature: v0=<hex hash>
 * - X-Slack-Request-Timestamp: <unix seconds>
 *
 * We compute: HMAC-SHA256(signingSecret, "v0:{timestamp}:{rawBody}")
 * and compare in constant time.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string
): boolean {
  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const computed = 'v0=' + createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}
