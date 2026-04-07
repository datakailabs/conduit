import type { TenantContext } from '../types/tenant.js';

/**
 * Assert the GraphQL context is authenticated.
 * Throws a standard error if not — eliminates repeated auth checks in resolvers.
 */
export function requireAuth(context: TenantContext): asserts context is TenantContext & { isAuthenticated: true } {
  if (!context.isAuthenticated) {
    throw new Error('Unauthorized');
  }
}

/**
 * Assert the GraphQL context has admin privileges.
 */
export function requireAdminContext(context: TenantContext): asserts context is TenantContext & { isAuthenticated: true; isAdmin: true } {
  if (!context.isAdmin) {
    throw new Error('Unauthorized: Admin access required');
  }
}
