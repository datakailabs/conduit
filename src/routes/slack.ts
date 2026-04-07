/**
 * Slack Integration Route
 *
 * Endpoints:
 *   POST /commands  — Slash command handler (/conduit <question>)
 *   POST /events    — Events API handler (app_mention, url_verification)
 *
 * Auth: Slack signing secret verification (not Bearer token).
 * Async pattern: Acknowledge within 3s, respond via Slack API.
 */

import { Router, raw } from 'express';
import { WebClient } from '@slack/web-api';
import { askInternal } from '../services/integrations/ask-internal.js';
import { formatSlackResponse, verifySlackSignature } from '../services/integrations/format-slack.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('slack');

interface SlackConfig {
  botToken: string;
  signingSecret: string;
  orgId: string;
}

export function createSlackRouter(config: SlackConfig): Router {
  const router = Router();
  const slack = new WebClient(config.botToken);

  // ─── Raw body parsing for signature verification ───────────────
  // Slack sends application/x-www-form-urlencoded for commands
  // and application/json for events. We need the raw body for HMAC.
  router.use(raw({ type: '*/*' }));

  // ─── Signature verification middleware ─────────────────────────
  router.use((req, res, next) => {
    const timestamp = req.headers['x-slack-request-timestamp'] as string;
    const signature = req.headers['x-slack-signature'] as string;

    if (!timestamp || !signature) {
      res.status(401).json({ error: 'Missing Slack signature headers' });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body);

    if (!verifySlackSignature(config.signingSecret, timestamp, rawBody, signature)) {
      log.warn('Slack signature verification failed');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Parse the raw body for downstream handlers
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      req.body = JSON.parse(rawBody);
    } else if (contentType.includes('urlencoded')) {
      req.body = Object.fromEntries(new URLSearchParams(rawBody));
    }

    next();
  });

  // ─── Slash Command: /conduit <question> ────────────────────────
  router.post('/commands', async (req, res) => {
    try {
      const { text, response_url, user_id, channel_id } = req.body;

      if (!text || text.trim().length === 0) {
        res.json({
          response_type: 'ephemeral',
          text: 'Usage: `/conduit <your question>`\nExample: `/conduit What is a clustering key in Snowflake?`',
        });
        return;
      }

      // Acknowledge immediately (must respond within 3 seconds)
      res.json({
        response_type: 'in_channel',
        text: ':brain: Searching the knowledge graph...',
      });

      // Fire-and-forget: process the question asynchronously
      processSlackQuestion(text.trim(), config.orgId, response_url, user_id).catch((err) => {
        log.error('Slack command processing failed', { error: err.message, channel: channel_id });
      });
    } catch (error) {
      log.error('Slack command handler error', { error: error instanceof Error ? error.message : String(error) });
      res.json({ response_type: 'ephemeral', text: 'Something went wrong. Please try again.' });
    }
  });

  // ─── Events API (app_mention + url_verification) ───────────────
  router.post('/events', async (req, res) => {
    try {
      // URL verification challenge (Slack sends this during app setup)
      if (req.body.type === 'url_verification') {
        res.json({ challenge: req.body.challenge });
        return;
      }

      // Acknowledge immediately to prevent Slack retries
      res.status(200).send();

      const event = req.body.event;
      if (!event || event.type !== 'app_mention') return;

      // Strip the bot mention from the text
      const query = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      if (!query) return;

      const channel = event.channel;
      const threadTs = event.thread_ts || event.ts;

      // Post a "thinking" message
      const thinking = await slack.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: ':brain: Searching the knowledge graph...',
      });

      // Process the question
      try {
        const result = await askInternal(query, config.orgId);
        const formatted = formatSlackResponse(result);

        // Update the thinking message with the answer
        if (thinking.ts) {
          await slack.chat.update({
            channel,
            ts: thinking.ts,
            text: formatted.text,
            blocks: formatted.blocks as never[],
          });
        }
      } catch (err) {
        log.error('Slack event processing failed', { error: err instanceof Error ? err.message : String(err) });
        if (thinking.ts) {
          await slack.chat.update({
            channel,
            ts: thinking.ts,
            text: ':warning: Sorry, I ran into an error processing your question.',
          });
        }
      }
    } catch (error) {
      log.error('Slack events handler error', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.status(200).send();
    }
  });

  // ─── Async question processor (for slash commands) ─────────────
  async function processSlackQuestion(
    query: string,
    orgId: string,
    responseUrl: string,
    userId: string
  ): Promise<void> {
    try {
      const result = await askInternal(query, orgId);
      const formatted = formatSlackResponse(result);

      // Post the answer back via response_url
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'in_channel',
          replace_original: true,
          text: formatted.text,
          blocks: formatted.blocks,
        }),
      });

      log.info('Slack answer delivered', { query: query.slice(0, 80), userId });
    } catch (error) {
      log.error('Slack async answer failed', { error: error instanceof Error ? error.message : String(error) });

      // Post error message
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'ephemeral',
          replace_original: true,
          text: ':warning: Sorry, I ran into an error processing your question. Please try again.',
        }),
      });
    }
  }

  return router;
}
