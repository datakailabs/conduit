import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ApiKeyStore } from '../clients/api-keys.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('api-keys');

const createKeySchema = z.object({
  keyType: z.enum(['api', 'admin']).default('api'),
});

type OrgParams = { id: string };
type KeyParams = { id: string; keyId: string };

export function createApiKeyRouter(apiKeyStore: ApiKeyStore): Router {
  const router = Router({ mergeParams: true });

  // POST /organizations/:id/keys — Generate new key
  router.post('/', async (req: Request<OrgParams>, res) => {
    try {
      const body = createKeySchema.parse(req.body);
      const orgId = req.params.id;

      const key = await apiKeyStore.createKey({
        organizationId: orgId,
        keyType: body.keyType,
      });

      res.status(201).json({
        keyId: key.keyId,
        key: key.plaintext,
        prefix: key.prefix,
        keyType: body.keyType,
        message: 'Store this key securely. It will not be shown again.',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      log.error('Failed to create key', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /organizations/:id/keys — List keys (prefix only)
  router.get('/', async (req: Request<OrgParams>, res) => {
    try {
      const keys = await apiKeyStore.listKeysForOrg(req.params.id);
      res.json({ keys });
    } catch (error) {
      log.error('Failed to list keys', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /organizations/:id/keys/:keyId — Revoke key
  router.delete('/:keyId', async (req: Request<KeyParams>, res) => {
    try {
      const revoked = await apiKeyStore.revokeKey(req.params.keyId);
      if (!revoked) {
        res.status(404).json({ error: 'Key not found or already revoked' });
        return;
      }
      res.json({ keyId: req.params.keyId, message: 'Key revoked' });
    } catch (error) {
      log.error('Failed to revoke key', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /organizations/:id/keys/:keyId/rotate — Revoke old + generate new
  router.post('/:keyId/rotate', async (req: Request<KeyParams>, res) => {
    try {
      // Get old key info to determine type
      const keys = await apiKeyStore.listKeysForOrg(req.params.id);
      const oldKey = keys.find((k) => k.id === req.params.keyId);
      if (!oldKey) {
        res.status(404).json({ error: 'Key not found' });
        return;
      }

      // Revoke old key
      await apiKeyStore.revokeKey(req.params.keyId);

      // Generate replacement
      const newKey = await apiKeyStore.createKey({
        organizationId: req.params.id,
        keyType: oldKey.keyType as 'api' | 'admin',
      });

      res.status(201).json({
        revokedKeyId: req.params.keyId,
        newKeyId: newKey.keyId,
        key: newKey.plaintext,
        prefix: newKey.prefix,
        keyType: oldKey.keyType,
        message: 'Old key revoked. Store the new key securely.',
      });
    } catch (error) {
      log.error('Failed to rotate key', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
