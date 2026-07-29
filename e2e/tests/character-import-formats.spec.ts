/**
 * Character card import/export format coverage.
 *
 * Complements character-export.spec.ts (export happy paths) and
 * journeys/character-lifecycle.spec.ts (JSON/PNG UI round-trip) with:
 *   1. Import error paths (no file / garbage bytes / malformed JSON card).
 *   2. CharX (zip) import via REST — card.json + embedded icon avatar + assets.
 *   3. Character asset serving (fast path, DB fallback, 404s).
 *   4. CharX import through the sidebar file input (UI path).
 *   5. Export of a character with a linked lorebook (embedded characterBook in
 *      both the v3 PNG and the CharX archive) and CharX asset bundling.
 *   6. Avatar upload via REST and serving of the resulting avatar file.
 *
 * The CharX fixture mirrors the server's own export layout
 * (server/src/api/characters.ts ~546-561): `card.json` at the zip root, assets
 * at `<type>s/<name>.<ext>`, card asset entries with `embeded://` URIs (the
 * spec's historical typo, see server/src/lib/charx.ts buildAssetUri).
 *
 * Serial: tests 3 and 5 reuse the character imported in test 2.
 */
import { test, expect } from '../fixtures/base.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import { wsDeleteByPrefix } from '../helpers/cleanup.js';

/** The e2e webServer pins TAMARI_SECRET to this value (playwright.config.ts). */
const AUTH = { Authorization: 'Bearer e2e-test-secret' };

// Minimal 1x1 transparent PNG (same fixture as attachments.spec.ts).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Build an in-memory .charx archive mirroring the server's export layout. */
function buildCharX(name: string): Buffer {
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description: 'A character from a CharX archive.',
      first_mes: 'Hello from CharX.',
      tags: ['charx', 'e2e'],
      assets: [
        { type: 'icon', name: 'main', ext: 'png', uri: 'embeded://icons/main.png' },
        { type: 'background', name: 'bg', ext: 'png', uri: 'embeded://backgrounds/bg.png' },
      ],
    },
  };
  return Buffer.from(
    zipSync({
      'card.json': strToU8(JSON.stringify(card)),
      'icons/main.png': PNG_BYTES,
      'backgrounds/bg.png': PNG_BYTES,
    }),
  );
}

/** Extract a tEXt chunk (e.g. `ccv3`) from a PNG buffer. Returns null if absent. */
function extractPngTextChunk(buf: Buffer, keyword: string): string | null {
  let offset = 8; // skip the 8-byte PNG signature
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    if (type === 'tEXt') {
      const data = buf.subarray(dataStart, dataStart + length);
      const nul = data.indexOf(0);
      if (nul > 0 && data.subarray(0, nul).toString('latin1') === keyword) {
        return data.subarray(nul + 1).toString('utf8');
      }
    }
    offset = dataStart + length + 4; // data + CRC
  }
  return null;
}

interface ImportedAsset {
  id: string;
  name: string;
  type: string;
  ext: string;
}

// Shared state populated by the CharX import test, reused by the asset-serving
// and CharX-export tests (serial mode).
let charxCharId = '';
let charxAssets: ImportedAsset[] = [];

