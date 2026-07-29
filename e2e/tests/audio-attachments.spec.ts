/**
 * Attachment handling in outgoing prompts (OpenAI-compatible mock backend).
 *
 * Covers:
 *  - resolveLocalAttachmentUrl (server/src/backends/resolveLocalAttachment.ts):
 *    a local /api/attachments/{id} image becomes a base64 data URI on the wire.
 *  - ChatCompletionRenderer media paths: image content part when
 *    supportsImages is on, '[Attached image]' placeholder when it is off and
 *    mediaVerboseMode is enabled, audio content part when supportsAudio is on.
 *
 * NOTE: the mock's `respond:` selector only reads STRING message content, so
 * messages carrying attachment content-part arrays get the default reply.
 * These tests therefore assert on the captured request, not the reply text.
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { setSetting } from '../helpers/settings.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Minimal 1x1 transparent PNG in base64 (same fixture as attachments.spec.ts).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Minimal valid WAV: 44-byte PCM header + 100 samples of 16-bit silence
 *  (byte-identical recipe to the mock server's tinyWav()). */
function tinyWav(): Buffer {
  const dataSize = 200;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(8000, 24); // sample rate
  buf.writeUInt32LE(16000, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

interface WireContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  input_audio?: { data: string; format: string };
}

/** Last user message of a captured chat/completions body, content as parts. */
function lastUserParts(body: unknown): WireContentPart[] {
  const messages = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
  const lastUser = messages
    .slice()
    .reverse()
    .find((m) => m.role === 'user');
  expect(lastUser, 'captured request has a user message').toBeTruthy();
  expect(Array.isArray(lastUser!.content), 'user message content is a content-part array').toBe(true);
  return lastUser!.content as WireContentPart[];
}

test.describe('Attachments in prompts', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await setSetting(page, 'mediaVerboseMode', false);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    // resetBackendConfig does not touch capability flags — restore explicitly.
    await patchActiveBackendConfig(page, { supportsImages: true, supportsAudio: true });
    await setSetting(page, 'mediaVerboseMode', false);
    await resetBackendConfig(page);
  });

  test('image attachment is sent as a base64 data URI image part', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Image Attachment Character');
    await app.createCharacterAndChat({ name: charName, description: 'Image attachment test character.', firstMes: 'Hello from Image attachment !' });

    await page.locator('.message-input-area .hidden-file-input').setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({ timeout: 5000 });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('look at this image');
    const cap = await waitForNextLlmRequest(before);

    const parts = lastUserParts(cap.body);
    const textPart = parts.find((p) => p.type === 'text');
    expect(textPart?.text).toContain('look at this image');

    const imagePart = parts.find((p) => p.type === 'image_url');
    expect(imagePart, 'image content part present').toBeTruthy();
    expect(imagePart!.image_url!.url.startsWith('data:image/png;base64')).toBe(true);

    await app.waitForAssistantText(/deterministic mock response/);
  });

  test('supportsImages off + verbose mode sends the [Attached image] placeholder', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Image Placeholder Character');
    await app.createCharacterAndChat({ name: charName, description: 'Image placeholder test character.', firstMes: 'Hello from Image placeholder !' });

    await patchActiveBackendConfig(page, { supportsImages: false });
    await setSetting(page, 'mediaVerboseMode', true);

    await page.locator('.message-input-area .hidden-file-input').setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({ timeout: 5000 });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('look at this image');
    const cap = await waitForNextLlmRequest(before);

    const parts = lastUserParts(cap.body);
    expect(parts.some((p) => p.type === 'image_url')).toBe(false);
    const texts = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '');
    expect(texts.some((t) => t.includes('look at this image'))).toBe(true);
    expect(texts.some((t) => t.includes('[Attached image]'))).toBe(true);
  });

  test('audio attachment is sent as an input_audio content part', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Audio Attachment Character');
    await app.createCharacterAndChat({ name: charName, description: 'Audio attachment test character.', firstMes: 'Hello from Audio attachment !' });

    await page.locator('.message-input-area .hidden-file-input').setInputFiles({
      name: 'test-audio.wav',
      mimeType: 'audio/wav',
      buffer: tinyWav(),
    });
    await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({ timeout: 5000 });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('listen to this');
    const cap = await waitForNextLlmRequest(before);

    const parts = lastUserParts(cap.body);
    const audioPart = parts.find((p) => p.type === 'input_audio');
    expect(audioPart, 'audio content part present').toBeTruthy();
    expect(audioPart!.input_audio!.format).toBe('wav');
    expect(audioPart!.input_audio!.data.length).toBeGreaterThan(0);
    // The data URI round-trips the exact uploaded bytes.
    expect(audioPart!.input_audio!.data).toBe(tinyWav().toString('base64'));
  });
});
