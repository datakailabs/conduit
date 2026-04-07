-- Add thread support for conversational follow-ups in Ask endpoint
ALTER TABLE chat_messages ADD COLUMN thread_id TEXT;
ALTER TABLE chat_messages ADD COLUMN rewritten_query TEXT;
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, created_at ASC) WHERE thread_id IS NOT NULL;
