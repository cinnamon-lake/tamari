/**
 * Character editor advanced-UI coverage: card formats & attached modules.
 *
 * Serial spec covering:
 *   1. Avatar upload through CropModal (confirm → avatar updates with ?t=
 *      bust, confirm again → bust changes, then the cancel path).
 *   2. Greetings tab (GreetingsEditor): add → edit → persist across editor
 *      close/reopen → remove → persist.
 *   3. Logic tab contextual-backend fields (CharacterBackendEditor): enable
 *      toggle + Lua source persist. Generation through it is covered by
 *      lua-custom-backend.spec — UI only here.
 *   4. RisuAI .risum module flow through RisuModuleViewer: build a minimal
 *      valid container in-test (mirroring server/src/lib/risum.ts), attach via
 *      the file input, verify module meta + counts, select it, switch
 *      sections (info/triggers/regex/lorebook/assets), view trigger detail,
 *      then delete via REST (the viewer has no delete UI — the DELETE endpoint
 *      is the only surface) and confirm it is gone.
 *   5. Risu module endpoint error paths (REST, exact status + messages from
 *      server/src/api/characters.ts): unknown character → 404, unknown section
 *      → 400, trigger without index → 400, non-risum upload → 400.
 *
 * The .risum container layout (see server/src/lib/risum.ts):
 *   byte 0: magic 111 (0x6f); byte 1: version 0;
 *   bytes 2..5: uint32 LE main-block length;
 *   main block: RPack-encoded UTF-8 JSON `{ type: 'risuModule', module }`;
 *   then per asset: byte 0x01, uint32 LE length, RPack-encoded payload;
 *   final byte 0x00 (EOF). RPack is a fixed 256-byte substitution map.
 */
import { test, expect, type Page } from '../fixtures/base.js';
import { deflateSync } from 'node:zlib';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';

/** The e2e webServer pins TAMARI_SECRET to this value (playwright.config.ts). */
const AUTH = { Authorization: 'Bearer e2e-test-secret' };

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Reopen the character editor from the sidebar row (createCharacter closes it). */
async function openEditor(page: Page, app: App, name: string) {
  await app.revealHoverButtons();
  await page.locator('input[placeholder="Search characters..."]').fill(name);
  const row = app.characterRow(name);
  await row.waitFor({ state: 'visible' });
  await row.locator('[title="Edit character"]').click({ force: true });
  const editor = page.locator('.character-editor-modal');
  await expect(editor).toBeVisible();
  return editor;
}

async function closeEditor(editor: ReturnType<Page['locator']>) {
  await editor.locator('[title="Close"]').click();
  await expect(editor).not.toBeVisible();
}

// ── Minimal solid-color PNG (32x32 RGBA) — big enough for cropperjs ─────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
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

// ── Minimal .risum builder (mirrors server/src/lib/risum.ts) ────────────────

// 512 bytes: bytes 0..255 = encode map, bytes 256..511 = decode map.
// Copied verbatim from server/src/lib/risum.ts (RisuAI rpack_map.bin, MIT).
const RPACK_MAP_B64 =
  'xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmop' +
  'kvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwK' +
  'x4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uCz3hIvJZfu2n66zAy0B' +
  'aXQf5KPs7lw0IZNKD2riYgKeIpz9PPxxx8atWWcFcG2KRBL6JIZfr9F6R87+UGPdUQZvGOBSqAmdVnNMuFNsw6AOGc8+DX4HMmhG6kj5mS6rpEkgXlU1OAy8' +
  '07FYFnkoChrh8s3EOduiumBydn2V73/IwN43lL+1FIGSJUWs5/Vmpys2WsET40s66I2DG3wnsJpC64eq3FSOeCbSVynUt/gvj4l18EF3wh7/2BUR5QSXF/Mx' +
  '0JsA18q0Tyo72bJr2l2hPzBhvZE9Tubfvk2CjB0jEJhk9IUze5BDu6mI8dalHPbMbrlbC5bt1enFywimgEA=';

