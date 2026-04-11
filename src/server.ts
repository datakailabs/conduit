import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolvers } from './resolvers/index.js';
import { postgres } from './clients/postgres.js';
import { arangoClient } from './clients/arango/index.js';
import { OrganizationStore } from './clients/organizations.js';
import { ApiKeyStore } from './clients/api-keys.js';
import { serverConfig, authConfig, tenantConfig, integrationsConfig, cognitoConfig } from './config.js';
import { createBearerAuth, requireAdmin, requireWrite, createPlatformAuth } from './middleware/auth.js';
import { UsageMeter } from './middleware/usage.js';
import { ChatLogger } from './middleware/chat-logger.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { requestLogger } from './middleware/request-log.js';
import { metricsMiddleware, metrics } from './middleware/metrics.js';
import { logger, createLogger } from './lib/logger.js';
import { createOrganizationRouter } from './routes/organizations.js';
import { createApiKeyRouter } from './routes/api-keys.js';
import { createContextRouter } from './routes/context.js';
import { createAuthRouter } from './routes/auth.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createExtractRouter } from './routes/extract.js';
import { createAskRouter } from './routes/ask.js';
import { createInsightsRouter } from './routes/insights.js';
import { ThreadResolver } from './services/thread-resolver.js';
import { InsightsService } from './services/insights.js';
import { createZettelsRouter } from './routes/zettels.js';
import { createConnectorsRouter } from './routes/connectors.js';
import { createConceptsRouter } from './routes/concepts.js';
import { createSlackRouter } from './routes/slack.js';
import { createTeamsRouter } from './routes/teams.js';
import { createConsoleAuthRouter, createConsoleRouter } from './routes/console-auth.js';
import { createCognitoAuth, getCognitoVerifier } from './middleware/cognito-auth.js';
import { KaiStore } from './clients/kais.js';
import { graphRAGService } from './services/graphrag.js';
import type { TenantContext } from './types/tenant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load GraphQL schema
const typeDefs = readFileSync(
  join(__dirname, '../api/schema.graphql'),
  'utf-8'
);

const log = createLogger('server');

