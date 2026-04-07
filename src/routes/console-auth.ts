import { Router } from 'express';
import type { Pool } from 'pg';
import { cognitoConfig, serverConfig, tenantConfig } from '../config.js';
import { generateOrgId } from '../services/keys.js';
import type { ApiKeyStore } from '../clients/api-keys.js';
import { createCognitoAuth } from '../middleware/cognito-auth.js';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { randomBytes } from 'crypto';
import { createLogger } from '../lib/logger.js';

const log = createLogger('console-auth');

function getBaseUrl(req: { protocol: string; get(name: string): string | undefined }) {
  if (serverConfig.nodeEnv === 'production') {
    return 'https://conduit.datakai.net';
  }
  return `${req.protocol}://${req.get('host')}`;
}

export function createConsoleAuthRouter(pool: Pool, apiKeyStore: ApiKeyStore): Router {
  const router = Router();
  const cognitoAuth = createCognitoAuth(pool);

  // Public — tells the frontend whether Cognito is enabled
  router.get('/config', (_req, res) => {
    res.json({
      cognitoEnabled: cognitoConfig.enabled,
      loginUrl: cognitoConfig.enabled ? '/api/v1/auth/cognito/login' : null,
    });
  });

  // Redirect to Cognito Hosted UI
  router.get('/cognito/login', (req, res) => {
    const base = getBaseUrl(req);
    const url = new URL(`https://${cognitoConfig.domain}/oauth2/authorize`);
    url.searchParams.set('client_id', cognitoConfig.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('redirect_uri', `${base}/api/v1/auth/callback`);
    res.redirect(url.toString());
  });

  // OAuth callback — exchange code for tokens
  router.get('/callback', async (req, res) => {
    const code = req.query.code as string;
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }

    const base = getBaseUrl(req);

    try {
      // Exchange code for tokens
      const tokenResponse = await fetch(`https://${cognitoConfig.domain}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: cognitoConfig.clientId,
          code,
          redirect_uri: `${base}/api/v1/auth/callback`,
        }),
      });

      if (!tokenResponse.ok) {
        const err = await tokenResponse.text();
        log.error('Token exchange failed', { status: tokenResponse.status, error: err });
        return res.status(401).send('Authentication failed');
      }

      const tokens = await tokenResponse.json() as {
        id_token: string;
        access_token: string;
        refresh_token?: string;
      };

      // Verify the ID token
      const verifier = CognitoJwtVerifier.create({
        userPoolId: cognitoConfig.userPoolId,
        tokenUse: 'id' as const,
        clientId: cognitoConfig.clientId,
      });
      const payload = await verifier.verify(tokens.id_token);
      const cognitoSub = payload.sub as string;
      const email = payload.email as string;

      // Check if user exists
      const existing = await pool.query(
        'SELECT id, organization_id FROM console_users WHERE cognito_sub = $1',
        [cognitoSub]
      );

      if (existing.rows.length > 0) {
        // Existing user — update last login
        await pool.query(
          'UPDATE console_users SET last_login_at = NOW() WHERE cognito_sub = $1',
          [cognitoSub]
        );

        // Single-tenant: ensure user is assigned to the correct org
        if (!tenantConfig.isMultiTenant && existing.rows[0].organization_id !== 'org_datakai') {
          const oldOrg = existing.rows[0].organization_id;
          await pool.query(
            'UPDATE console_users SET organization_id = $1 WHERE cognito_sub = $2',
            ['org_datakai', cognitoSub]
          );
          // Reassign their keys to the correct org
          await pool.query(
            'UPDATE api_keys SET organization_id = $1 WHERE organization_id = $2',
            ['org_datakai', oldOrg]
          );
          // Reload key cache so reassigned keys work immediately
          await apiKeyStore.initialize();
          log.info('Migrated console user to org_datakai', { cognitoSub, oldOrg });
        }
      } else {
        // New user — assign to existing org in single-tenant mode, or create new org
        let orgId: string;

        if (!tenantConfig.isMultiTenant) {
          // Single-tenant: assign to the default org where all data lives
          orgId = 'org_datakai';
          // Ensure org row exists (idempotent)
          await pool.query(
            `INSERT INTO organizations (id, name, email, api_key, admin_key)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO NOTHING`,
            [orgId, 'DataKai', email, `legacy_${orgId}_api`, `legacy_${orgId}_admin`]
          );
        } else {
          orgId = generateOrgId();
          const orgName = email.split('@')[0];
          const placeholderApi = `legacy_${orgId}_api`;
          const placeholderAdmin = `legacy_${orgId}_admin`;
          await pool.query(
            `INSERT INTO organizations (id, name, email, api_key, admin_key)
             VALUES ($1, $2, $3, $4, $5)`,
            [orgId, orgName, email, placeholderApi, placeholderAdmin]
          );
        }

        const userId = `user_${randomBytes(12).toString('hex')}`;
        await pool.query(
          `INSERT INTO console_users (id, cognito_sub, email, organization_id, role, last_login_at)
           VALUES ($1, $2, $3, $4, 'owner', NOW())`,
          [userId, cognitoSub, email, orgId]
        );

        // Generate initial API + admin keys
        await apiKeyStore.createKey({ organizationId: orgId, keyType: 'api' });
        await apiKeyStore.createKey({ organizationId: orgId, keyType: 'admin' });

        log.info('New console user created', { userId, orgId, email });
      }

      // Set HTTP-only cookies
      const isProduction = serverConfig.nodeEnv === 'production';
      const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax' as const,
        path: '/',
        maxAge: 3600 * 1000, // 1 hour (matches Cognito ID token expiry)
      };

      res.cookie('conduit_id_token', tokens.id_token, cookieOptions);
      if (tokens.refresh_token) {
        res.cookie('conduit_refresh_token', tokens.refresh_token, {
          ...cookieOptions,
          maxAge: 30 * 24 * 3600 * 1000, // 30 days
        });
      }

      res.redirect('/console');
    } catch (err) {
      log.error('OAuth callback failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).send('Authentication failed');
    }
  });

  // Get current user info (protected)
  router.get('/me', cognitoAuth, async (req, res) => {
    const user = req.consoleUser!;
    const org = await pool.query(
      'SELECT id, name, email, created_at FROM organizations WHERE id = $1',
      [user.organizationId]
    );

    res.json({
      email: user.email,
      role: user.role,
      organization: org.rows[0] || null,
    });
  });

  // Logout — clear cookies
  router.post('/logout', (_req, res) => {
    res.clearCookie('conduit_id_token', { path: '/' });
    res.clearCookie('conduit_refresh_token', { path: '/' });
    res.json({ ok: true });
  });

  return router;
}

// Console key management routes (all protected by cognitoAuth)
export function createConsoleRouter(pool: Pool, apiKeyStore: ApiKeyStore): Router {
  const router = Router();

  // List keys for user's org
  router.get('/keys', async (req, res) => {
    const orgId = req.consoleUser!.organizationId;
    const result = await pool.query(
      `SELECT id, key_prefix, key_type, scope, kai_ids, is_active, created_at, last_used_at, revoked_at
       FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC`,
      [orgId]
    );
    res.json({ keys: result.rows });
  });

  // Create new key
  router.post('/keys', async (req, res) => {
    const orgId = req.consoleUser!.organizationId;
    const keyType = req.body?.keyType === 'admin' ? 'admin' : 'api';
    const validScopes = ['read', 'write', 'admin'] as const;
    const scope = validScopes.includes(req.body?.scope) ? req.body.scope : (keyType === 'admin' ? 'admin' : 'read');
    const kaiIds = Array.isArray(req.body?.kaiIds) ? req.body.kaiIds : [];

    const key = await apiKeyStore.createKey({ organizationId: orgId, keyType, scope, kaiIds });
    res.status(201).json({
      id: key.keyId,
      plaintext: key.plaintext,
      prefix: key.prefix,
      keyType,
      scope,
      kaiIds,
      message: 'Store this key securely. It will not be shown again.',
    });
  });

  // Revoke key
  router.delete('/keys/:keyId', async (req, res) => {
    const orgId = req.consoleUser!.organizationId;
    const keyId = req.params.keyId;

    // Verify key belongs to user's org
    const result = await pool.query(
      'UPDATE api_keys SET is_active = FALSE, revoked_at = NOW() WHERE id = $1 AND organization_id = $2 RETURNING id',
      [keyId, orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found' });
    }

    res.json({ ok: true, revoked: keyId });
  });

  return router;
}
