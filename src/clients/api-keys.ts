import { Pool } from 'pg';
import { hashKey, generateApiKey, generateKeyId } from '../services/keys.js';

export interface ApiKeyRecord {
  organizationId: string;
  keyId: string;
  keyType: 'api' | 'admin';
  scope: 'read' | 'write' | 'admin';
  kaiIds: string[];
}

export class ApiKeyStore {
  private pool: Pool;
  private cache = new Map<string, ApiKeyRecord>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Load all active key hashes into memory for O(1) lookup.
   */
  async initialize(): Promise<void> {
    const result = await this.pool.query(
      `SELECT id, organization_id, key_hash, key_type, scope, kai_ids
       FROM api_keys
       WHERE is_active = TRUE`
    );

    this.cache.clear();
    for (const row of result.rows) {
      this.cache.set(row.key_hash, {
        organizationId: row.organization_id,
        keyId: row.id,
        keyType: row.key_type,
        scope: row.scope || 'admin',
        kaiIds: row.kai_ids || [],
      });
    }

    console.log(`✅ ApiKeyStore initialized (${this.cache.size} keys cached)`);
  }

  /**
   * Look up a plaintext API key. Hashes it and checks the in-memory cache.
   */
  findByPlaintextKey(token: string): ApiKeyRecord | null {
    const hash = hashKey(token);
    return this.cache.get(hash) ?? null;
  }

  /**
   * Create a new API key for an organization.
   * Returns the plaintext key (shown once to user) and key metadata.
   */
  async createKey(params: {
    organizationId: string;
    keyType: 'api' | 'admin';
    scope?: 'read' | 'write' | 'admin';
    kaiIds?: string[];
  }): Promise<{ plaintext: string; keyId: string; prefix: string }> {
    const { plaintext, hash, prefix } = generateApiKey();
    const keyId = generateKeyId();
    const scope = params.scope || (params.keyType === 'admin' ? 'admin' : 'read');
    const kaiIds = params.kaiIds || [];

    await this.pool.query(
      `INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, key_type, scope, kai_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [keyId, params.organizationId, hash, prefix, params.keyType, scope, kaiIds]
    );

    // Add to cache
    this.cache.set(hash, {
      organizationId: params.organizationId,
      keyId,
      keyType: params.keyType,
      scope,
      kaiIds,
    });

    return { plaintext, keyId, prefix };
  }

  /**
   * Revoke a key: mark inactive in DB, remove from cache.
   */
  async revokeKey(keyId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE api_keys
       SET is_active = FALSE, revoked_at = NOW()
       WHERE id = $1 AND is_active = TRUE
       RETURNING key_hash`,
      [keyId]
    );

    if (result.rows.length === 0) return false;

    this.cache.delete(result.rows[0].key_hash);
    return true;
  }

  /**
   * List keys for an organization (prefixes only, never hashes).
   */
  async listKeysForOrg(
    organizationId: string
  ): Promise<
    Array<{
      id: string;
      prefix: string;
      keyType: string;
      isActive: boolean;
      createdAt: string;
      lastUsedAt: string | null;
    }>
  > {
    const result = await this.pool.query(
      `SELECT id, key_prefix, key_type, is_active, created_at, last_used_at
       FROM api_keys
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [organizationId]
    );

    return result.rows.map((row) => ({
      id: row.id,
      prefix: row.key_prefix,
      keyType: row.key_type,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
    }));
  }

  /**
   * Update last_used_at timestamp. Fire-and-forget (no latency impact).
   */
  updateLastUsed(keyId: string): void {
    this.pool
      .query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyId])
      .catch(() => {
        // Silently ignore — non-critical tracking
      });
  }

  /**
   * Evict all keys for an organization from cache (e.g., on org deactivation).
   */
  async evictOrg(organizationId: string): Promise<void> {
    for (const [hash, record] of this.cache) {
      if (record.organizationId === organizationId) {
        this.cache.delete(hash);
      }
    }
  }
}