async function startServer() {
  // Initialize databases
  log.info('Starting Conduit', { tenantMode: tenantConfig.mode });

  try {
    await Promise.all([
      postgres.initialize(),
      arangoClient.initialize(),
    ]);

    log.info('Databases initialized');
  } catch (error) {
    log.error('Failed to initialize databases', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }

  const pool = postgres.getPool();

  // Initialize OrganizationStore (legacy — backward compat for GraphQL)
  const organizationStore = new OrganizationStore(pool);
  try {
    await organizationStore.initialize(authConfig.apiKey, authConfig.adminKey);
  } catch (error) {
    log.error('Failed to initialize OrganizationStore', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }

  // Initialize ApiKeyStore (new — hashed key auth for REST API)
  const apiKeyStore = new ApiKeyStore(pool);
  try {
    await apiKeyStore.initialize();
  } catch (error) {
    log.error('Failed to initialize ApiKeyStore', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }

  // Initialize UsageMeter, ChatLogger, ThreadResolver, and InsightsService
  const usageMeter = new UsageMeter(pool);
  const chatLogger = new ChatLogger(pool);
  const threadResolver = new ThreadResolver(pool);
  const insightsService = new InsightsService(pool);

  // Create Express app
  const app = express();

  // Global middleware — CORS
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : undefined; // undefined = allow all (dev mode)

  app.use(cors({
    origin: allowedOrigins || true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Kai-Id'],
    credentials: true,
  }));

  app.use(cookieParser());

  // ─── Chat Integrations (before json parser — need raw body for signature verification)
  if (integrationsConfig.slack.enabled) {
    app.use('/api/v1/integrations/slack', createSlackRouter({
      botToken: integrationsConfig.slack.botToken,
      signingSecret: integrationsConfig.slack.signingSecret,
      orgId: 'org_datakai',
    }));
    log.info('Slack integration enabled');
  }

  if (integrationsConfig.teams.enabled) {
    app.use('/api/v1/integrations/teams', createTeamsRouter({
      appId: integrationsConfig.teams.appId,
      appPassword: integrationsConfig.teams.appPassword,
      orgId: 'org_datakai',
    }));
    log.info('Teams integration enabled');
  }

  app.use(express.json());
  app.use(requestLogger);
  app.use(metricsMiddleware);

  // Conduit Console (static UI — no cache during development)
  app.use('/static', express.static(join(__dirname, 'public'), { etag: false, lastModified: false }));
  app.get('/console', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, 'public', 'index.html'));
  });

  // Landing page
  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, 'public', 'landing.html'));
  });

  // Health check + observability endpoints
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  app.get('/metrics', (_req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.serialize());
  });

  // Register cache stats with metrics collector
  metrics.registerExternalStats('cache', () => {
    const stats = graphRAGService.getCacheStats();
    return { size: stats.size, hits: stats.hits, misses: stats.misses, evictions: stats.evictions };
  });

  app.get('/ready', async (_req, res) => {
    try {
      await Promise.race([
        Promise.all([postgres.getStats(), arangoClient.getStats()]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Health check timeout')), 2000)
        )
      ]);

      res.status(200).json({
        status: 'ready',
        timestamp: new Date().toISOString(),
        databases: { postgres: 'connected', arangodb: 'connected' }
      });
    } catch (error) {
      res.status(503).json({
        status: 'not ready',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // ─── REST API Routes ───────────────────────────────────────────────

  // Auth (no authentication required)
  app.use('/api/v1/auth', createAuthRouter(pool, apiKeyStore));

  // Console auth (Cognito OAuth flow)
  if (cognitoConfig.enabled) {
    app.use('/api/v1/auth', createConsoleAuthRouter(pool, apiKeyStore));
    const cognitoAuth = createCognitoAuth(pool);
    app.use('/api/v1/console', cognitoAuth, createConsoleRouter(pool, apiKeyStore));
    log.info('Console auth enabled (Cognito)');
  }

  // Organization management (platform key required)
  const platformAuth = createPlatformAuth();
  app.use('/api/v1/organizations/:id/keys', platformAuth, createApiKeyRouter(apiKeyStore));
  app.use('/api/v1/organizations', platformAuth, createOrganizationRouter(pool, apiKeyStore));

  // Context endpoint (bearer auth required — core product)
  const bearerAuth = createBearerAuth(apiKeyStore, pool);
  const rateLimiter = createRateLimiter();

  app.use('/api/v1/context', bearerAuth, rateLimiter, createContextRouter(usageMeter));

  // Extract endpoint (bearer auth + write required — knowledge extraction)
  app.use('/api/v1/extract', bearerAuth, requireWrite, rateLimiter, createExtractRouter(usageMeter));

  // Ask endpoint (bearer auth required — GraphRAG + LLM synthesis)
  app.use('/api/v1/ask', bearerAuth, rateLimiter, createAskRouter(usageMeter, chatLogger, threadResolver));

  // Insights endpoint (bearer auth required — cross-domain synthesis)
  app.use('/api/v1/insights', bearerAuth, rateLimiter, createInsightsRouter(insightsService));

  // Zettel CRUD (bearer auth required — source inspection + editing)
  app.use('/api/v1/zettels', bearerAuth, rateLimiter, createZettelsRouter());

  // Connectors (bearer auth + write required — data source sync)
  app.use('/api/v1/connectors', bearerAuth, requireWrite, rateLimiter, createConnectorsRouter(usageMeter, pool));

  // Concept matching (bearer auth required — Dojo integration)
  app.use('/api/v1/concepts', bearerAuth, rateLimiter, createConceptsRouter(usageMeter));

  // Dashboard (bearer auth + admin required)
  app.use('/api/v1/dashboard', bearerAuth, rateLimiter, requireAdmin, createDashboardRouter(usageMeter));

  // ─── GraphQL ───────────────────────────────────────────────────────

  const server = new ApolloServer<TenantContext>({
    typeDefs,
    resolvers,
  });

  await server.start();

  // Kai store for filter resolution
  const kaiStore = new KaiStore(pool);

  // Apply Apollo middleware with tenant-aware authentication
  // Tries ApiKeyStore first, falls back to OrganizationStore for backward compatibility
  app.use(
    '/graphql',
    expressMiddleware(server, {
      context: async ({ req }): Promise<TenantContext> => {
        const authHeader = req.headers.authorization || '';
        const apiKey = authHeader.replace('Bearer ', '');

        let ctx: TenantContext = {
          organizationId: 'org_datakai',
          isAuthenticated: false,
          isAdmin: false,
        };

        // Try ApiKeyStore first (new hashed keys)
        const record = apiKeyStore.findByPlaintextKey(apiKey);
        if (record) {
          apiKeyStore.updateLastUsed(record.keyId);
          ctx = {
            organizationId: record.organizationId,
            isAuthenticated: true,
            isAdmin: record.keyType === 'admin',
          };
        } else if (tenantConfig.isMultiTenant) {
          // Multi-tenant mode: look up org by API key (legacy OrganizationStore)
          const org = organizationStore.findByKey(apiKey);
          if (org) {
            ctx = {
              organizationId: org.id,
              isAuthenticated: true,
              isAdmin: organizationStore.isAdminKey(apiKey, org),
            };
          }
        } else {
          // Single-tenant mode: validate against config keys
          const isAuth = apiKey === authConfig.apiKey || apiKey === authConfig.adminKey;
          if (isAuth) {
            ctx = {
              organizationId: 'org_datakai',
              isAuthenticated: true,
              isAdmin: apiKey === authConfig.adminKey,
            };
          }
        }

        // Cookie fallback: Cognito session auth for console users
        if (!ctx.isAuthenticated && cognitoConfig.enabled) {
          const token = req.cookies?.conduit_id_token;
          if (token) {
            try {
              const claims = await getCognitoVerifier().verify(token);
              const user = await pool.query(
                'SELECT organization_id, role FROM console_users WHERE cognito_sub = $1 AND is_active = TRUE',
                [claims.sub]
              );
              if (user.rows.length > 0) {
                ctx = {
                  organizationId: user.rows[0].organization_id,
                  isAuthenticated: true,
                  isAdmin: user.rows[0].role === 'owner',
                };
              }
            } catch {
              // Token invalid/expired
            }
          }
        }

        // Resolve Kai filters if X-Kai-Id header present
        const kaiId = req.headers['x-kai-id'] as string | undefined;
        if (kaiId && ctx.isAuthenticated) {
          const filters = await kaiStore.resolveFilters(kaiId);
          if (filters) {
            ctx.kaiId = kaiId;
            ctx.kaiFilters = filters;
          }
        }

        return ctx;
      },
    })
  );

  // Start HTTP server
  const httpServer = app.listen(serverConfig.port, () => {
    log.info('Conduit ready', {
      url: `http://localhost:${serverConfig.port}/`,
      env: serverConfig.nodeEnv,
      endpoints: [
        'POST /api/v1/auth/signup',
        'POST /api/v1/context',
        'POST /api/v1/ask',
        'POST /api/v1/extract',
        'POST /api/v1/connectors/sync',
        'POST /api/v1/concepts/match',
        'GET  /api/v1/dashboard/stats',
        'POST /graphql',
        ...(cognitoConfig.enabled ? ['GET  /api/v1/auth/cognito/login', 'GET  /api/v1/auth/me'] : []),
        ...(integrationsConfig.slack.enabled ? ['POST /api/v1/integrations/slack/commands'] : []),
        ...(integrationsConfig.teams.enabled ? ['POST /api/v1/integrations/teams/messages'] : []),
      ],
    });
  });

  return httpServer;
}

// Handle shutdown gracefully
const shutdown = async () => {
  log.info('Shutting down Conduit');
  await Promise.all([
    postgres.close(),
    arangoClient.close(),
  ]);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the server
startServer().catch((error) => {
  log.error('Failed to start server', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
