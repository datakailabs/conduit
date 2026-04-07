/**
 * Thread Resolver — rewrites follow-up questions into self-contained queries
 * using prior conversation context from chat_messages.
 */

import { Pool } from 'pg';
import OpenAI from 'openai';
import { extractionConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('thread-resolver');

export interface ThreadTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ThreadContext {
  rewrittenQuery: string;
  conversationHistory: ThreadTurn[];
}

const REWRITE_MODEL = 'gpt-4o-mini';
const MAX_TURNS = 5;
const ANSWER_TRUNCATE = 200;

const REWRITE_SYSTEM = `You rewrite follow-up questions into self-contained queries.
Given a conversation and a follow-up, rewrite the follow-up so it can be
understood without the conversation. Preserve intent exactly.
Output ONLY the rewritten question, nothing else.`;

export class ThreadResolver {
  private pool: Pool;
  private client: OpenAI;

  constructor(pool: Pool) {
    this.pool = pool;
    this.client = new OpenAI(extractionConfig.clientConfig);
  }

  async resolve(orgId: string, threadId: string, currentQuery: string): Promise<ThreadContext> {
    try {
      const { rows } = await this.pool.query(
        `SELECT query, answer FROM chat_messages
         WHERE thread_id = $1 AND organization_id = $2
         ORDER BY created_at ASC
         LIMIT $3`,
        [threadId, orgId, MAX_TURNS]
      );

      // Build conversation history from prior turns
      const conversationHistory: ThreadTurn[] = [];
      for (const row of rows) {
        conversationHistory.push({ role: 'user', content: row.query });
        if (row.answer) {
          conversationHistory.push({ role: 'assistant', content: row.answer });
        }
      }

      // No prior turns — pass through without LLM call
      if (rows.length === 0) {
        return { rewrittenQuery: currentQuery, conversationHistory: [] };
      }

      // Build conversation summary for rewrite prompt
      const conversationLines = rows.map((row) => {
        const answer = row.answer
          ? row.answer.length > ANSWER_TRUNCATE
            ? row.answer.slice(0, ANSWER_TRUNCATE) + '...'
            : row.answer
          : '(no answer)';
        return `User: ${row.query}\nAssistant: ${answer}`;
      }).join('\n');

      const userPrompt = `Conversation:\n${conversationLines}\n\nFollow-up: ${currentQuery}`;

      const completion = await this.client.chat.completions.create({
        model: REWRITE_MODEL,
        max_tokens: 256,
        temperature: 0,
        messages: [
          { role: 'system', content: REWRITE_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
      });

      const rewrittenQuery = completion.choices[0]?.message?.content?.trim() || currentQuery;

      log.info('Query rewritten', {
        threadId,
        original: currentQuery,
        rewritten: rewrittenQuery,
        priorTurns: rows.length,
      });

      return { rewrittenQuery, conversationHistory };
    } catch (error) {
      log.warn('Thread resolution failed, using original query', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { rewrittenQuery: currentQuery, conversationHistory: [] };
    }
  }
}