const RPACK_ENCODE_MAP = Buffer.from(RPACK_MAP_B64, 'base64').subarray(0, 256);

function encodeRPack(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = RPACK_ENCODE_MAP[data[i]!]!;
  return out;
}

interface TestRisuModule {
  name: string;
  namespace?: string;
  description?: string;
  trigger?: unknown[];
  regex?: unknown[];
  lorebook?: unknown[];
  assets?: [string, string, string][];
}

/** Build a .risum container: header + RPack(JSON) + RPack(asset payloads) + EOF. */
function buildRisum(module: TestRisuModule, assetPayloads: Buffer[] = []): Buffer {
  const mainEncoded = encodeRPack(Buffer.from(JSON.stringify({ module, type: 'risuModule' }), 'utf-8'));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(6);
  header[0] = 111; // magic
  header[1] = 0; // version
  header.writeUInt32LE(mainEncoded.length, 2);
  parts.push(header, mainEncoded);
  for (const payload of assetPayloads) {
    const encoded = encodeRPack(payload);
    const blockHeader = Buffer.alloc(5);
    blockHeader[0] = 1; // asset mark
    blockHeader.writeUInt32LE(encoded.length, 1);
    parts.push(blockHeader, encoded);
  }
  parts.push(Buffer.from([0])); // EOF mark
  return Buffer.concat(parts);
}

/** One trigger (with a Lua effect) + one regex + one lorebook entry + one asset. */
function testModule(name: string): { module: TestRisuModule; payloads: Buffer[] } {
  return {
    module: {
      name,
      namespace: 'e2e-ns',
      description: 'Module built in-test.',
      trigger: [
        {
          comment: 'Start trigger',
          type: 'start',
          conditions: [],
          effect: [{ type: 'triggerlua', code: 'return nil', indent: 0 }],
        },
      ],
      regex: [{ comment: 'swap', in: 'foo', out: 'bar', type: 'editdisplay' }],
      lorebook: [{ key: 'dragon', content: 'A dragon appears.', comment: 'lore', insertorder: 100 }],
      assets: [['bg-music', '', 'mp3']],
    },
    payloads: [Buffer.from('ID3-e2e-fake-audio-payload')],
  };
}

