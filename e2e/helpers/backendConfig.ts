import { Page } from '@playwright/test';
import { wsRpc } from './ws.js';

/**
 * Resolve the active backend config id via settings.get over the app's
 * WebSocket bus. Returns '' when no active config is set.
 */
async function getActiveBackendConfigId(page: Page): Promise<string> {
  const loaded = await wsRpc<{ settings?: { activeBackendConfigId?: string } }>(
    page,
    { type: 'settings.get' },
    'settings.loaded',
  );
  return String(loaded?.settings?.activeBackendConfigId ?? '');
}

/**
 * Send a partial `backendConfig.update` patch for the active config over the
 * app's WebSocket bus. Bypasses the Backend Config modal — avoiding debounce /
 * snapshot race conditions in the UI — so journeys can set connection fields or
 * sampler knobs (temperature, providerParams.seed, …) deterministically.
 *
 * `providerParams` in the patch REPLACES the whole blob (server semantics), so
 * callers that only want to tweak one advanced knob must include the others
 * they care about.
 */
export async function patchActiveBackendConfig(page: Page, patch: Record<string, unknown>): Promise<void> {
  const activeId = await getActiveBackendConfigId(page);
  if (!activeId) {
    throw new Error('No active backend config in snapshot');
  }
  await wsRpc(page, { type: 'backendConfig.update', backendConfigId: activeId, patch }, [
    'backendConfig.updated',
    'backendConfig.snapshot',
  ]);
}

/**
 * Configure the active tamari backend to use the deterministic mock
 * OpenAI-compatible LLM server started by Playwright global setup.
 *
 * This bypasses the Backend Config modal and sends the update directly over the
 * app's WebSocket bus, avoiding debounce / snapshot race conditions in the UI.
 */
export async function configureMockBackend(page: Page): Promise<void> {
  const mockUrl = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';
  await patchActiveBackendConfig(page, {
    backendProvider: 'openai',
    generationMode: 'chat',
    model: 'mock-model',
    apiUrl: mockUrl,
    apiKey: 'mock-api-key',
    // Explicit response cap — maxTokens is optional and no longer has any
    // global default, and several backend specs assert the wire cap is sent.
    maxTokens: 512,
  });
}

/**
 * Reset the active backend config to the default empty OpenAI settings so that
 * other tests do not trigger unexpected generation against the mock server.
 */
export async function resetBackendConfig(page: Page): Promise<void> {
  const activeId = await getActiveBackendConfigId(page);
  if (!activeId) return;
  await wsRpc(
    page,
    {
      type: 'backendConfig.update',
      backendConfigId: activeId,
      patch: {
        backendProvider: 'openai',
        generationMode: 'chat',
        model: 'gpt-4-turbo',
        apiUrl: null,
        apiKey: null,
        maxTokens: null,
      },
    },
    ['backendConfig.updated', 'backendConfig.snapshot'],
  );
}
