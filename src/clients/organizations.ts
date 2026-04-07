import { Pool } from 'pg';
import type { Organization } from '../types/tenant.js';

export class OrganizationStore {
  private pool: Pool;
  private cache = new Map<string, Organization>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Initialize: ensure default org exists (seeded from authConfig keys),
   * then load all active orgs into cache.
   */
  async initialize(defaultApiKey: string, defaultAdminKey: string): Promise<void> {
    // Upsert default org with real API keys from config
    await this.pool.query(
      `INSERT INTO organizations (id, name, api_key, admin_key)
       VALUES ('org_datakai', 'DataKai', $1, $2)
       ON CONFLICT (id) DO UPDATE SET
         api_key = EXCLUDED.api_key,
         admin_key = EXCLUDED.admin_key`,
      [defaultApiKey, defaultAdminKey]
    );

    await this.reload();
    console.log(`✅ OrganizationStore initialized (${this.cache.size} orgs cached)`);
  }

  /**
   * Reload all active orgs into cache.
   */
  async reload(): Promise<void> {
    const result = await this.pool.query(
      'SELECT id, name, api_key, admin_key, is_active FROM organizations WHERE is_active = true'
    );

    this.cache.clear();
    for (const row of result.rows) {
      const org: Organization = {
        id: row.id,
        name: row.name,
        apiKey: row.api_key,
        adminKey: row.admin_key,
        isActive: row.is_active,
      };
      this.cache.set(org.apiKey, org);
      this.cache.set(org.adminKey, org);
    }
  }

  /**
   * O(1) cache lookup by API key or admin key.
   */
  findByKey(key: string): Organization | null {
    return this.cache.get(key) ?? null;
  }

  /**
   * Check if the key is the admin key for the given org.
   */
  isAdminKey(key: string, org: Organization): boolean {
    return key === org.adminKey;
  }
}
