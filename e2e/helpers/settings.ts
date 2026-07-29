import type { Page } from '@playwright/test';

/**
 * Set a single app setting over the app's WebSocket bus. Bypasses the Settings
 * modal so tests can set structured values (regexRules, memory config, custom
 * stopping strings) deterministically — no UI plumbing, no debounce races.
 *
 * Resolves when the server broadcasts `settings.changed` for the same key,
 * i.e. the value has been persisted and re-broadcast.
 */
export async function setSetting(page: Page, key: string, value: unknown): Promise<void> {
  await page.evaluate(
    ({ key, value }) => {
      return new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth' }));
          ws.send(JSON.stringify({ type: 'settings.set', key, value }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'settings.changed' && msg.key === key) {
              ws.close();
              resolve();
            }
            if (msg.type === 'error') {
              ws.close();
              reject(new Error(msg.message ?? `settings.set failed for ${key}`));
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
          reject(new Error(`setSetting(${key}) timed out`));
        }, 10000);
      });
    },
    { key, value },
  );
}

/**
 * Read the active backend config id from the app's own store. Useful when a
 * setting (e.g. `memory.backendConfigId`) must point at the config that is
 * already wired to the mock LLM.
 */
export async function getActiveBackendConfigId(page: Page): Promise<string> {
  return page.evaluate(() => {
    return new Promise<string>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth' }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            const activeId = msg.state?.settings?.activeBackendConfigId;
            ws.close();
            if (activeId) resolve(String(activeId));
            else reject(new Error('No active backend config in snapshot'));
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
        reject(new Error('getActiveBackendConfigId timed out'));
      }, 10000);
    });
  });
}
