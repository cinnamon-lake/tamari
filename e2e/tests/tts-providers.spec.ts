/**
 * TTS provider adapter coverage.
 *
 * One parameterized pass per speak-tool provider: configure the toolset with
 * the mock server as baseUrl, trigger `tool:speak`, then assert (a) the tool
 * result + inline audio render, and (b) the adapter's outgoing HTTP request —
 * endpoint path, auth header, and payload shape — via the mock's generic
 * request capture (GET /last-request?route=<prefix>).
 *
 * Provider keys, endpoints, auth headers and payload fields are verified
 * against server/src/tts/*.ts; the mock routes against e2e/fixtures/mockLlmServer.ts.
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

interface CapturedTtsRequest {
  route: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Poll the mock's generic capture until a POST to `routePrefix` lands.
 * The TTS call is made server-side during tool execution, so by the time the
 * assistant reply settles it has normally arrived — polling just removes the
 * residual race instead of asserting on a single read.
 */
async function getCapturedTtsRequest(routePrefix: string, timeout = 10000): Promise<CapturedTtsRequest> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const res = await fetch(`${MOCK_URL}/last-request?route=${encodeURIComponent(routePrefix)}`);
    if (!res.ok) throw new Error(`mock /last-request failed: HTTP ${res.status}`);
    const data = (await res.json()) as CapturedTtsRequest | null;
    if (data) return data;
    if (Date.now() >= deadline) {
      throw new Error(`no captured request for route "${routePrefix}" within ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Header lookup — Node lowercases all incoming header names. */
function header(req: CapturedTtsRequest, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
}

interface ProviderCase {
  /** Provider key (SpeakTemplate config `provider`, factory branch). */
  id: string;
  /** Toolset config beyond provider/baseUrl/apiKey. */
  extraConfig?: Record<string, unknown>;
  /** Route prefix for the mock's generic capture. */
  routePrefix: string;
  /** Expected request path (the mock stores the full path, incl. voice ids). */
  expectedRoute?: string;
  /** Adapter-specific auth header + payload shape assertions. `text` is the spoken text. */
  assert: (req: CapturedTtsRequest, text: string) => void;
}

const PROVIDERS: ProviderCase[] = [
  {
    // Sanity — already covered by tts.spec.ts; included for matrix completeness.
    id: 'kokoro',
    routePrefix: '/audio/speech',
    assert: (req, text) => {
      expect(header(req, 'authorization')).toBe('Bearer mock-api-key');
      const body = req.body as Record<string, unknown>;
      expect(body.input).toBe(text);
      expect(body.model).toBe('kokoro');
      expect(body.voice).toBe('af_heart'); // adapter default voice
    },
  },
  {
    id: 'openai',
    extraConfig: { voiceId: 'nova', model: 'mock-tts-1' },
    routePrefix: '/v1/audio/speech',
    assert: (req, text) => {
      expect(header(req, 'authorization')).toBe('Bearer mock-api-key');
      const body = req.body as Record<string, unknown>;
      expect(body.input).toBe(text);
      expect(body.model).toBe('mock-tts-1');
      expect(body.voice).toBe('nova');
    },
  },
  {
    id: 'alltalk',
    extraConfig: { voiceId: 'echo' },
    routePrefix: '/v1/audio/speech',
    assert: (req, text) => {
      // AllTalk's OpenAI-compatible endpoint needs no auth.
      expect(header(req, 'authorization')).toBe('');
      const body = req.body as Record<string, unknown>;
      expect(body.input).toBe(text);
      expect(body.model).toBe('tts-1');
      expect(body.voice).toBe('echo');
    },
  },
  {
    id: 'elevenlabs',
    extraConfig: { voiceId: 'mock-voice-42', model: 'mock_eleven_v2' },
    routePrefix: '/v1/text-to-speech/',
    expectedRoute: '/v1/text-to-speech/mock-voice-42',
    assert: (req, text) => {
      expect(header(req, 'xi-api-key')).toBe('mock-api-key');
      const body = req.body as Record<string, unknown>;
      expect(body.text).toBe(text);
      expect(body.model_id).toBe('mock_eleven_v2');
      expect(body.voice_settings).toBeDefined();
    },
  },
  {
    id: 'azure',
    extraConfig: { voiceId: 'en-US-JennyNeural' },
    routePrefix: '/cognitiveservices/v1',
    assert: (req, text) => {
      expect(header(req, 'ocp-apim-subscription-key')).toBe('mock-api-key');
      expect(header(req, 'content-type')).toContain('application/ssml+xml');
      // Azure posts a raw SSML document; the mock keeps it as raw text.
      expect(typeof req.body).toBe('string');
      const ssml = req.body as string;
      expect(ssml).toContain(`<voice name="en-US-JennyNeural">`);
      expect(ssml).toContain(text);
    },
  },
  {
    id: 'minimax',
    extraConfig: { voiceId: 'male-qn-qingse', model: 'mock-speech-02' },
    routePrefix: '/v1/t2a_v2',
    assert: (req, text) => {
      expect(header(req, 'authorization')).toBe('Bearer mock-api-key');
      const body = req.body as Record<string, unknown>;
      expect(body.text).toBe(text);
      expect(body.model).toBe('mock-speech-02');
      expect(body.output_format).toBe('hex');
      expect((body.voice_setting as Record<string, unknown>).voice_id).toBe('male-qn-qingse');
    },
  },
  {
    id: 'volcengine',
    extraConfig: { appId: 'mock-app-id', voiceId: 'zh_female_wanwanxiaohe' },
    routePrefix: '/api/v1/tts',
    assert: (req, text) => {
      // VolcEngine OpenSpeech: semicolon between "Bearer" and the token, no space.
      expect(header(req, 'authorization')).toBe('Bearer;mock-api-key');
      const body = req.body as Record<string, unknown>;
      expect((body.app as Record<string, unknown>).appid).toBe('mock-app-id');
      expect((body.app as Record<string, unknown>).cluster).toBe('volcano_tts');
      expect((body.request as Record<string, unknown>).text).toBe(text);
      expect((body.audio as Record<string, unknown>).voice_type).toBe('zh_female_wanwanxiaohe');
    },
  },
  {
    id: 'fishaudio',
    extraConfig: { voiceId: 'ref-mock-1' },
    routePrefix: '/tts',
    expectedRoute: '/tts',
    assert: (req, text) => {
      expect(header(req, 'authorization')).toBe('Bearer mock-api-key');
      const body = req.body as Record<string, unknown>;
      expect(body.text).toBe(text);
      expect(body.format).toBe('wav');
      expect(body.reference_id).toBe('ref-mock-1');
    },
  },
  {
    id: 'vits',
    extraConfig: { voiceId: '7' },
    routePrefix: '/voice/vits',
    assert: (req, text) => {
      expect(header(req, 'x-api-key')).toBe('mock-api-key');
      const body = req.body as Record<string, unknown>;
      expect(body.text).toBe(text);
      expect(body.id).toBe(7); // numeric speaker id
      expect(body.format).toBe('wav');
    },
  },
  {
    id: 'silero',
    extraConfig: { voiceId: 'en_5' },
    routePrefix: '/tts/generate',
    assert: (req, text) => {
      // silero-api-server has no auth.
      expect(header(req, 'authorization')).toBe('');
      const body = req.body as Record<string, unknown>;
      expect(body.text).toBe(text);
      expect(body.speaker).toBe('en_5');
      expect(body.session).toBe('tamari');
    },
  },
  {
    id: 'gptsovits',
    extraConfig: { voiceId: '/refs/mock-voice.wav' },
    routePrefix: '/tts',
    expectedRoute: '/tts',
    assert: (req, text) => {
      // GPT-SoVITS api_v2 has no auth; the "voice" is a server-side ref-audio path.
      expect(header(req, 'authorization')).toBe('');
      const body = req.body as Record<string, unknown>;
      expect(body.text).toBe(text);
      expect(body.ref_audio_path).toBe('/refs/mock-voice.wav');
      expect(body.media_type).toBe('wav');
    },
  },
];

// Serial: the mock's request capture is shared global state, and several
// providers collide on route prefixes (/tts, /v1/audio/speech) — one test at
// a time with a reset in beforeEach keeps each capture unambiguous.
test.describe.serial('TTS providers (speak tool)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  for (const provider of PROVIDERS) {
    test(`provider ${provider.id}: speaks and hits the adapter endpoint with correct auth + payload`, async ({ page }) => {
      const app = new App(page);
      const text = `hello from ${provider.id}`;
      const toolsetId = await enableBuiltinToolset(page, 'speak', {
        provider: provider.id,
        baseUrl: MOCK_URL,
        apiKey: 'mock-api-key',
        ...provider.extraConfig,
      });
      try {
        await app.createCharacterAndChat({ name: uniqueName(`TTS ${provider.id}`), firstMes: 'Ready.' });
        await app.sendUserMessage(`tool:speak {"text":"${text}"}`, { expectReply: true });

        // (a) Tool call + result rendered; audio saved as attachment, inline player visible.
        const bubble = app.lastBubble('assistant');
        await expect(bubble.locator('.tool-call-block').first()).toBeVisible({ timeout: 10000 });
        await expect(bubble.locator('.tool-result-block').first()).toBeVisible({ timeout: 10000 });
        await expect(page.locator('audio, .message-inline-audio').first()).toBeVisible({ timeout: 10000 });

        // (b) The adapter's outgoing request hit the mock with the right path,
        // auth header and payload shape.
        const req = await getCapturedTtsRequest(provider.routePrefix);
        if (provider.expectedRoute) expect(req.route).toBe(provider.expectedRoute);
        provider.assert(req, text);
      } finally {
        await deleteToolset(page, toolsetId);
      }
    });
  }

  test('error path: TTS endpoint failure surfaces in the tool result', async ({ page }) => {
    const app = new App(page);
    // Azure joins `${baseUrl}/cognitiveservices/v1`, so a bogus baseUrl segment
    // yields /nope/cognitiveservices/v1 — the mock answers 404, and the adapter
    // throws "TTS generation failed: HTTP 404 - ...".
    const toolsetId = await enableBuiltinToolset(page, 'speak', {
      provider: 'azure',
      baseUrl: `${MOCK_URL}/nope`,
      apiKey: 'mock-api-key',
      voiceId: 'en-US-JennyNeural',
    });
    try {
      await app.createCharacterAndChat({ name: uniqueName('TTS error'), firstMes: 'Ready.' });
      await app.sendUserMessage('tool:speak {"text":"hello from azure"}', { expectReply: true });

      const bubble = app.lastBubble('assistant');
      const result = bubble.locator('.tool-result-block').first();
      await expect(result).toBeVisible({ timeout: 10000 });
      // SpeakTemplate wraps adapter errors as `TTS generation failed: <adapter msg>`.
      await expect(result.locator('.tool-result-content')).toContainText('TTS generation failed');
      await expect(result.locator('.tool-result-content')).toContainText('HTTP 404');
      // No audio attachment was produced.
      await expect(page.locator('audio, .message-inline-audio')).toHaveCount(0);
    } finally {
      await deleteToolset(page, toolsetId);
    }
  });
});
