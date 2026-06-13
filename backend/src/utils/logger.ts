/**
 * Shared structured logger (pino). One instance for the whole process.
 *
 * We use plain JSON output (no transport worker) for portability — it works
 * identically on Windows, in Docker, and under tsx without extra deps.
 */
import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.http.logLevel,
});

/** Create a child logger bound to a component name. */
export function childLogger(component: string) {
  return logger.child({ component });
}
