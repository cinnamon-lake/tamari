import { Page } from '@playwright/test';

export interface ToolTemplateSummary {
  id: string;
  name: string;
}

export interface ToolsetSummary {
  id: string;
  templateId: string;
  name: string;
  enabled: boolean;
}

/**
 * Create and enable a toolset from a built-in tool template.
 * The argument may be either the template name (e.g. "lua_encouragement") or its id.
 * `config` is the per-toolset config blob (e.g. TTS provider/url/key for `speak`).
 * Returns the created toolset id so callers can clean it up after the test.
 */
export async function enableBuiltinToolset(
  page: Page,
  templateIdOrName: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  return await page.evaluate(
    ({ templateIdOrNameArg, configArg }) => {
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
              // Built-in templates arrive under `tools`; Lua templates under
              // `toolTemplates` (and again in `tools`). Search both.
              const tools = (msg.state?.tools ?? []) as ToolTemplateSummary[];
              const luaTemplates = (msg.state?.toolTemplates ?? []) as ToolTemplateSummary[];
              const templates = [...tools, ...luaTemplates];
              const template =
                templates.find((t) => t.id === templateIdOrNameArg) ||
                templates.find((t) => t.name === templateIdOrNameArg);

              if (!template) {
                ws.close();
                reject(new Error(`Tool template "${templateIdOrNameArg}" not found in snapshot`));
                return;
              }

              ws.send(
                JSON.stringify({
                  type: 'toolset.create',
                  data: {
                    templateId: template.id,
                    name: `${template.name} (e2e)`,
                    config: configArg,
                    toolOverrides: {},
                    enabled: true,
                  },
                }),
              );
            }

            if (msg.type === 'toolset.created') {
              const toolsetId = (msg.toolset as ToolsetSummary | undefined)?.id;
              ws.close();
              if (!toolsetId) {
                reject(new Error('toolset.created message missing toolset id'));
                return;
              }
              resolve(toolsetId);
            }

            if (msg.type === 'error') {
              ws.close();
              reject(new Error(msg.message ?? 'Toolset creation failed'));
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
          reject(new Error('enableBuiltinToolset timed out'));
        }, 10000);
      });
    },
    { templateIdOrNameArg: templateIdOrName, configArg: config },
  );
}

/**
 * Delete a toolset by id.
 */
export async function deleteToolset(page: Page, toolsetId: string): Promise<void> {
  await page.evaluate((id) => {
    return new Promise<void>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth' }));
        ws.send(JSON.stringify({ type: 'toolset.delete', toolsetId: id }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === 'toolset.deleted') {
            ws.close();
            resolve();
          }

          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'Toolset deletion failed'));
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
        reject(new Error('deleteToolset timed out'));
      }, 10000);
    });
  }, toolsetId);
}
