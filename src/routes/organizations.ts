import { Router } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { generateOrgId } from '../services/keys.js';
import type { ApiKeyStore } from '../clients/api-keys.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('organizations');

const createOrgSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().optional(),
});

const updateOrgSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().optional(),
});

export function createOrganizationRouter(pool: Pool, apiKeyStore: ApiKeyStore): Router {
  const router = Router();

  // POST / — Create a new organization with API + admin key pair
  router.post('/', async (req, res) => {
    try {
      const body = createOrgSchema.parse(req.body);
      const orgId = generateOrgId();

      // Insert org with placeholder legacy columns
      const placeholderApi = `legacy_${orgId}_api`;
      const placeholderAdmin = `legacy_${orgId}_admin`;

      await pool.query(
        `INSERT INTO organizations (id, name, email, api_key, admin_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, body.name, body.email ?? null, placeholderApi, placeholderAdmin]
      );

      // Generate API + admin keys
      const apiKey = await apiKeyStore.createKey({
        organizationId: orgId,
        keyType: 'api',
      });
      const adminKey = await apiKeyStore.createKey({
        organizationId: orgId,
        keyType: 'admin',
      });

      res.status(201).json({
        id: orgId,
        name: body.name,
        email: body.email ?? null,
        apiKey: apiKey.plaintext,
        adminKey: adminKey.plaintext,
        message: 'Store these keys securely. They will not be shown again.',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Failed to create organization', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /:id — Get organization details (no keys)
  router.get('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, name, email, is_active, created_at, updated_at
         FROM organizations WHERE id = $1`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Organization not found' });
        return;
      }

      const row = result.rows[0];
      res.json({
        id: row.id,
        name: row.name,
        email: row.email,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      });
    } catch (error) {
      log.error('Failed to get organization', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /:id — Update organization name/email
  router.patch('/:id', async (req, res) => {
    try {
      const body = updateOrgSchema.parse(req.body);
      if (!body.name && !body.email) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (body.name) {
        sets.push(`name = $${idx++}`);
        params.push(body.name);
      }
      if (body.email) {
        sets.push(`email = $${idx++}`);
        params.push(body.email);
      }
      sets.push(`updated_at = NOW()`);
      params.push(req.params.id);

      const result = await pool.query(
        `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name, email`,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Organization not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Failed to update organization', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /:id — Soft-delete (deactivate)
  router.delete('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE organizations SET is_active = FALSE, updated_at = NOW()
         WHERE id = $1 AND is_active = TRUE
         RETURNING id`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Organization not found or already inactive' });
        return;
      }

      // Evict all keys from cache
      await apiKeyStore.evictOrg(req.params.id);

      // Revoke all active keys in DB
      await pool.query(
        `UPDATE api_keys SET is_active = FALSE, revoked_at = NOW()
         WHERE organization_id = $1 AND is_active = TRUE`,
        [req.params.id]
      );

      res.json({ id: req.params.id, message: 'Organization deactivated' });
    } catch (error) {
      log.error('Failed to delete organization', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
