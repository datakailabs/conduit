import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { cognitoConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('cognito-auth');

export interface ConsoleUser {
  cognitoSub: string;
  email: string;
  organizationId: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      consoleUser?: ConsoleUser;
    }
  }
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

export function getCognitoVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: cognitoConfig.userPoolId,
      tokenUse: 'id',
      clientId: cognitoConfig.clientId,
    });
  }
  return verifier;
}

// Keep backward compat
const getVerifier = getCognitoVerifier;

export function createCognitoAuth(pool: Pool) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.conduit_id_token;
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const payload = await getVerifier().verify(token);

      const result = await pool.query(
        'SELECT organization_id, role FROM console_users WHERE cognito_sub = $1 AND is_active = TRUE',
        [payload.sub]
      );

      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'User not linked to an organization' });
      }

      req.consoleUser = {
        cognitoSub: payload.sub as string,
        email: payload.email as string,
        organizationId: result.rows[0].organization_id,
        role: result.rows[0].role,
      };

      next();
    } catch (err) {
      log.warn('Cognito token verification failed', { error: err instanceof Error ? err.message : String(err) });
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
