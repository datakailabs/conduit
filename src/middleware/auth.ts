import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import type { ApiKeyStore, ApiKeyRecord } from '../clients/api-keys.js';
import { authConfig, platformConfig, tenantConfig, cognitoConfig } from '../config.js';
import { getCognitoVerifier } from './cognito-auth.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('auth');

// Extend Express Request with tenant info
declare global {
  namespace Express {
    interface Request {
      tenant?: {
        organizationId: string;
        keyId: string;
        keyType: 'api' | 'admin';
        scope: 'read' | 'write' | 'admin';
        cognitoSub?: string;
      };
    }
  }
}

/**
 * Bearer token authentication middleware with cookie fallback.
 * Tries: Bearer token → config keys → Cognito cookie.
 */
export function createBearerAuth(apiKeyStore: ApiKeyStore, pool?: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    // Try Bearer token first
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const record = apiKeyStore.findByPlaintextKey(token);
      if (record) {
        req.tenant = {
          organizationId: record.organizationId,
          keyId: record.keyId,
          keyType: record.keyType,
          scope: record.scope,
        };
        apiKeyStore.updateLastUsed(record.keyId);
        next();
        return;
      }

      if (!tenantConfig.isMultiTenant && (token === authConfig.apiKey || token === authConfig.adminKey)) {
        req.tenant = {
          organizationId: 'org_datakai',
          keyId: 'config',
          keyType: token === authConfig.adminKey ? 'admin' : 'api',
          scope: token === authConfig.adminKey ? 'admin' : 'read',
        };
        next();
        return;
      }
    }

    // Cookie fallback: Cognito session auth for console users
    if (cognitoConfig.enabled && pool) {
      const token = req.cookies?.conduit_id_token;
      if (token) {
        try {
          const claims = await getCognitoVerifier().verify(token);
          const result = await pool.query(
            'SELECT organization_id, role FROM console_users WHERE cognito_sub = $1 AND is_active = TRUE',
            [claims.sub]
          );
          if (result.rows.length > 0) {
            req.tenant = {
              organizationId: result.rows[0].organization_id,
              keyId: 'cognito_session',
              keyType: result.rows[0].role === 'owner' ? 'admin' : 'api',
              scope: result.rows[0].role === 'owner' ? 'admin' : 'write',
              cognitoSub: claims.sub as string,
            };
            next();
            return;
          }
        } catch {
          // Token invalid/expired — fall through
        }
      }
    }

    res.status(401).json({ error: 'Missing or invalid Authorization header' });
  };
}

/**
 * Require admin key type. Must be used after bearerAuth.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenant) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.tenant.keyType !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
}

/**
 * Require write or admin scope. Blocks read-only keys from mutations.
 * Must be used after bearerAuth.
 */
export function requireWrite(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenant) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.tenant.scope === 'read') {
    res.status(403).json({ error: 'Write access required. This key has read-only scope.' });
    return;
  }

  next();
}

/**
 * Platform key authentication middleware.
 * Validates against CONDUIT_PLATFORM_KEY env var.
 */
export function createPlatformAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!platformConfig.hasPlatformKey) {
      res.status(503).json({ error: 'Platform management not configured' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    if (token !== platformConfig.platformKey) {
      res.status(401).json({ error: 'Invalid platform key' });
      return;
    }

    next();
  };
}
