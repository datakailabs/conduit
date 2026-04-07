import { createHash, randomBytes } from 'crypto';

const KEY_PREFIX = 'cnd_';
const KEY_BYTES = 32;
const ID_BYTES = 12;

/**
 * Generate a new API key with cnd_ prefix.
 * Returns plaintext (shown once), hash (stored), and prefix (for display).
 */
export function generateApiKey(): {
  plaintext: string;
  hash: string;
  prefix: string;
} {
  const raw = randomBytes(KEY_BYTES).toString('hex');
  const plaintext = `${KEY_PREFIX}${raw}`;
  const hash = hashKey(plaintext);
  const prefix = `${KEY_PREFIX}${raw.slice(0, 8)}...`;

  return { plaintext, hash, prefix };
}

/**
 * SHA-256 hash of a plaintext key.
 */
export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Generate a unique key ID (key_...).
 */
export function generateKeyId(): string {
  return `key_${randomBytes(ID_BYTES).toString('hex')}`;
}

/**
 * Generate a unique organization ID (org_...).
 */
export function generateOrgId(): string {
  return `org_${randomBytes(ID_BYTES).toString('hex')}`;
}
