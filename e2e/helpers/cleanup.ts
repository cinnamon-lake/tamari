import type { Page } from '@playwright/test';

/**
 * Delete characters and World Info books whose names start with one of the
 * given prefixes, over the app's WS bus (neither resource has a REST delete).
 *
 * The smoke suite shares one server/DB across all specs, so a spec that
 * creates characters or books and leaves them behind pollutes every
 * later-running spec — e.g. any leftover book makes CharacterEditor render its
 * (unlabeled) `.lorebook-selector > select`, which trips the axe checks in
 * character.spec. Specs should call this from `test.afterAll` with the unique
 * `uniqueName()` prefixes they used.
 *
 * Follows the helpers/settings.ts pattern: throwaway socket, auth, snapshot +
 * worldinfo.list, fire deletes for matches, resolve when the delete broadcasts
 * confirm them. A safety timeout resolves anyway — cleanup must never hang
 * the run.
 */
export async function wsDeleteByPrefix(
  page: Page,
  { charPrefixes = [], bookPrefixes = [] }: { charPrefixes?: string[]; bookPrefixes?: string[] },
): Promise<void> {
  if (charPrefixes.length === 0 && bookPrefixes.length === 0) return;
  await page.evaluate(
    async ({ charPrefixes: cps, bookPrefixes: bps }) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      await new Promise<void>((resolve) => {
        const pendingChars = new Set<string>();
        const pendingBooks = new Set<string>();
        let snapshotSeen = false;
        let booksListed = false;
        const maybeDone = () => {
          if (snapshotSeen && booksListed && pendingChars.size === 0 && pendingBooks.size === 0) {
            ws.close();
            resolve();
          }
        };
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth' }));
          ws.send(JSON.stringify({ type: 'worldinfo.list' }));
        };
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            snapshotSeen = true;
            for (const c of msg.state?.characters ?? []) {
              if (cps.some((p: string) => String(c.name).startsWith(p))) {
                pendingChars.add(c.id);
                ws.send(JSON.stringify({ type: 'character.delete', characterId: c.id }));
              }
            }
            maybeDone();
          }
          if (msg.type === 'worldinfo.listed') {
            booksListed = true;
            for (const b of msg.books ?? []) {
              if (bps.some((p: string) => String(b.name).startsWith(p))) {
                pendingBooks.add(b.id);
                ws.send(JSON.stringify({ type: 'worldinfo.delete', bookId: b.id }));
              }
            }
            maybeDone();
          }
          if (msg.type === 'character.deleted') {
            pendingChars.delete(msg.characterId);
            maybeDone();
          }
          if (msg.type === 'worldinfo.deleted') {
            pendingBooks.delete(msg.bookId);
            maybeDone();
          }
        };
        setTimeout(() => {
          ws.close();
          resolve();
        }, 10000);
      });
    },
    { charPrefixes, bookPrefixes },
  );
}
