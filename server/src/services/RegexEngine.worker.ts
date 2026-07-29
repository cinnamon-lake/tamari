/**
 * Worker thread for regex execution with timeout protection.
 *
 * Runs regex replacement in an isolated thread so catastrophic
 * backtracking (ReDoS) cannot freeze the main event loop.
 */

import { parentPort } from 'node:worker_threads';

parentPort?.on('message', ({ text, pattern, flags, replaceString }: {
  text: string;
  pattern: string;
  flags: string;
  replaceString: string;
}) => {
  try {
    const regex = new RegExp(pattern, flags);
    const result = text.replace(regex, replaceString);
    parentPort?.postMessage({ result });
  } catch (err) {
    parentPort?.postMessage({
      error: err instanceof Error ? err.message : 'Regex execution failed',
    });
  }
});
