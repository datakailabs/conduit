import { Pool } from 'pg';
import { createLogger } from '../lib/logger.js';

const log = createLogger('chat-logger');

export interface ChatRecord {
  organizationId: string;
  kaiId?: string;
  keyId?: string;
  cognitoSub?: string;
  query: string;
  answer?: string;
  sources: unknown[];
  retrievalStats: object;
  mode: string;
  model?: string;
  streamed: boolean;
  threadId?: string;
  rewrittenQuery?: string;
  sourceCount: number;
  retrievalMs?: number;
  synthesisMs?: number;
  totalLatencyMs?: number;
}

export class ChatLogger {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Record a chat message. Fire-and-forget (doesn't block the response).
   */
  record(chat: ChatRecord): void {
    this.pool
      .query(
        `INSERT INTO chat_messages (
          organization_id, kai_id, key_id, cognito_sub,
          query, answer, sources, retrieval_stats,
          mode, model, streamed, source_count,
          thread_id, rewritten_query,
          retrieval_ms, synthesis_ms, total_latency_ms
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          chat.organizationId,
          chat.kaiId ?? null,
          chat.keyId ?? null,
          chat.cognitoSub ?? null,
          chat.query,
          chat.answer ?? null,
          JSON.stringify(chat.sources),
          JSON.stringify(chat.retrievalStats),
          chat.mode,
          chat.model ?? null,
          chat.streamed,
          chat.sourceCount,
          chat.threadId ?? null,
          chat.rewrittenQuery ?? null,
          chat.retrievalMs ?? null,
          chat.synthesisMs ?? null,
          chat.totalLatencyMs ?? null,
        ]
      )
      .catch((err) => {
        log.error('Failed to log chat message', { error: err instanceof Error ? err.message : String(err) });
      });
  }
}
