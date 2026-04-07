/**
 * Structured Logger — JSON in production, human-readable in development.
 *
 * Usage:
 *   import { logger } from '../lib/logger.js';
 *   logger.info('Server started', { port: 4000 });
 *   logger.error('Failed to connect', { error: err.message, db: 'postgres' });
 *
 * Output (production):
 *   {"ts":"2026-03-12T01:00:00.000Z","level":"info","msg":"Server started","port":4000}
 *
 * Output (development):
 *   [01:00:00] INFO  Server started port=4000
 */

import { serverConfig, logConfig } from '../config.js';

// ─── Types ──────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

// ─── Level Priority ─────────────────────────────────────────────────

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─── Formatters ─────────────────────────────────────────────────────

function formatJson(entry: LogEntry): string {
  return JSON.stringify(entry);
}

function formatDev(entry: LogEntry): string {
  const time = entry.ts.split('T')[1].split('.')[0];
  const level = entry.level.toUpperCase().padEnd(5);

  // Extract extra fields (everything except ts, level, msg)
  const { ts: _ts, level: _level, msg: _msg, ...extra } = entry;

  const fields = Object.entries(extra)
    .map(([k, v]) => {
      if (v instanceof Error) return `${k}=${v.message}`;
      if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
      return `${k}=${v}`;
    })
    .join(' ');

  return fields
    ? `[${time}] ${level} ${entry.msg} ${fields}`
    : `[${time}] ${level} ${entry.msg}`;
}

// ─── Logger Class ───────────────────────────────────────────────────

class Logger {
  private minLevel: number;
  private format: (entry: LogEntry) => string;
  private defaultContext: LogContext;

  constructor(context: LogContext = {}) {
    this.minLevel = LEVEL_PRIORITY[logConfig.level as LogLevel] ?? LEVEL_PRIORITY.info;
    this.format = serverConfig.nodeEnv === 'production' ? formatJson : formatDev;
    this.defaultContext = context;
  }

  private log(level: LogLevel, msg: string, context?: LogContext): void {
    if (LEVEL_PRIORITY[level] < this.minLevel) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.defaultContext,
      ...context,
    };

    const output = this.format(entry);

    if (level === 'error') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  debug(msg: string, context?: LogContext): void { this.log('debug', msg, context); }
  info(msg: string, context?: LogContext): void { this.log('info', msg, context); }
  warn(msg: string, context?: LogContext): void { this.log('warn', msg, context); }
  error(msg: string, context?: LogContext): void { this.log('error', msg, context); }

  /** Create a child logger with additional default context */
  child(context: LogContext): Logger {
    const child = new Logger({ ...this.defaultContext, ...context });
    return child;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

export const logger = new Logger();

/** Create a logger scoped to a component */
export function createLogger(component: string): Logger {
  return logger.child({ component });
}
