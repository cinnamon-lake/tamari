import { test, expect, type Page } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests } from '../helpers/llm.js';
import { setSetting } from '../helpers/settings.js';
import { App } from '../helpers/app.js';

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

function promptText(captured: { body: unknown }): string {
  const body = captured.body as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((m: Record<string, unknown>) => String(m.content ?? '')).join('\n');
}

/** Point the runtime-reconfigurable RAG service at the mock embedding API. */
async function configureRag(page: Page, enabled: boolean): Promise<void> {
  await setSetting(page, 'rag.enabled', enabled);
  if (enabled) {
    await setSetting(page, 'rag.api_url', MOCK_URL);
    await setSetting(page, 'rag.api_key', 'mock-api-key');
    await setSetting(page, 'rag.model', 'mock-embed');
    // Bag-of-words mock vectors score low even on overlap — disable the gate.
    await setSetting(page, 'rag.threshold', 0);
  }
}

/** Patch the first entry of a lorebook to semantic retrieval via the WS bus. */
async function setEntryRetrievalMode(page: Page, bookName: string, mode: 'semantic' | 'keyword'): Promise<void> {
  await page.evaluate(
    ({ bookName, mode }) => {
      return new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth' }));
          // Books are not in the connect snapshot — they arrive via worldinfo.list.
          ws.send(JSON.stringify({ type: 'worldinfo.list' }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'worldinfo.listed') {
              const books = (msg.books ?? []) as Array<{ id: string; name: string; entries: Array<{ id: string }> }>;
              const book = books.find((b) => b.name === bookName);
              const entryId = book?.entries[0]?.id;
              if (!book || !entryId) {
                ws.close();
                reject(new Error(`Book or entry not found: ${bookName}`));
                return;
              }
              ws.send(
                JSON.stringify({
                  type: 'worldinfo.entry.update',
                  bookId: book.id,
                  entryId,
                  patch: { retrievalMode: mode },
                }),
              );
            }
            if (msg.type === 'worldinfo.updated') {
              ws.close();
              resolve();
            }
            if (msg.type === 'error') {
              ws.close();
              reject(new Error(msg.message ?? 'entry update failed'));
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
          reject(new Error('setEntryRetrievalMode timed out'));
        }, 10000);
      });
    },
    { bookName, mode },
  );
}

/** Create a lorebook with a single entry (UI flow, same as prompt-injection). */
async function createBookWithEntry(app: App, bookName: string, keys: string, content: string): Promise<void> {
  const page = app.page;
  const btn = page.locator('button.settings-btn:has-text("World Info")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const editor = page.locator('.worldinfo-modal');
  await expect(editor).toBeVisible();

  await editor.locator('button:has-text("New Lorebook")').click();
  await editor.locator('.worldinfo-item').filter({ hasText: 'New Lorebook' }).first().click();
  await expect(editor.locator('.book-editor')).toBeVisible();
  await editor.locator('.book-name-input').fill(bookName);
  await editor.locator('.book-name-input').blur();

  await editor.locator('button:has-text("Add Entry")').click();
  await editor.locator('.entry-row').first().click();
  await expect(editor.locator('.entry-editor')).toBeVisible();
  await editor.locator('.entry-editor label:has-text("Keys") input').fill(keys);
  await editor.locator('.entry-editor label:has-text("Keys") input').blur();
  await editor.locator('.entry-editor label:has-text("Content") textarea').fill(content);
  await editor.locator('.entry-editor label:has-text("Content") textarea').blur();

  await page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
  await expect(editor).not.toBeVisible();
}

test.describe('Semantic World Info (RAG)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // RAG must end disabled — it is a persisted setting shared by the server.
    await configureRag(page, false);
    await resetBackendConfig(page);
  });

  test('runtime-enabled RAG activates a semantic entry without a keyword match', async ({ page }) => {
    const app = new App(page);
    await configureRag(page, true);

    const bookName = uniqueName('SemBook');
    // The key never appears in the conversation — keyword matching can never
    // fire this entry; only the vector path can.
    await createBookWithEntry(app, bookName, 'nonexistentkeyword', '[WI] SEMANTIC_TOKEN grimbles');
    await setEntryRetrievalMode(page, bookName, 'semantic');

    const charName = uniqueName('SemChar');
    await page.locator('[title="Create character"]').click();
    const charEditor = page.locator('.character-editor-modal');
    await charEditor.locator('.lorebook-selector select').selectOption({ label: `${bookName} (1 entries)` });
    await charEditor.locator('.text-input').first().fill(charName);
    await charEditor.locator('.textarea-input').nth(0).fill('Test character.');
    await charEditor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(charEditor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await charEditor.locator('[title="Close"]').click();

    await app.startChat(charName);
    await app.sendUserMessage('tell me about grimbles', { expectReply: true });

    // 'grimbles' shares a token with the entry content → vector match → injected.
    expect(promptText(await getLastLlmRequest())).toContain('SEMANTIC_TOKEN');

    // Disable RAG again — the runtime reconfigure must take effect live:
    // without the vector path the entry can never activate, so the mock no
    // longer echoes an inject: token (the turn-1 reply stays in history, so
    // assert on the NEW reply, not the raw prompt).
    await configureRag(page, false);
    await app.sendUserMessage('tell me about grimbles again', { expectReply: true });
    expect(await app.lastAssistantText()).toBe('Hello! This is a deterministic mock response from the e2e test server.');
  });
});
