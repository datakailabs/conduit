import type { Pool } from 'pg';
import type { KaiFilters } from '../types/tenant.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('kais');

export interface Kai {
  id: string;
  organizationId: string;
  createdBy: string | null;
  name: string;
  description: string | null;
  domains: string[];
  topics: string[];
  knowledgeTypes: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

function rowToKai(row: any): Kai {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    name: row.name,
    description: row.description,
    domains: row.domains || [],
    topics: row.topics || [],
    knowledgeTypes: row.knowledge_types || [],
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class KaiStore {
  constructor(private pool: Pool) {}

  async listKais(orgId: string): Promise<Kai[]> {
    const result = await this.pool.query(
      'SELECT * FROM kais WHERE organization_id = $1 ORDER BY is_default DESC, name ASC',
      [orgId]
    );
    return result.rows.map(rowToKai);
  }

  async getKai(kaiId: string): Promise<Kai | null> {
    const result = await this.pool.query('SELECT * FROM kais WHERE id = $1', [kaiId]);
    return result.rows.length > 0 ? rowToKai(result.rows[0]) : null;
  }

  async createKai(
    orgId: string,
    name: string,
    opts: { description?: string; domains?: string[]; topics?: string[]; knowledgeTypes?: string[]; createdBy?: string }
  ): Promise<Kai> {
    const id = 'kai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const result = await this.pool.query(
      `INSERT INTO kais (id, organization_id, created_by, name, description, domains, topics, knowledge_types)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        orgId,
        opts.createdBy || null,
        name,
        opts.description || null,
        opts.domains || [],
        opts.topics || [],
        opts.knowledgeTypes || [],
      ]
    );
    log.info('Kai created', { id, orgId, name });
    return rowToKai(result.rows[0]);
  }

  async updateKai(
    kaiId: string,
    updates: { name?: string; description?: string; domains?: string[]; topics?: string[]; knowledgeTypes?: string[] }
  ): Promise<Kai | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (updates.name !== undefined) { fields.push(`name = $${idx++}`); values.push(updates.name); }
    if (updates.description !== undefined) { fields.push(`description = $${idx++}`); values.push(updates.description); }
    if (updates.domains !== undefined) { fields.push(`domains = $${idx++}`); values.push(updates.domains); }
    if (updates.topics !== undefined) { fields.push(`topics = $${idx++}`); values.push(updates.topics); }
    if (updates.knowledgeTypes !== undefined) { fields.push(`knowledge_types = $${idx++}`); values.push(updates.knowledgeTypes); }

    if (fields.length === 0) return this.getKai(kaiId);

    fields.push(`updated_at = NOW()`);
    values.push(kaiId);

    const result = await this.pool.query(
      `UPDATE kais SET ${fields.join(', ')} WHERE id = $${idx} AND is_default = FALSE RETURNING *`,
      values
    );
    return result.rows.length > 0 ? rowToKai(result.rows[0]) : null;
  }

  async deleteKai(kaiId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM kais WHERE id = $1 AND is_default = FALSE',
      [kaiId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resolveFilters(kaiId: string): Promise<KaiFilters | null> {
    const kai = await this.getKai(kaiId);
    if (!kai) return null;
    return {
      domains: kai.domains,
      topics: kai.topics,
      knowledgeTypes: kai.knowledgeTypes,
    };
  }
}