test.describe('Character Import Formats', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // Clean up everything this file leaves on the shared server. The lorebook
  // matters beyond tidiness — any leftover book makes the character editor
  // render its `.lorebook-selector > select`, which fails the axe checks in
  // character.spec (an unlabeled-select violation that only exists while at
  // least one book exists).
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page);
    await wsDeleteByPrefix(page, {
      charPrefixes: ['CharX REST ', 'CharX UI ', 'Lorebook Char ', 'Avatar Char '],
      bookPrefixes: ['Export Book '],
    });
    await page.close();
  });

  test('import error paths return 400/500 with the documented messages', async ({ request }) => {
    // No file at all → 400.
    const noFile = await request.post('/api/characters/import', {
      headers: AUTH,
      multipart: { note: 'no file field here' },
    });
    expect(noFile.status()).toBe(400);
    expect((await noFile.json()).error).toBe('No file uploaded');

    // Garbage bytes (no PNG/ZIP signature, not JSON) → 400 with exact message.
    const garbage = await request.post('/api/characters/import', {
      headers: AUTH,
      multipart: {
        file: { name: 'card.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('not a card at all!!!') },
      },
    });
    expect(garbage.status()).toBe(400);
    expect((await garbage.json()).error).toBe('Unsupported file format. Upload a PNG, CharX, or JSON card.');

    // Starts with '{' so it takes the JSON branch, but the JSON is malformed →
    // JSON.parse throws inside the route → 500 (not a ZodError, so no 400).
    const malformed = await request.post('/api/characters/import', {
      headers: AUTH,
      multipart: {
        file: { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"name": "Broken Card",') },
      },
    });
    expect(malformed.status()).toBe(500);
  });

  test('imports a CharX archive via REST (card, icon avatar, assets)', async ({ page, request }) => {
    const charName = uniqueName('CharX REST');
    const res = await request.post('/api/characters/import', {
      headers: AUTH,
      multipart: { file: { name: 'card.charx', mimeType: 'application/zip', buffer: buildCharX(charName) } },
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as {
      success: boolean;
      character: { id: string; name: string; avatarUrl: string | null; assets: ImportedAsset[] };
    };
    expect(body.success).toBe(true);
    expect(body.character.name).toBe(charName);
    charxCharId = body.character.id;
    charxAssets = body.character.assets;

    // The embedded `icon` asset named `main` becomes the character avatar.
    expect(body.character.avatarUrl).toMatch(/^\/files\/avatars\/.+\.png$/);
    const avatarRes = await request.get(body.character.avatarUrl!, { headers: AUTH });
    expect(avatarRes.ok()).toBe(true);
    expect(avatarRes.headers()['content-type']).toContain('image/');

    // Both declared assets were extracted and registered.
    expect(charxAssets.map((a) => a.name).sort()).toEqual(['bg', 'main']);

    // The character appears in the sidebar (delivered via WS broadcast).
    await page.locator('input[placeholder="Search characters..."]').fill(charName);
    await expect(page.locator('.character-list li', { hasText: charName })).toBeVisible({ timeout: 10000 });
  });

  test('serves character assets and 404s bogus ids', async ({ request }) => {
    expect(charxCharId, 'CharX import test ran first').toBeTruthy();
    const bg = charxAssets.find((a) => a.name === 'bg');
    expect(bg).toBeTruthy();

    // Fast path: URL includes the file extension → served straight from disk.
    const fast = await request.get(`/api/characters/${charxCharId}/assets/${bg!.id}.${bg!.ext}`, { headers: AUTH });
    expect(fast.ok()).toBe(true);
    expect(fast.headers()['content-type']).toContain('image/png');
    expect((await fast.body()).subarray(1, 4).toString('latin1')).toBe('PNG');

    // Fallback path: extension-less asset id → DB lookup.
    const fallback = await request.get(`/api/characters/${charxCharId}/assets/${bg!.id}`, { headers: AUTH });
    expect(fallback.ok()).toBe(true);
    expect(fallback.headers()['content-type']).toContain('image/png');

    // Bogus asset id → 404.
    const bogusAsset = await request.get(`/api/characters/${charxCharId}/assets/does-not-exist.png`, { headers: AUTH });
    expect(bogusAsset.status()).toBe(404);
    expect((await bogusAsset.json()).error).toBe('Asset not found');

    // Bogus character id → also 404 (fast path misses, DB lookup misses).
    const bogusChar = await request.get('/api/characters/no-such-character/assets/does-not-exist.png', { headers: AUTH });
    expect(bogusChar.status()).toBe(404);
  });

  test('imports a CharX archive through the sidebar file input', async ({ page }) => {
    const charName = uniqueName('CharX UI');
    await page.locator('input[accept="image/png,.charx,.json"]').setInputFiles({
      name: 'card.charx',
      mimeType: 'application/zip',
      buffer: buildCharX(charName),
    });
    await page.locator('input[placeholder="Search characters..."]').fill(charName);
    await expect(page.locator('.character-list li', { hasText: charName })).toBeVisible({ timeout: 10000 });
    // A failed import would surface the "import failed" alert popup.
    await expect(page.locator('.popup-modal')).toHaveCount(0);
  });

  test('exports embed the linked lorebook and bundle assets in CharX', async ({ page, request }) => {
    const app = new App(page);
    const stamp = `${Date.now()}`;
    const bookName = `Export Book ${stamp}`;
    const charName = `Lorebook Char ${stamp}`;

    const bookLabel = await app.createLorebook(bookName, `key${stamp}`, `TOKEN${stamp}`);
    await app.createCharacter({ name: charName, description: 'Has a lorebook.', lorebookBookLabel: bookLabel });

    const charId = await page.locator('.character-list li', { hasText: charName }).getAttribute('id');
    expect(charId).toBeTruthy();

    // v3 PNG export embeds the linked lorebook as data.character_book.
    const pngRes = await request.get(`/api/characters/${charId}/export?format=v3`, { headers: AUTH });
    expect(pngRes.ok()).toBe(true);
    const b64 = extractPngTextChunk(await pngRes.body(), 'ccv3');
    expect(b64).toBeTruthy();
    const v3Card = JSON.parse(Buffer.from(b64!, 'base64').toString('utf8')) as {
      data: { character_book?: { name: string; entries: unknown[] } };
    };
    expect(v3Card.data.character_book?.name).toBe(bookName);
    expect(v3Card.data.character_book?.entries).toHaveLength(1);

    // CharX export of the same character carries the book in card.json.
    const bookCharX = await request.get(`/api/characters/${charId}/export?format=charx`, { headers: AUTH });
    expect(bookCharX.ok()).toBe(true);
    const bookZip = unzipSync(new Uint8Array(await bookCharX.body()));
    const bookCard = JSON.parse(strFromU8(bookZip['card.json']!)) as {
      data: { character_book?: { name: string; entries: unknown[] }; assets?: unknown[] };
    };
    expect(bookCard.data.character_book?.name).toBe(bookName);

    // CharX export of the REST-imported character (test 2) bundles its assets
    // under <type>s/<name>.<ext> next to card.json.
    expect(charxCharId, 'CharX import test ran first').toBeTruthy();
    const assetCharX = await request.get(`/api/characters/${charxCharId}/export?format=charx`, { headers: AUTH });
    expect(assetCharX.ok()).toBe(true);
    const assetZip = unzipSync(new Uint8Array(await assetCharX.body()));
    expect(Object.keys(assetZip)).toEqual(
      expect.arrayContaining(['card.json', 'icons/main.png', 'backgrounds/bg.png']),
    );
  });

  test('uploads an avatar via REST and serves it back', async ({ page, request }) => {
    const app = new App(page);
    const charName = uniqueName('Avatar Char');
    await app.createCharacter({ name: charName });
    const charId = await page.locator('.character-list li', { hasText: charName }).getAttribute('id');
    expect(charId).toBeTruthy();

    const upload = await request.post(`/api/characters/${charId}/avatar`, {
      headers: AUTH,
      multipart: { avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64') } },
    });
    expect(upload.status()).toBe(200);
    expect((await upload.json()).success).toBe(true);

    // The sidebar row's avatar img picks up the new URL via the WS broadcast.
    const avatarImg = page.locator(
      `.character-list li:has-text("${charName}") img.character-avatar[src*="/files/avatars/"]`,
    );
    await avatarImg.waitFor({ state: 'visible', timeout: 10000 });
    const src = await avatarImg.getAttribute('src');
    expect(src).toBeTruthy();

    const avatarRes = await request.get(src!, { headers: AUTH });
    expect(avatarRes.ok()).toBe(true);
    expect(avatarRes.headers()['content-type']).toContain('image/');
    expect((await avatarRes.body()).subarray(1, 4).toString('latin1')).toBe('PNG');
  });
});
