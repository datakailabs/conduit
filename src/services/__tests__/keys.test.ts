import { describe, it, expect } from 'vitest';
import { generateApiKey, hashKey, generateKeyId, generateOrgId } from '../keys.js';

describe('Key Utilities', () => {
  describe('generateApiKey', () => {
    it('returns plaintext with cnd_ prefix', () => {
      const { plaintext } = generateApiKey();
      expect(plaintext).toMatch(/^cnd_[a-f0-9]{64}$/);
    });

    it('returns a SHA-256 hash (64 hex chars)', () => {
      const { hash } = generateApiKey();
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns a display-safe prefix', () => {
      const { prefix } = generateApiKey();
      expect(prefix).toMatch(/^cnd_[a-f0-9]{8}\.\.\.$/);
    });

    it('hash matches hashKey of plaintext', () => {
      const { plaintext, hash } = generateApiKey();
      expect(hashKey(plaintext)).toBe(hash);
    });

    it('generates unique keys each call', () => {
      const a = generateApiKey();
      const b = generateApiKey();
      expect(a.plaintext).not.toBe(b.plaintext);
      expect(a.hash).not.toBe(b.hash);
    });
  });

  describe('hashKey', () => {
    it('produces consistent hash for same input', () => {
      const key = 'cnd_test1234567890abcdef';
      expect(hashKey(key)).toBe(hashKey(key));
    });

    it('produces different hashes for different inputs', () => {
      expect(hashKey('key_a')).not.toBe(hashKey('key_b'));
    });
  });

  describe('generateKeyId', () => {
    it('returns key_ prefixed ID', () => {
      const id = generateKeyId();
      expect(id).toMatch(/^key_[a-f0-9]{24}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateKeyId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('generateOrgId', () => {
    it('returns org_ prefixed ID', () => {
      const id = generateOrgId();
      expect(id).toMatch(/^org_[a-f0-9]{24}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateOrgId()));
      expect(ids.size).toBe(100);
    });
  });
});
