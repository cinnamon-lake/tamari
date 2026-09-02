/**
 * Request-transformer helpers: drive the seeded "Default" transformer chain
 * (migration 020, fixed id `default`) over the app's WebSocket bus. Replaces
 * the removed global `whitespaceMode` / `reasoningAddToPrompts` settings —
 * transforms now live on a chain referenced by the backend config's
 * `transformerChainId`, applied to the final rendered message array at
 * request time (stored messages stay verbatim).
 *
 * On a fresh e2e DB the chain exists but no backend config links to it yet
 * (migration 020 runs before `ensureDefaultBackendConfig`), so
 * `setTransformerSteps` both updates the steps and links the active config;
 * `resetTransformerChain` restores the exact fresh-install state.
 */
import type { Page } from '@playwright/test';
import { wsRpc } from './ws.js';
import { patchActiveBackendConfig } from './backendConfig.js';

const DEFAULT_CHAIN_ID = 'default';

interface TransformerStep {
  kind: 'builtin';
  id: 'squash-system' | 'whitespace' | 'strip-reasoning' | 'history-squash' | 'ensure-thinking';
  enabled: boolean;
  params?: Record<string, unknown>;
}

/** Steps migration 020 seeds on a fresh install: whitespace 'none', no strip-reasoning. */
const FRESH_STEPS: TransformerStep[] = [{ kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'none' } }];

async function saveDefaultChain(page: Page, steps: TransformerStep[]): Promise<void> {
  await wsRpc(
    page,
    {
      type: 'transformerchain.save',
      id: DEFAULT_CHAIN_ID,
      data: {
        name: 'Default',
        description: 'Seeded by migration 020 from the former global whitespaceMode / reasoningAddToPrompts settings.',
        steps,
      },
    },
    'transformerchain.updated',
  );
}

/**
 * Replace the Default chain's steps and point the active backend config at
 * it. Resolves once the server has broadcast both mutations.
 */
export async function setTransformerSteps(page: Page, steps: TransformerStep[]): Promise<void> {
  await saveDefaultChain(page, steps);
  await patchActiveBackendConfig(page, { transformerChainId: DEFAULT_CHAIN_ID });
}

/**
 * Restore the fresh-install state: Default chain back to its seeded steps,
 * active backend config unlinked (transformerChainId null). Specs that call
 * `setTransformerSteps` must call this in an afterEach — the e2e server is
 * shared per run.
 */
export async function resetTransformerChain(page: Page): Promise<void> {
  await saveDefaultChain(page, FRESH_STEPS);
  await patchActiveBackendConfig(page, { transformerChainId: null });
}
