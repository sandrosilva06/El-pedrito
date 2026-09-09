import { env } from '../config/env';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL];

function emit(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  if (LEVELS[level] < threshold) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;

  if (meta === undefined) {
    console[level === 'debug' ? 'log' : level](line);
    return;
  }

  console[level === 'debug' ? 'log' : level](line, meta);
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => emit('debug', scope, message, meta),
    info: (message, meta) => emit('info', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    error: (message, meta) => emit('error', scope, message, meta),
  };
}
