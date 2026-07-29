/**
 * Repository call logger — wraps repository instances to log
 * every method invocation with arguments and timing.
 *
 * Does NOT log SQL queries; logs the repository function name
 * and sanitized arguments.
 */

import { getLogger } from './logger.js';

const log = getLogger('repos');

/**
 * Wrap a repository so that every async method is logged at debug level.
 */
export function withLogging<T extends object>(repo: T, entity: string): T {
  const child = log.child({ entity });
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') {
        return value;
      }
      // Skip private helpers and internal methods
      if (prop.startsWith('_') || prop === 'constructor') {
        return value;
      }
      return function (this: unknown, ...args: unknown[]) {
        const start = Date.now();
        child.debug({ method: prop, args: sanitizeArgs(args) }, `${entity}.${prop} →`);
        const result: unknown = value.apply(this === receiver ? target : this, args);
        if (result instanceof Promise) {
          return result
            .then((r: unknown) => {
              child.debug(
                { method: prop, duration_ms: Date.now() - start },
                `${entity}.${prop} ← ok (${Date.now() - start}ms)`,
              );
              return r;
            })
            .catch((err: unknown) => {
              child.debug(
                {
                  method: prop,
                  duration_ms: Date.now() - start,
                  err: err instanceof Error ? err.message : String(err),
                },
                `${entity}.${prop} ← error (${Date.now() - start}ms)`,
              );
              throw err;
            });
        }
        child.debug(
          { method: prop, duration_ms: Date.now() - start },
          `${entity}.${prop} ← sync (${Date.now() - start}ms)`,
        );
        return result;
      };
    },
  });
}

function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (!arg || typeof arg !== 'object') return arg;
    // Shallow clone and redact
    const clone: Record<string, unknown> = { ...(arg as Record<string, unknown>) };
    for (const key of ['apiKey', 'apiKey', 'password', 'secret', 'token']) {
      if (key in clone) clone[key] = '[REDACTED]';
    }
    // Truncate large objects
    const keys = Object.keys(clone);
    if (keys.length > 20) {
      return {
        ...Object.fromEntries(keys.slice(0, 20).map((k) => [k, clone[k]])),
        '...': `[${keys.length - 20} more keys]`,
      };
    }
    return clone;
  });
}
