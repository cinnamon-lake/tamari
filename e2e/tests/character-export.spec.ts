import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';

/** The e2e webServer pins TAMARI_SECRET to this value (playwright.config.ts). */
const AUTH = { Authorization: 'Bearer e2e-test-secret' };

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
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

test.describe('Character Export', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('exports a character as chara_card_v3 JSON', async ({ page, request }) => {
    const app = new App(page);
    const charName = uniqueName('Export Char');
    await app.createCharacter({
      name: charName,
      description: 'A test character for export.',
      firstMes: 'Hello from export.',
    });
    await expectNoAxeViolations(page);

    // The sidebar row's DOM id is the character id.
    const charId = await page.locator('.character-list li', { hasText: charName }).getAttribute('id');
    expect(charId).toBeTruthy();

    const res = await request.get(`/api/characters/${charId}/export?format=v3`, { headers: AUTH });
    expect(res.ok()).toBe(true);

    // The export is a PNG with the card JSON (base64) in the `ccv3` tEXt chunk.
    const body = await res.body();
    expect(body.subarray(1, 4).toString('latin1')).toBe('PNG');
    const b64 = extractPngTextChunk(body, 'ccv3');
    expect(b64).toBeTruthy();
    const card = JSON.parse(Buffer.from(b64!, 'base64').toString('utf8')) as { spec: string; data: Record<string, unknown> };
    expect(card.spec).toBe('chara_card_v3');
    expect(card.data['name']).toBe(charName);
    expect(card.data['description']).toBe('A test character for export.');
    expect(card.data['first_mes']).toBe('Hello from export.');
  });

  test('exports a character as a CharX archive', async ({ page, request }) => {
    const app = new App(page);
    const charName = uniqueName('CharX Char');
    await app.createCharacter({ name: charName, description: 'CharX test.', firstMes: 'Hi.' });

    const charId = await page.locator('.character-list li', { hasText: charName }).getAttribute('id');
    const res = await request.get(`/api/characters/${charId}/export?format=charx`, { headers: AUTH });
    expect(res.ok()).toBe(true);
    const body = await res.body();
    // ZIP magic bytes + non-trivial payload (card.json bundled in the archive).
    expect(body.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(body.length).toBeGreaterThan(100);
  });
});
