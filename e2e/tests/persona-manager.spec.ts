import { deflateSync } from 'node:zlib';
import { test, expect, type Page, type Locator } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { deleteNonDefaultPersonas } from '../helpers/personas.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// ── solid-color PNG builder (same recipe as character-card-formats.spec.ts) ──

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function buildSolidPng(size = 32): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // scanline filter: none
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 4;
      raw[p] = 200;
      raw[p + 1] = 40;
      raw[p + 2] = 120;
      raw[p + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── persona manager plumbing ────────────────────────────────────────────────

async function openPersonaManager(page: Page): Promise<Locator> {
  await page.locator('button.settings-btn:has-text("Personas")').click();
  const manager = page.locator('.persona-modal');
  await expect(manager).toBeVisible();
  return manager;
}

async function closePersonaManager(page: Page, manager: Locator): Promise<void> {
  await page.locator('.modal-overlay:has(.persona-modal)').click({ position: { x: 0, y: 0 } });
  await expect(manager).not.toBeVisible();
}

/** Create a persona via the manager UI and return to the list view. */
async function createPersona(manager: Locator, name: string): Promise<void> {
  await manager.locator('button:has-text("New Persona")').click();
  await expect(manager.locator('.persona-editor')).toBeVisible();
  await manager.locator('.persona-editor .text-input').first().fill(name);
  await expect(manager.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
  await manager.locator('button.back-btn:has-text("Back")').click();
  await expect(manager.locator('.persona-list')).toContainText(name);
}

/** Delete a persona over the WS bus (cleanup path; failure fails the test). */
async function deletePersonaViaWs(page: Page, personaId: string): Promise<void> {
  await page.evaluate((id) => {
    return new Promise<void>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth' }));
        ws.send(JSON.stringify({ type: 'persona.delete', personaId: id }));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'persona.deleted') {
          ws.close();
          resolve();
        }
        if (msg.type === 'error') {
          ws.close();
          reject(new Error(msg.message ?? 'persona.delete failed'));
        }
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
      setTimeout(() => {
        ws.close();
        reject(new Error('deletePersonaViaWs timed out'));
      }, 10000);
    });
  }, personaId);
}

test.describe('Persona Manager', () => {
  const createdPersonaIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    // chat.create binds the FIRST (newest) persona in the DB to a new chat
    // when none is given (chatHandlers.ts), and {{user}} then resolves to that
    // persona's name. Personas leaked by earlier specs (full-flow, personas, …)
    // would break the 'Hello User!' baseline — keep only the seeded default.
    await deleteNonDefaultPersonas(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    for (const id of createdPersonaIds.splice(0)) {
      await deletePersonaViaWs(page, id);
    }
  });

  test('uploads a persona avatar through the crop modal', async ({ page }) => {
    const personaName = uniqueName('Avatar Persona');
    const manager = await openPersonaManager(page);

    await manager.locator('button:has-text("New Persona")').click();
    const editor = manager.locator('.persona-editor');
    await expect(editor).toBeVisible();
    await editor.locator('.text-input').first().fill(personaName);
    await expect(manager.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });

    // Upload -> CropModal -> Apply posts the cropped blob to the avatar route.
    const uploadResponse = page.waitForResponse(
      (resp) => resp.request().method() === 'POST' && /\/api\/personas\/[^/]+\/avatar/.test(resp.url()),
      { timeout: 10000 },
    );
    await editor.locator('.hidden-file-input').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: buildSolidPng(),
    });
    const cropModal = page.locator('.crop-modal');
    await expect(cropModal).toBeVisible();
    // Wait for cropperjs to finish initializing before applying.
    await expect(cropModal.locator('.cropper-crop-box')).toBeVisible();
    await cropModal.locator('button.primary:has-text("Apply")').click();
    await expect(cropModal).not.toBeVisible();
    await uploadResponse;

    // The editor preview swaps the placeholder for the uploaded avatar img.
    await expect(editor.locator('img.persona-avatar-preview')).toBeVisible({ timeout: 10000 });

    // Back in the list, the persona row shows the avatar instead of the icon.
    await manager.locator('button.back-btn:has-text("Back")').click();
    const row = manager.locator('.persona-item', { hasText: personaName });
    await expect(row).toBeVisible();
    await expect(row.locator('img.persona-avatar')).toBeVisible({ timeout: 10000 });

    const personaId = await row.getAttribute('id');
    expect(personaId).toBeTruthy();
    createdPersonaIds.push(personaId!);

    await closePersonaManager(page, manager);
  });

  test('deletes a persona after confirmation', async ({ page }) => {
    const personaName = uniqueName('Delete Persona');
    const manager = await openPersonaManager(page);
    await createPersona(manager, personaName);

    // Open the editor via the row's pencil button.
    const row = manager.locator('.persona-item', { hasText: personaName });
    await row.locator('button[title="Edit"]').click();
    await expect(manager.locator('.persona-editor')).toBeVisible();

    await manager.locator('.persona-editor button.text-btn.danger:has-text("Delete")').click();
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await popup.locator('button.primary').click();
    await expect(popup).not.toBeVisible();

    // Back at the list, the persona is gone (persona.deleted + persona.listed).
    await expect(manager.locator('.persona-item', { hasText: personaName })).toHaveCount(0, { timeout: 5000 });

    await closePersonaManager(page, manager);
  });

  test('assigning a persona to the active chat re-resolves the greeting and names user messages', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Persona Host');
    const nameA = uniqueName('PA');
    const nameB = uniqueName('PB');

    // {{user}} in the greeting resolves against userName ('User') until a
    // persona is bound to the chat.
    await app.createCharacterAndChat({ name: charName, firstMes: 'Hello {{user}}!' });
    const greeting = page.locator('.message-bubble.assistant').first().locator('.message-content');
    await expect(greeting).toContainText('Hello User!');

    const manager = await openPersonaManager(page);
    await createPersona(manager, nameA);

    // Click the row itself: assigns the persona to the active chat
    // (chat.update personaId) and rebroadcasts the unmaterialized greeting.
    const row = manager.locator('.persona-item', { hasText: nameA });
    const personaId = await row.getAttribute('id');
    expect(personaId).toBeTruthy();
    createdPersonaIds.push(personaId!);
    // The editor's unmount flush triggers a persona.listed rebroadcast that
    // re-renders the list rows — a click that lands mid-re-render dies on the
    // detached node. Retry until the assignment sticks (row gets .active).
    // Clicking .persona-info keeps the point away from the row's edit pencil.
    await expect(async () => {
      await manager.locator('.persona-item', { hasText: nameA }).locator('.persona-info').click();
      await expect(manager.locator('.persona-item.active', { hasText: nameA })).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 10000 });
    await expect(greeting).toContainText(`Hello ${nameA}!`, { timeout: 10000 });

    // Renaming the persona rebroadcasts the greeting snapshot again
    // (persona.update -> maybeRebroadcastGreetingSnapshot).
    await row.locator('button[title="Edit"]').click();
    const nameInput = manager.locator('.persona-editor .text-input').first();
    await nameInput.fill(nameB);
    await expect(manager.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await expect(greeting).toContainText(`Hello ${nameB}!`, { timeout: 10000 });

    await closePersonaManager(page, manager);

    // New user messages carry the persona name in the bubble header
    // (server enriches extra.personaName from the chat's personaId).
    await app.sendUserMessage('respond: persona works', { expectReply: true });
    await expect(app.lastBubble('user').locator('.message-role')).toHaveText(nameB);
  });
});
