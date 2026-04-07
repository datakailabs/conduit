/**
 * Teams Formatting — converts ask results to Adaptive Card format.
 *
 * Teams uses Adaptive Cards (JSON schema) for rich content.
 * We build cards programmatically (no template library needed).
 */

import type { AskInternalResult } from './ask-internal.js';

interface AdaptiveCard {
  type: string;
  $schema: string;
  version: string;
  body: Array<Record<string, unknown>>;
}

/**
 * Format an ask result as a Teams Adaptive Card.
 */
export function formatTeamsCard(result: AskInternalResult): AdaptiveCard {
  const body: Array<Record<string, unknown>> = [];

  // Answer text
  body.push({
    type: 'TextBlock',
    text: result.answer,
    wrap: true,
    size: 'default',
  });

  // Sources
  if (result.sources.length > 0) {
    body.push({
      type: 'TextBlock',
      text: `**Sources (${result.sources.length}):**`,
      wrap: true,
      spacing: 'medium',
      weight: 'bolder',
      size: 'small',
    });

    const sourceItems = result.sources.slice(0, 5).map((s) => {
      const domains = s.domains.length > 0 ? ` [${s.domains.join(', ')}]` : '';
      const title = s.sourceUrl ? `[${s.title}](${s.sourceUrl})` : s.title;
      return {
        type: 'TextBlock',
        text: `- ${title}${domains}`,
        wrap: true,
        size: 'small',
        spacing: 'none',
      };
    });

    body.push(...sourceItems);

    // Retrieval stats
    const stats = result.retrieval;
    body.push({
      type: 'TextBlock',
      text: `_GraphRAG: ${stats.vectorSeeds} vector · ${stats.graphEdge} graph · ${stats.graphTopic} topic_`,
      wrap: true,
      size: 'small',
      spacing: 'medium',
      isSubtle: true,
    });
  }

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
  };
}

/**
 * Strip the bot @mention from the message text.
 * Teams includes `<at>BotName</at>` in the text when the bot is mentioned.
 */
export function stripBotMention(text: string): string {
  return text.replace(/<at>.*?<\/at>/gi, '').trim();
}