test.describe('Character card formats (avatar crop, greetings, backend, risu modules)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('avatar upload via CropModal: confirm updates the avatar, cancel aborts', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('Avatar Crop');
    await app.createCharacter({ name });

    const editor = await openEditor(page, app, name);
    const avatarInput = editor.locator('.avatar-upload input[type="file"]');
    const cropModal = page.locator('.crop-modal');

    // ── Confirm path: upload → crop → apply → avatar is stored and served. ──
    await avatarInput.setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: buildSolidPng(),
    });
    await expect(cropModal).toBeVisible();
    await expect(cropModal.locator('.crop-modal-title')).toHaveText('Crop Avatar');
    // Wait for cropperjs to finish initializing before applying.
    await expect(cropModal.locator('.cropper-crop-box')).toBeVisible();
    await cropModal.locator('button.primary:has-text("Apply")').click();
    await expect(cropModal).not.toBeVisible();
    // A failed upload would surface the "avatar upload failed" alert popup.
    await expect(page.locator('.popup-modal')).toHaveCount(0);

    // The sidebar row's avatar img picks up the new URL via the WS broadcast.
    // (The editor itself snapshots props.character once — `const char =
    // props.character` in CharacterEditor.tsx — so its own img only renders a
    // first-time avatar after a remount; the sidebar is the live signal here.)
    const sidebarAvatar = page.locator(
      `.character-list li:has-text("${name}") img.character-avatar[src*="/files/avatars/"]`,
    );
    await expect(sidebarAvatar).toBeVisible({ timeout: 10000 });

    // Reopen the editor: now img.editor-avatar renders with the ?t= cache-bust.
    await closeEditor(editor);
    const reopened = await openEditor(page, app, name);
    const reopenedInput = reopened.locator('.avatar-upload input[type="file"]');
    const editorAvatar = reopened.locator('img.editor-avatar');
    await expect(editorAvatar).toBeVisible({ timeout: 10000 });
    await expect(editorAvatar).toHaveAttribute('src', /\/files\/avatars\/.+\?t=\d+/);
    const firstSrc = await editorAvatar.getAttribute('src');

    // ── Second confirm: the ?t= cache-bust changes the editor img src. ──
    await reopenedInput.setInputFiles({
      name: 'avatar2.png',
      mimeType: 'image/png',
      buffer: buildSolidPng(),
    });
    await expect(cropModal.locator('.cropper-crop-box')).toBeVisible();
    await cropModal.locator('button.primary:has-text("Apply")').click();
    await expect(cropModal).not.toBeVisible();
    await expect(page.locator('.popup-modal')).toHaveCount(0);
    await expect
      .poll(async () => editorAvatar.getAttribute('src'), { timeout: 10000 })
      .not.toBe(firstSrc);
    const secondSrc = await editorAvatar.getAttribute('src');
    expect(secondSrc).toContain('/files/avatars/');

    // ── Cancel path: modal closes, avatar untouched. ──
    await reopenedInput.setInputFiles({
      name: 'avatar3.png',
      mimeType: 'image/png',
      buffer: buildSolidPng(),
    });
    await expect(cropModal).toBeVisible();
    await cropModal.locator('.crop-modal-cancel-btn').click();
    await expect(cropModal).not.toBeVisible();
    expect(await editorAvatar.getAttribute('src')).toBe(secondSrc);

    await closeEditor(reopened);
  });

  test('greetings tab: add, edit, persist, remove an alternate greeting', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('Greetings Host');
    await app.createCharacter({ name, firstMes: 'Primary greeting.' });

    const editor = await openEditor(page, app, name);
    await editor.locator('#editor-tab-greetings').click();

    // The first GreetingsEditor on the tab is alternateGreetings.
    const alternate = editor.locator('.greetings-editor').first();
    await alternate.locator('button:has-text("Add greeting")').click();
    const greetingText = alternate.locator('.greeting-row textarea.greeting-textarea');
    await expect(greetingText).toHaveCount(1);

    const initial = `Alt greeting draft ${Date.now()}`;
    await greetingText.fill(initial);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 5000 });

    const edited = `Alt greeting edited ${Date.now()}`;
    await greetingText.fill(edited);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 5000 });
    await closeEditor(editor);

    // Persisted across editor close/reopen.
    const reopened = await openEditor(page, app, name);
    await reopened.locator('#editor-tab-greetings').click();
    const persistedText = reopened.locator('.greetings-editor').first().locator('.greeting-row textarea');
    await expect(persistedText).toHaveCount(1);
    await expect(persistedText).toHaveValue(edited);

    // Remove it; the close flushes the pending auto-save (onCleanup in the editor).
    await reopened.locator('.greetings-editor').first().locator('button[title="Remove"]').click();
    await expect(reopened.locator('.greetings-editor').first().locator('.greeting-row')).toHaveCount(0);
    await closeEditor(reopened);

    const again = await openEditor(page, app, name);
    await again.locator('#editor-tab-greetings').click();
    await expect(again.locator('.greetings-editor').first().locator('.greeting-row')).toHaveCount(0);
    await closeEditor(again);
  });

  test('logic tab: contextual-backend enable toggle and Lua source persist', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('Backend Logic');
    await app.createCharacter({ name });

    const editor = await openEditor(page, app, name);
    await editor.locator('#editor-tab-logic').click();

    const backend = editor.locator('.character-backend-editor');
    await expect(backend).toBeVisible();
    const luaSource = 'function generate(prompt, ctx)\n  return "pong"\nend';

    await backend.locator('input[type="checkbox"]').check();
    // The dry-run panel adds a second textarea — the Lua source field is the
    // only one with rows=12 (its placeholder documents generate(prompt, ctx)).
    await backend.locator('textarea[rows="12"]').fill(luaSource);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 5000 });
    await closeEditor(editor);

    const reopened = await openEditor(page, app, name);
    await reopened.locator('#editor-tab-logic').click();
    const backendAgain = reopened.locator('.character-backend-editor');
    await expect(backendAgain.locator('input[type="checkbox"]')).toBeChecked();
    await expect(backendAgain.locator('textarea[rows="12"]')).toHaveValue(luaSource);
    await closeEditor(reopened);
  });

  test('risu module: attach .risum, browse sections, view trigger, delete', async ({ page, request }) => {
    const app = new App(page);
    const name = uniqueName('Risu Host');
    await app.createCharacter({ name });
    const charId = await page.locator('.character-list li', { hasText: name }).getAttribute('id');
    expect(charId).toBeTruthy();

    const moduleName = `E2E Module ${Date.now()}`;
    const { module, payloads } = testModule(moduleName);
    const risumBuffer = buildRisum(module, payloads);

    const editor = await openEditor(page, app, name);
    await editor.locator('#editor-tab-logic').click();
    const viewer = editor.locator('.risu-module-viewer');
    await expect(viewer).toBeVisible();

    // Attach via the hidden .risum file input (direct-to-card attach).
    await viewer.locator('input[type="file"][accept=".risum"]').setInputFiles({
      name: 'e2e-module.risum',
      mimeType: 'application/octet-stream',
      buffer: risumBuffer,
    });
    // Attach note: 'Attached "<name>" (1 assets imported).'
    await expect(viewer).toContainText(`Attached "${moduleName}" (1 assets imported).`, { timeout: 10000 });
    // Expanded list shows the module toggle and per-module metadata.
    await expect(viewer.locator('button', { hasText: 'RisuAI modules (imported) (1)' })).toBeVisible();
    const moduleButton = viewer.locator('button', { hasText: moduleName });
    await expect(moduleButton).toBeVisible();
    await expect(viewer).toContainText('1 triggers · 1 regex · 1 lorebook · 1 assets');
    await expect(viewer).toContainText('Lua');

    // Select the module → info section loads by default.
    await moduleButton.click();
    const detail = viewer.locator('.risu-module-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('pre')).toContainText('"namespace": "e2e-ns"', { timeout: 10000 });

    // Triggers section: summary row + detail view.
    await detail.locator('button', { hasText: 'Triggers' }).click();
    await expect(detail).toContainText('#0 start', { timeout: 10000 });
    await expect(detail).toContainText('Start trigger');
    await expect(detail).toContainText('1 effects · 0 conditions');
    await detail.locator('button', { hasText: 'View' }).click();
    await expect(detail).toContainText('Trigger #0', { timeout: 10000 });
    await expect(detail).toContainText('triggerlua');

    // Regex / Lorebook / Assets sections render the raw JSON.
    await detail.locator('button:has-text("Regex")').click();
    await expect(detail).toContainText('swap', { timeout: 10000 });
    await detail.locator('button:has-text("Lorebook")').click();
    await expect(detail).toContainText('dragon', { timeout: 10000 });
    await detail.locator('button:has-text("Assets")').click();
    await expect(detail).toContainText('bg-music', { timeout: 10000 });

    // Delete: the viewer has no delete UI (read-only porting reference) — the
    // REST DELETE endpoint is the only surface. Confirm via its response.
    const listRes = await request.get(`/api/characters/${charId}/risu-modules`, { headers: AUTH });
    expect(listRes.ok()).toBe(true);
    const listBody = (await listRes.json()) as { total: number; modules: Array<{ id: string }> };
    expect(listBody.total).toBe(1);
    const delRes = await request.delete(`/api/characters/${charId}/risu-module/${listBody.modules[0]!.id}`, {
      headers: AUTH,
    });
    expect(delRes.ok()).toBe(true);
    expect(((await delRes.json()) as { success: boolean }).success).toBe(true);

    // Gone server-side…
    const afterRes = await request.get(`/api/characters/${charId}/risu-modules`, { headers: AUTH });
    expect(((await afterRes.json()) as { total: number }).total).toBe(0);

    // …and gone from the viewer after remount (it re-fetches on mount; wait for
    // that fetch before asserting the toggle is absent).
    await closeEditor(editor);
    const reopened = await openEditor(page, app, name);
    const listFetch = reopened.page().waitForResponse(
      (r) => r.url().includes(`/api/characters/${charId}/risu-modules`) && r.request().method() === 'GET',
      { timeout: 10000 },
    );
    await reopened.locator('#editor-tab-logic').click();
    await listFetch;
    await expect(
      reopened.locator('.risu-module-viewer button', { hasText: 'RisuAI modules' }),
    ).toHaveCount(0);
    await closeEditor(reopened);
  });

  test('risu module endpoints: exact 404/400 error paths', async ({ page, request }) => {
    const app = new App(page);
    const name = uniqueName('Risu REST');
    await app.createCharacter({ name });
    const charId = await page.locator('.character-list li', { hasText: name }).getAttribute('id');
    expect(charId).toBeTruthy();

    // Unknown character → 404 'Character not found'.
    const unknownChar = await request.get('/api/characters/no-such-character/risu-modules', { headers: AUTH });
    expect(unknownChar.status()).toBe(404);
    expect(((await unknownChar.json()) as { error: string }).error).toBe('Character not found');

    // Attach a valid module over REST to exercise the section validation.
    const { module, payloads } = testModule(`REST Module ${Date.now()}`);
    const attach = await request.post(`/api/characters/${charId}/risu-module`, {
      headers: AUTH,
      multipart: {
        file: { name: 'module.risum', mimeType: 'application/octet-stream', buffer: buildRisum(module, payloads) },
      },
    });
    expect(attach.ok()).toBe(true);
    const attachBody = (await attach.json()) as { success: boolean; module: { id: string }; assetsStored: number };
    expect(attachBody.success).toBe(true);
    expect(attachBody.assetsStored).toBe(1);
    const moduleId = attachBody.module.id;

    // Unknown section param → 400 with the exact message.
    const badSection = await request.get(
      `/api/characters/${charId}/risu-modules/${moduleId}?section=bogus`,
      { headers: AUTH },
    );
    expect(badSection.status()).toBe(400);
    expect(((await badSection.json()) as { error: string }).error).toBe(
      'Unknown section "bogus" (expected one of info, triggers, trigger, regex, lorebook, assets)',
    );

    // section=trigger without an index → 400.
    const noIndex = await request.get(`/api/characters/${charId}/risu-modules/${moduleId}?section=trigger`, {
      headers: AUTH,
    });
    expect(noIndex.status()).toBe(400);
    expect(((await noIndex.json()) as { error: string }).error).toBe(
      'section=trigger requires an index (see section=triggers)',
    );

    // Unknown module id → 404 'Module not found'.
    const unknownModule = await request.get(`/api/characters/${charId}/risu-modules/no-such-module`, {
      headers: AUTH,
    });
    expect(unknownModule.status()).toBe(404);
    expect(((await unknownModule.json()) as { error: string }).error).toBe('Module not found');

    // Non-risum upload → 400 from the container parser (bad magic byte 'x'=120).
    const notRisum = await request.post(`/api/characters/${charId}/risu-module`, {
      headers: AUTH,
      multipart: {
        file: {
          name: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('xxx this is definitely not a risum container, just text'),
        },
      },
    });
    expect(notRisum.status()).toBe(400);
    expect(((await notRisum.json()) as { error: string }).error).toBe(
      'Not a .risum file: bad magic byte 120 (expected 111)',
    );

    // Attach without a file field → 400 'No file uploaded'.
    const noFile = await request.post(`/api/characters/${charId}/risu-module`, {
      headers: AUTH,
      multipart: { note: 'no file field here' },
    });
    expect(noFile.status()).toBe(400);
    expect(((await noFile.json()) as { error: string }).error).toBe('No file uploaded');
  });
});
