/**
 * Microsoft Teams Integration Route
 *
 * Endpoints:
 *   POST /messages  — Bot Framework activity handler
 *
 * Auth: Bot Framework JWT validation (handled by BotFrameworkAdapter).
 * Pattern: Receive activity → send typing → ask → reply with Adaptive Card.
 */

import { Router } from 'express';
import {
  BotFrameworkAdapter,
  TurnContext,
  ActivityTypes,
  CardFactory,
} from 'botbuilder';
import { askInternal } from '../services/integrations/ask-internal.js';
import { formatTeamsCard, stripBotMention } from '../services/integrations/format-teams.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('teams');

interface TeamsConfig {
  appId: string;
  appPassword: string;
  orgId: string;
}

export function createTeamsRouter(config: TeamsConfig): Router {
  const router = Router();

  const adapter = new BotFrameworkAdapter({
    appId: config.appId,
    appPassword: config.appPassword,
  });

  // Error handler for the adapter
  adapter.onTurnError = async (context, error) => {
    log.error('Teams adapter error', { error: error.message });
    await context.sendActivity('Sorry, I ran into an error processing your question.');
  };

  // ─── Messages endpoint ─────────────────────────────────────────
  router.post('/messages', (req, res) => {
    adapter.processActivity(req, res, async (context: TurnContext) => {
      if (context.activity.type !== ActivityTypes.Message) return;

      const text = stripBotMention(context.activity.text || '');
      if (!text) {
        await context.sendActivity('Ask me anything about our knowledge base! Just type your question.');
        return;
      }

      // Send typing indicator
      await context.sendActivity({ type: ActivityTypes.Typing });

      try {
        const result = await askInternal(text, config.orgId);
        const card = formatTeamsCard(result);

        // Send as Adaptive Card
        await context.sendActivity({
          attachments: [CardFactory.adaptiveCard(card)],
        });

        log.info('Teams answer delivered', {
          query: text.slice(0, 80),
          conversationId: context.activity.conversation?.id,
        });
      } catch (error) {
        log.error('Teams ask failed', { error: error instanceof Error ? error.message : String(error) });
        await context.sendActivity('Sorry, I ran into an error processing your question. Please try again.');
      }
    });
  });

  return router;
}
