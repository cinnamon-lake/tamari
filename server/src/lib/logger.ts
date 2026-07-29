/**
 * Structured logging with pino.
 *
 * Reads LOG_LEVEL from environment (default: 'info').
 * Pretty-prints in development, JSON in production.
 */

import pino from 'pino';

const level = (process.env.LOG_LEVEL as pino.Level | undefined) ?? 'info';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level,
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
});

/**
 * Create a child logger with a component context.
 */
export function getLogger(component: string, extra?: Record<string, unknown>) {
  return logger.child({ component, ...extra });
}
