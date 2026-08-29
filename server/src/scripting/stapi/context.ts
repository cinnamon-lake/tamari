/**
 * Shared context handed to every st-api domain factory.
 *
 * `createStApi` builds one of these and passes it to each domain module, so
 * the closures the old god-factory captured (`chatId`, `checkAbort`, the dep
 * bag) are threaded explicitly instead.
 */

import type { ScriptContext } from '../ScriptContext.js';
import type { StApiDeps } from './types.js';

/** Branch fetch limit used when an operation needs the entire active branch — the "all messages" sentinel. */
export const FULL_BRANCH_MESSAGE_LIMIT = 10000;

export interface StApiContext {
  readonly ctx: ScriptContext;
  readonly deps: StApiDeps;
  readonly chatId: string;
  readonly checkAbort: () => void;
}

export function createStApiContext(ctx: ScriptContext, deps: StApiDeps): StApiContext {
  return {
    ctx,
    deps,
    chatId: ctx.chatId,
    checkAbort() {
      if (ctx.aborted) {
        throw new Error('Script aborted');
      }
    },
  };
}
