/**
 * Persona cleanup helpers for the shared-e2e-server suite.
 *
 * Personas are global (server DB), and `chat.create` binds the FIRST persona
 * in the list (newest first) to a new chat when the caller doesn't pass one
 * (server/src/dispatch/chatHandlers.ts) — so a persona leaked by an
 * earlier-running spec silently becomes the persona of every chat created
 * afterwards, and `{{user}}` in greetings resolves to the leaked persona's
 * name instead of 'User'. Specs that create personas must delete them again;
 * specs that rely on the default persona can call deleteNonDefaultPersonas in
 * beforeEach to defend against polluters.
 *
 * The seeded default persona (id 'default', name 'User' — see
 * ensureDefaultPersona in server/src/main.ts) is never touched; the server
 * also refuses to delete the last remaining persona.
 */
import type { Page } from '@playwright/test';

/** Delete every persona EXCEPT the seeded 'default' one. Resolves once done. */
export async function deleteNonDefaultPersonas(page: Page): Promise<void> {
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      let listed = false;
      const pending = new Set<string>();

      const finish = () => {
        ws.close();
        resolve();
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth' }));
        ws.send(JSON.stringify({ type: 'persona.list' }));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'persona.listed' && !listed) {
          listed = true;
          const ids = ((msg.personas ?? []) as Array<{ id: string }>)
            .map((p) => p.id)
            .filter((id) => id !== 'default');
          if (ids.length === 0) {
            finish();
            return;
          }
          for (const id of ids) {
            pending.add(id);
            ws.send(JSON.stringify({ type: 'persona.delete', personaId: id }));
          }
        }
        if (msg.type === 'persona.deleted') {
          pending.delete(msg.personaId as string);
          if (listed && pending.size === 0) finish();
        }
        if (msg.type === 'error') {
          ws.close();
          reject(new Error(msg.message ?? 'persona cleanup failed'));
        }
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
      setTimeout(() => {
        ws.close();
        reject(new Error(`deleteNonDefaultPersonas timed out (pending=${pending.size})`));
      }, 15000);
    });
  });
}
