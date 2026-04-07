import { config as loadEnv } from 'dotenv';
import { homedir } from 'os';
import { z } from 'zod';

// Expand ~ to home directory
function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return path.replace('~', homedir());
  }
  return path;
}

// Load .env file
loadEnv();

// Validate environment variables
const envSchema = z.object({
  // Server
  PORT: z.string().default('4000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // ArangoDB (Graph Database)
  ARANGO_URL: z.string().url().default('http://localhost:8529'),
  ARANGO_DATABASE: z.string().default('conduit'),
  ARANGO_USERNAME: z.string().default('root'),
  ARANGO_PASSWORD: z.string().optional(),

  // PostgreSQL (with pgvector for vector storage)
  // Supports DATABASE_URL or individual settings
  DATABASE_URL: z.string().optional(),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string().default('conduit'),
  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_DB: z.string().default('conduit'),
  POSTGRES_SSL: z.enum(['require', 'prefer', 'disable']).default('disable'),

  // Embeddings Provider Selection
  // 'openai' for production, 'ollama' for development
  EMBEDDINGS_PROVIDER: z.enum(['openai', 'ollama']).default('ollama'),

  // OpenAI Embeddings (required if EMBEDDINGS_PROVIDER=openai)
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBED_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_EMBED_DIMENSIONS: z.coerce.number().default(1536),

  // Ollama Embeddings (required if EMBEDDINGS_PROVIDER=ollama)
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_EMBED_MODEL: z.string().default('nomic-embed-text'),
  OLLAMA_EMBED_DIMENSIONS: z.coerce.number().default(768),

  // Knowledge Extraction (LLM-powered)
  EXTRACTION_PROVIDER: z.enum(['openai', 'ollama']).default('openai'),
  EXTRACTION_MODEL: z.string().default('gpt-4o-mini'),
  EXTRACTION_MAX_TOKENS: z.coerce.number().default(4096),
  OLLAMA_LLM_MODEL: z.string().default('llama3.1'),
  EXTRACTION_DEDUP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

  // Scriptorium
  SCRIPTORIUM_PATH: z.string(),

  // Authentication
  CONDUIT_API_KEY: z.string().min(32),
  CONDUIT_ADMIN_KEY: z.string().min(32),

  // Platform key (for org management endpoints)
  CONDUIT_PLATFORM_KEY: z.string().min(32).optional(),

  // Multi-tenancy
  MULTI_TENANT_MODE: z.enum(['single', 'multi']).default('single'),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Slack Integration (optional)
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  // Teams Integration (optional)
  TEAMS_APP_ID: z.string().optional(),
  TEAMS_APP_PASSWORD: z.string().optional(),

  // Cognito (console auth)
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  COGNITO_DOMAIN: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

// Parse and validate
function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = parseEnv();

// Export individual config sections
export const serverConfig = {
  port: parseInt(config.PORT),
  nodeEnv: config.NODE_ENV,
  isProduction: config.NODE_ENV === 'production',
  isDevelopment: config.NODE_ENV === 'development',
};

// ArangoDB connection config
export const arangoConfig = {
  url: config.ARANGO_URL,
  database: config.ARANGO_DATABASE,
  username: config.ARANGO_USERNAME,
  password: config.ARANGO_PASSWORD,
};

// PostgreSQL connection config
// Supports DATABASE_URL (production) or individual settings (development)
export const postgresConfig = {
  // Full connection URL takes precedence (production pattern)
  connectionString: config.DATABASE_URL,

  // Individual settings (fallback for local dev)
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  database: config.POSTGRES_DB,

  // SSL mode: 'require' for production, 'disable' for local
  ssl:
    config.POSTGRES_SSL === 'require'
      ? { rejectUnauthorized: false }
      : config.POSTGRES_SSL === 'prefer'
        ? { rejectUnauthorized: false }
        : false,
};

// Embeddings configuration with provider abstraction
export const embeddingsConfig = {
  provider: config.EMBEDDINGS_PROVIDER,

  // OpenAI config (used when provider='openai')
  openai: config.OPENAI_API_KEY
    ? {
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_EMBED_MODEL,
        dimensions: config.OPENAI_EMBED_DIMENSIONS,
      }
    : undefined,

  // Ollama config (used when provider='ollama')
  ollama: {
    url: config.OLLAMA_URL,
    model: config.OLLAMA_EMBED_MODEL,
    dimensions: config.OLLAMA_EMBED_DIMENSIONS,
  },

  // Current dimensions (for vector DB schema)
  get dimensions(): number {
    if (this.provider === 'openai' && this.openai) {
      return this.openai.dimensions;
    }
    return this.ollama.dimensions;
  },
};

export const scriptoriumConfig = {
  zettelPath: expandTilde(config.SCRIPTORIUM_PATH),
};

export const authConfig = {
  apiKey: config.CONDUIT_API_KEY,
  adminKey: config.CONDUIT_ADMIN_KEY,
};

export const tenantConfig = {
  mode: config.MULTI_TENANT_MODE,
  isMultiTenant: config.MULTI_TENANT_MODE === 'multi',
};

export const platformConfig = {
  platformKey: config.CONDUIT_PLATFORM_KEY,
  hasPlatformKey: !!config.CONDUIT_PLATFORM_KEY,
};

export const logConfig = {
  level: config.LOG_LEVEL,
};

export const integrationsConfig = {
  slack: {
    enabled: !!config.SLACK_BOT_TOKEN && !!config.SLACK_SIGNING_SECRET,
    botToken: config.SLACK_BOT_TOKEN || '',
    signingSecret: config.SLACK_SIGNING_SECRET || '',
  },
  teams: {
    enabled: !!config.TEAMS_APP_ID && !!config.TEAMS_APP_PASSWORD,
    appId: config.TEAMS_APP_ID || '',
    appPassword: config.TEAMS_APP_PASSWORD || '',
  },
};

export const cognitoConfig = {
  userPoolId: config.COGNITO_USER_POOL_ID || '',
  clientId: config.COGNITO_CLIENT_ID || '',
  domain: config.COGNITO_DOMAIN || '',
  enabled: !!(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID && config.COGNITO_DOMAIN),
};

export const extractionConfig = {
  provider: config.EXTRACTION_PROVIDER,
  model: config.EXTRACTION_PROVIDER === 'openai' ? config.EXTRACTION_MODEL : config.OLLAMA_LLM_MODEL,
  maxTokens: config.EXTRACTION_MAX_TOKENS,
  dedupThreshold: config.EXTRACTION_DEDUP_THRESHOLD,

  // OpenAI-compatible client config (works for both OpenAI and Ollama /v1)
  get clientConfig(): { apiKey: string; baseURL?: string } {
    if (this.provider === 'openai') {
      return { apiKey: config.OPENAI_API_KEY || '' };
    }
    return {
      apiKey: 'ollama',
      baseURL: `${config.OLLAMA_URL}/v1`,
    };
  },
};
