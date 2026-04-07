import { Router } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { generateOrgId } from '../services/keys.js';
import type { ApiKeyStore } from '../clients/api-keys.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('auth');

const signupSchema = z.object({
  organizationName: z.string().min(1).max(255),
  email: z.string().email(),
});

export function createAuthRouter(pool: Pool, apiKeyStore: ApiKeyStore): Router {
  const router = Router();

  // POST /api/v1/auth/signup — Self-service onboarding
  router.post('/signup', async (req, res) => {
    try {
      const body = signupSchema.parse(req.body);

      // Check for duplicate email
      const existing = await pool.query(
        'SELECT id FROM organizations WHERE email = $1 AND is_active = TRUE',
        [body.email]
      );
      if (existing.rows.length > 0) {
        res.status(409).json({ error: 'An organization with this email already exists' });
        return;
      }

      const orgId = generateOrgId();

      // Insert org with placeholder legacy columns
      const placeholderApi = `legacy_${orgId}_api`;
      const placeholderAdmin = `legacy_${orgId}_admin`;

      await pool.query(
        `INSERT INTO organizations (id, name, email, api_key, admin_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, body.organizationName, body.email, placeholderApi, placeholderAdmin]
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
        organizationId: orgId,
        organizationName: body.organizationName,
        email: body.email,
        apiKey: apiKey.plaintext,
        adminKey: adminKey.plaintext,
        message: 'Store these keys securely. They will not be shown again.',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Signup failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
