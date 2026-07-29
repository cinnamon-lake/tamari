import { Page } from '@playwright/test';

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
export async function patchActiveBackendConfig(
  page: Page,
  patch: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    (patch) => {
      return new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        let snapshotReceived = false;

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth' }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);

            if (msg.type === 'snapshot') {
              snapshotReceived = true;
              const activeId = msg.state?.settings?.activeBackendConfigId;
              if (!activeId) {
                reject(new Error('No active backend config in snapshot'));
                return;
              }
              ws.send(
                JSON.stringify({
                  type: 'backendConfig.update',
                  backendConfigId: activeId,
                  patch,
                }),
              );
            }

            if (msg.type === 'backendConfig.updated' || msg.type === 'backendConfig.snapshot') {
              ws.close();
              resolve();
            }

            if (msg.type === 'error') {
              ws.close();
              reject(new Error(msg.message ?? 'Backend config update failed'));
            }
          } catch (err) {
            reject(err);
          }
        };

        ws.onerror = (err) => {
          reject(new Error(`WebSocket error: ${err.type}`));
        };

        setTimeout(() => {
          ws.close();
          reject(new Error(`patchActiveBackendConfig timed out (snapshotReceived=${snapshotReceived})`));
        }, 10000);
      });
    },
    patch,
  );
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
  });
}

/**
 * Reset the active backend config to the default empty OpenAI settings so that
 * other tests do not trigger unexpected generation against the mock server.
 */
export async function resetBackendConfig(page: Page): Promise<void> {
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      let snapshotReceived = false;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth' }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === 'snapshot') {
            snapshotReceived = true;
            const activeId = msg.state?.settings?.activeBackendConfigId;
            if (!activeId) {
              ws.close();
              resolve();
              return;
            }
            ws.send(
              JSON.stringify({
                type: 'backendConfig.update',
                backendConfigId: activeId,
                patch: {
                  backendProvider: 'openai',
                  generationMode: 'chat',
                  model: 'gpt-4-turbo',
                  apiUrl: null,
                  apiKey: null,
                },
              }),
            );
          }

          if (msg.type === 'backendConfig.updated' || msg.type === 'backendConfig.snapshot') {
            ws.close();
            resolve();
          }

          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'Backend config reset failed'));
          }
        } catch (err) {
          reject(err);
        }
      };

      ws.onerror = (err) => {
        reject(new Error(`WebSocket error: ${err.type}`));
      };

      setTimeout(() => {
        ws.close();
        reject(new Error(`resetBackendConfig timed out (snapshotReceived=${snapshotReceived})`));
      }, 10000);
    });
  });
}
