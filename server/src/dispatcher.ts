/**
 * Client message dispatcher.
 *
 * Maps incoming WebSocket messages to repository mutations and broadcasts.
 * The per-domain handler implementations live under `dispatch/`; this module
 * owns the cross-cutting guards (auth, generation rate limiting) and composes
 * the domain handler subsets into an exhaustive `HandlerMap` — a missing
 * message type fails to compile, replacing the old switch's `never` check.
 */

import type { ClientMessage } from '@tamari/types';
import type { ClientConnection } from './bus/EventBus.js';
import { SlidingWindowRateLimiter } from './lib/RateLimiter.js';
import { ValidationError } from './errors.js';
import type { DispatcherDeps, HandlerMap, MessageHandler } from './dispatch/types.js';
import { buildAuthHandlers } from './dispatch/authHandlers.js';
import { buildChatHandlers } from './dispatch/chatHandlers.js';
import { buildMessageHandlers } from './dispatch/messageHandlers.js';
import { buildGenerationHandlers } from './dispatch/generationHandlers.js';
import { buildGroupHandlers } from './dispatch/groupHandlers.js';
import { buildCharacterHandlers } from './dispatch/characterHandlers.js';
import { buildSettingsHandlers } from './dispatch/settingsHandlers.js';
import { buildWorldInfoHandlers } from './dispatch/worldInfoHandlers.js';
import { buildPersonaHandlers } from './dispatch/personaHandlers.js';
import { buildBackendConfigHandlers } from './dispatch/backendConfigHandlers.js';
import { buildPromptListHandlers } from './dispatch/promptListHandlers.js';
import { buildQuickReplyHandlers } from './dispatch/quickReplyHandlers.js';
import { buildCustomBackendHandlers } from './dispatch/customBackendHandlers.js';
import { buildToolHandlers } from './dispatch/toolHandlers.js';

export type { DispatcherDeps } from './dispatch/types.js';

export function createDispatcher(deps: DispatcherDeps) {
  const { bus } = deps;

  // Rate limiter for expensive WS actions (LLM calls) — prevents API-credit-burn spam.
  const generationLimiter = new SlidingWindowRateLimiter(20, 60_000);
  const GENERATION_ACTIONS = new Set([
    'action.generate',
    'action.sendAndGenerate',
    'action.regenerate',
    'action.continue',
    'action.impersonate',
    'action.gen',
    'action.genraw',
    'action.ask',
    'action.sysgen',
  ]);

  // One handler per ClientMessage type. `satisfies HandlerMap` makes this
  // exhaustive at compile time: adding a message type to the schema without a
  // handler here is a type error.
  const handlers = {
    ...buildAuthHandlers(deps),
    ...buildChatHandlers(deps),
    ...buildMessageHandlers(deps),
    ...buildGenerationHandlers(deps),
    ...buildGroupHandlers(deps),
    ...buildCharacterHandlers(deps),
    ...buildSettingsHandlers(deps),
    ...buildWorldInfoHandlers(deps),
    ...buildPersonaHandlers(deps),
    ...buildBackendConfigHandlers(deps),
    ...buildPromptListHandlers(deps),
    ...buildQuickReplyHandlers(deps),
    ...buildCustomBackendHandlers(deps),
    ...buildToolHandlers(deps),
  } satisfies HandlerMap;

  return async function dispatch(client: ClientConnection, msg: ClientMessage): Promise<void> {
    // Defense-in-depth: all clients reaching dispatch should already be authenticated
    // (token validated at WS connect in main.ts), but reject messages explicitly if
    // they somehow aren't — including `auth`, which must never self-authenticate.
    if (!client.authenticated) {
      bus.sendTo(client.id, { type: 'error', message: 'Not authenticated', code: 'UNAUTHORIZED' });
      return;
    }

    // Throttle expensive LLM-generation actions to prevent API-credit-burn spam.
    if (GENERATION_ACTIONS.has(msg.type)) {
      if (!generationLimiter.check(client.id)) {
        bus.sendTo(client.id, {
          type: 'error',
          message: 'Rate limit exceeded for generation. Please wait a moment.',
          code: 'RATE_LIMITED',
        });
        return;
      }
    }

    // Correlated-union dispatch: `handlers` provably has a handler for every
    // message type (see the `satisfies` above), but TS cannot correlate a
    // union-typed `msg` with `handlers[msg.type]` — narrow once at this
    // validation boundary instead of at every call site.
    const handler = handlers[msg.type] as MessageHandler<ClientMessage> | undefined;
    if (!handler) {
      throw new ValidationError(`Unknown message type: ${String(msg.type)}`);
    }
    await handler(client, msg);
  };
}
