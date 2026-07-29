/**
 * Deterministic mock LLM/TTS server for browser E2E tests.
 *
 * Runs locally and is pointed at by the active tamari backend config so
 * generation-dependent UI flows can be exercised without API keys or GPUs.
 *
 * OpenAI-compatible endpoints:
 *   GET  /models             -> lists a single mock model (OpenAI shape, or the
 *                               Claude model-list shape when `x-api-key` is sent)
 *   POST /chat/completions   -> streams a deterministic SSE response
 *   POST /completions        -> text-completion mode (flat prompt string)
 *   POST /embeddings         -> deterministic bag-of-words vectors
 *   GET  /last-request       -> captured completion request body + count
 *   GET  /last-request?route=<path-prefix>
 *                            -> last captured request (any POST route) whose
 *                               route starts with the prefix, as
 *                               {route, body, headers} (or null)
 *   POST /__reset-requests   -> resets all capture state
 *
 * Native backend dialects (match the server adapters' wire protocols):
 *   POST /messages                              -> Anthropic Claude SSE
 *   POST /models/{model}:streamGenerateContent  -> Google Gemini SSE (query ignored)
 *   POST /api/extra/generate/stream             -> KoboldCpp SSE
 *   POST /api/extra/abort                       -> KoboldCpp abort (200 {ok:true})
 *   POST /completion                            -> llama.cpp native SSE
 *
 * TTS / image endpoints (all captured by the generic request capture):
 *   POST /v1/audio/speech            -> raw WAV (openai / alltalk; /audio/speech too)
 *   POST /v1/text-to-speech/{voice}  -> raw WAV (elevenlabs)
 *   POST /cognitiveservices/v1       -> raw WAV (azure; body is raw SSML)
 *   POST /v1/t2a_v2                  -> JSON {data:{audio:<hex wav>}, base_resp:{status_code:0}} (minimax)
 *   POST /api/v1/tts                 -> JSON {code:3000, data:<base64 wav>} (volcengine)
 *   POST /tts                        -> raw WAV (fishaudio / gptsovits)
 *   POST /voice/vits                 -> raw WAV (vits)
 *   POST /tts/generate               -> raw WAV (silero)
 *   POST /sdapi/v1/txt2img           -> JSON {images:[<base64 1x1 PNG>]}
 *
 * Prompt selectors (prefix of the last user message, or — for flat-prompt
 * endpoints — the newest matching prompt line; honored by EVERY dialect):
 *   respond:<text>     -> reply with <text>
 *   seq:               -> reply with "Turn N" (monotonic counter)
 *   length:<text>      -> reply with <text> but report a length finish reason
 *                         (Claude max_tokens / Gemini MAX_TOKENS / OpenAI length /
 *                          KoboldCpp length / llama.cpp stopped_limit)
 *   slow:<ms>:<text>   -> stream <text> with <ms> delay between chunks (clamped
 *                         to 2000ms) — for Stop-button tests
 *   think:             -> stream reasoning tokens before the answer (chat +
 *                         Claude thinking block + Gemini thought parts)
 *   tool:name[{json}],name2[{json2}],...
 *                      -> emit one tool call per round, walking the sequence
 *   [WI] TOKEN / [AN] TOKEN anywhere in the prompt -> reply "inject:TOKEN,..."
 *
 * Selector precedence: length:/slow: are checked before respond:/seq:.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export interface MockLlmServer {
  url: string;
  stop: () => Promise<void>;
}

export interface MockLlmServerOptions {
  port?: number;
  host?: string;
  defaultText?: string;
}

const DEFAULT_RESPONSE = 'Hello! This is a deterministic mock response from the e2e test server.';

/** Clamp for the `slow:` selector so a typo can't stall a test run. */
const MAX_SLOW_DELAY_MS = 2000;

/**
 * A static markdown document served at GET /sacred-scrolls.md — lets e2e tests
 * exercise "download a doc over HTTP" flows (allowNet fetch, attachments)
 * hermetically, without depending on the real internet.
 */
const SACRED_SCROLLS_MD = `# The Sacred Scrolls of Mocktopia

> In the beginning there was the Prompt, and the Prompt was deterministic.

## Chapter 1: The Incrementing

And lo, the prophet seq: spoke, and the server answered "Turn 1".
And it spoke again, and the answer was "Turn 2".
The elders nodded: the counter incrementeth eternally, and it is good.

## Chapter 2: The Tool Call

Blessed are those who prefix their message with tool:, for they shall receive
exactly one tool call per round, and the sequence shall walk until it is
exhausted, and then the answer shall be plain text.

## Chapter 3: The Sacred Constants

- The default response is always the same sentence, and it shall never be shortened.
- Thou shalt not stream non-deterministically.
- The embeddings are bag-of-words, and the bag is holy.
- The WAV is silent, and the silence is 100 samples long.
`;

/**
 * Monotonic counter for `seq:` responses. There is exactly one mock server per
 * Playwright run (started in global-setup, workers: 1), so a module-level
 * counter is sufficient and gives each `seq:` turn a distinct, assertable
 * `Turn N` reply — including across regenerate/swipe, which resend the same
 * prompt and thus increment the counter to a new value.
 */
let seqCallCount = 0;

/**
 * Capture of every /chat/completions request body + a monotonic count, exposed
 * via GET /last-request so e2e journeys can assert that sampler parameters
 * (temperature, seed, mirostat, …) actually reached the outgoing request — the
 * end-to-end proof of the GenerationService sampler wiring. One mock server per
 * run + workers: 1 keeps this race-free; journeys still pair the count with the
 * body so a stale capture from a prior spec can't satisfy them.
 */
let completionCount = 0;
let lastRequestBody: unknown = null;
let lastRequestAuth: string | undefined = undefined;

/**
 * Generic capture of every POST route (backend dialects, TTS, image gen),
 * exposed via GET /last-request?route=<path-prefix>. Bodies are JSON-parsed
 * when possible, otherwise kept as raw text (e.g. Azure's SSML payload).
 */
interface CapturedRequest {
  route: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}
const capturedRequests: CapturedRequest[] = [];

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseJson(raw: string): unknown {
  try {
    return raw ? (JSON.parse(raw) as unknown) : {};
  } catch {
    return raw;
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendModels(res: http.ServerResponse, claudeShape: boolean) {
  if (claudeShape) {
    // Anthropic GET /models — see ClaudeModelListSchema.
    sendJson(res, 200, {
      data: [
        { type: 'model', id: 'mock-claude', display_name: 'Mock Claude', max_input_tokens: 200000, created_at: '2025-01-01T00:00:00Z' },
      ],
      has_more: false,
      first_id: 'mock-claude',
      last_id: 'mock-claude',
    });
    return;
  }
  sendJson(res, 200, {
    object: 'list',
    data: [{ id: 'mock-model', object: 'model' }],
  });
}

function getLastUserContent(body: unknown): string {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  const lastUser = messages
    .slice()
    .reverse()
    .find((m) => typeof m === 'object' && m !== null && (m as Record<string, unknown>).role === 'user');
  if (!lastUser || typeof lastUser !== 'object') return '';
  return String((lastUser as Record<string, unknown>).content ?? '');
}

/** Collect every human-readable string out of a nested content structure. */
function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectText(v, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.text === 'string') out.push(rec.text);
    else out.push(JSON.stringify(value));
  }
}

/** Claude: last user-turn text (content may be a string or content blocks). */
function getClaudeLastUserText(body: unknown): string {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  const lastUser = messages
    .slice()
    .reverse()
    .find((m) => typeof m === 'object' && m !== null && (m as Record<string, unknown>).role === 'user');
  if (!lastUser) return '';
  const texts: string[] = [];
  collectText((lastUser as Record<string, unknown>).content, texts);
  return texts.join('');
}

/** Gemini: last user-turn text (contents[].parts[]). */
function getGeminiLastUserText(body: unknown): string {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const contents = Array.isArray(reqBody.contents) ? reqBody.contents : [];
  const lastUser = contents
    .slice()
    .reverse()
    .find((c) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).role === 'user');
  if (!lastUser) return '';
  const texts: string[] = [];
  collectText((lastUser as Record<string, unknown>).parts, texts);
  return texts.join('');
}

/**
 * Scan every message in the request for `[WI] TOKEN` / `[AN] TOKEN` sentinels
 * and return the distinct tokens. Used by the injectable probe (see
 * sendCompletion) so journeys can assert world-info / author's-note injection.
 */
function scanInjectables(body: unknown): string[] {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  const tokens: string[] = [];
  const re = /\[(?:WI|AN)\] ([A-Z0-9_]+)/g;
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue;
    const raw = (m as Record<string, unknown>).content;
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    let match: RegExpExecArray | null;
    while ((match = re.exec(str)) !== null) {
      const token = match[1];
      if (token && !tokens.includes(token)) tokens.push(token);
    }
  }
  return tokens;
}

/** Parse a `tool:` spec into a sequence: `name[json],name2[json2],...` */
function parseToolSequence(spec: string): Array<{ name: string; args: string }> {
  const out: Array<{ name: string; args: string }> = [];
  let i = 0;
  while (i < spec.length) {
    let name = '';
    while (i < spec.length && spec[i] !== '{' && spec[i] !== ',') name += spec[i++];
    name = name.trim();
    let args = '{}';
    if (spec[i] === '{') {
      let depth = 0;
      const start = i;
      for (; i < spec.length; i++) {
        if (spec[i] === '{') depth++;
        else if (spec[i] === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      try {
        args = JSON.stringify(JSON.parse(spec.slice(start, i)));
      } catch {
        args = '{}';
      }
    }
    if (name) out.push({ name, args });
    if (spec[i] === ',') i++;
  }
  return out;
}

function writeSseChunk(res: http.ServerResponse, chunk: unknown) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

/** Anthropic-style SSE: paired `event:` / `data:` lines. */
function writeSseEvent(res: http.ServerResponse, event: string, chunk: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(chunk)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Injectable probe over a raw (non-chat) prompt string — see scanInjectables. */
function scanInjectablesInText(text: string): string[] {
  const tokens: string[] = [];
  const re = /\[(?:WI|AN)\] ([A-Z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const token = match[1];
    if (token && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

/** Cut the response at the first occurrence of any stop string. */
function cutAtStopStrings(text: string, stopList: string[]): string {
  let out = text;
  for (const s of stopList) {
    if (!s) continue;
    const idx = out.indexOf(s);
    if (idx >= 0) out = out.slice(0, idx);
  }
  return out;
}

/**
 * Honor the OpenAI `stop` parameter like a real backend: cut the response at
 * the first occurrence of any stop string. Without this, stop-string e2e
 * coverage is impossible — tamari (correctly) delegates enforcement to
 * the backend via the request params.
 */
function applyStopStrings(text: string, body: unknown): string {
  const stopRaw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['stop'] : undefined;
  const stopList = Array.isArray(stopRaw) ? stopRaw.map(String) : typeof stopRaw === 'string' ? [stopRaw] : [];
  return cutAtStopStrings(text, stopList);
}

/** Read a string-array stop parameter (Claude stop_sequences, llama.cpp stop, …). */
function getStopList(body: unknown, key: string): string[] {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return [raw];
  return [];
}

const SELECTOR_PREFIXES = ['length:', 'slow:', 'respond:', 'seq:'];

interface SelectorResult {
  text: string;
  finish: 'stop' | 'length';
  delayMs: number;
}

/**
 * Resolve the shared prompt selectors. `length:`/`slow:` are checked before
 * `respond:`/`seq:` (precedence rule documented in the file header). Returns
 * null when the raw text carries no selector.
 */
function parseSelector(raw: string): SelectorResult | null {
  const lower = raw.toLowerCase();
  if (lower.startsWith('length:')) {
    return { text: raw.slice('length:'.length).trim(), finish: 'length', delayMs: 0 };
  }
  if (lower.startsWith('slow:')) {
    const rest = raw.slice('slow:'.length);
    const idx = rest.indexOf(':');
    const ms = idx > 0 ? Number(rest.slice(0, idx)) : NaN;
    const delayMs = Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_SLOW_DELAY_MS) : 0;
    return { text: idx > 0 ? rest.slice(idx + 1).trim() : rest.trim(), finish: 'stop', delayMs };
  }
  if (lower.startsWith('respond:')) {
    return { text: raw.slice('respond:'.length).trim(), finish: 'stop', delayMs: 0 };
  }
  if (lower.startsWith('seq:')) {
    seqCallCount += 1;
    return { text: `Turn ${seqCallCount}`, finish: 'stop', delayMs: 0 };
  }
  return null;
}

function resolveSelector(raw: string, defaultText: string): SelectorResult {
  return parseSelector(raw) ?? { text: defaultText, finish: 'stop', delayMs: 0 };
}

/**
 * Flat-prompt endpoints (text completion, KoboldCpp, llama.cpp): the user turn
 * sits on its own line somewhere inside the instruct-formatted string. Scan
 * lines (newest first) for a selector.
 */
function selectorFromFlatPrompt(promptText: string, defaultText: string): SelectorResult {
  const selectorLine =
    promptText
      .split('\n')
      .map((l) => l.trim())
      .reverse()
      .find((l) => SELECTOR_PREFIXES.some((p) => l.toLowerCase().startsWith(p))) ?? '';
  return selectorLine ? resolveSelector(selectorLine, defaultText) : { text: defaultText, finish: 'stop', delayMs: 0 };
}

const EMBED_DIM = 256;

/**
 * Deterministic bag-of-words embedding: each token is djb2-hashed to a
 * dimension and counted, then the vector is L2-normalized. Cosine similarity
 * then reflects token overlap — enough for the semantic-WI e2e to exercise
 * the real vector-search path (index → embed → query → activate) with zero
 * nondeterminism.
 */
function embedText(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9_]+/i).filter(Boolean);
  for (const token of tokens) {
    let h = 5381;
    for (let i = 0; i < token.length; i++) {
      h = ((h << 5) + h + token.charCodeAt(i)) >>> 0;
    }
    vec[h % EMBED_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

function sendEmbeddings(res: http.ServerResponse, body: unknown) {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const inputs = Array.isArray(reqBody.input)
    ? reqBody.input
    : typeof reqBody.input === 'string'
      ? [reqBody.input]
      : [];
  sendJson(res, 200, {
    object: 'list',
    data: inputs.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: embedText(String(text)),
    })),
    model: 'mock-embed',
  });
}

/** A minimal valid WAV file: 44-byte PCM header + 100 samples of 16-bit silence. */
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A minimal valid 1x1 RGBA PNG, generated in-code (signature + IHDR + IDAT + IEND). */
function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression (0), filter (0), interlace (0) default to zero
  const raw = Buffer.from([0, 0x7a, 0x9f, 0xff, 0xff]); // filter byte + one RGBA pixel
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Raw WAV bytes with a audio/wav content type (most TTS dialects). */
function sendSpeech(res: http.ServerResponse) {
  const wav = tinyWav();
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
  res.end(wav);
}

/**
 * Text-completion mode (`POST /completions`): the prompt is a single flat
 * string. Streams `choices[].text` chunks with the same deterministic selector
 * rules as the chat endpoint (length:/slow:/respond:/seq: prefixes, inject: probe).
 */
async function sendTextCompletion(res: http.ServerResponse, body: unknown, defaultText: string) {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const promptText = typeof reqBody.prompt === 'string' ? reqBody.prompt : '';

  const selector = selectorFromFlatPrompt(promptText, defaultText);
  let text = selector.text;

  const injected = scanInjectablesInText(promptText);
  if (injected.length > 0) {
    text = `inject:${injected.join(',')}`;
  }

  text = applyStopStrings(text, body);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const baseChunk = {
    id: `cmpl-${randomUUID()}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
  };

  for (const token of text) {
    writeSseChunk(res, { ...baseChunk, choices: [{ text: token, index: 0, finish_reason: null }] });
    if (selector.delayMs > 0) await sleep(selector.delayMs);
  }
  writeSseChunk(res, { ...baseChunk, choices: [{ text: '', index: 0, finish_reason: selector.finish }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function sendCompletion(res: http.ServerResponse, body: unknown, defaultText: string) {
  const lastUserContent = getLastUserContent(body);

  // Use the user message as a prompt selector when tests need a different response.
  // length:/slow:/respond:/seq: — see the file header for the full selector list.
  const selector = resolveSelector(lastUserContent, defaultText);
  let text = selector.text;

  // Injectable probe: world-info entries and author's notes that carry a
  // `[WI] TOKEN` / `[AN] TOKEN` sentinel are (hopefully) injected into the
  // prompt by the pipeline. Echo every such token back so a journey can assert
  // the lorebook/note content actually reached the request — without needing
  // server internals. Tokens use UPPER_SNAKE so they never collide with prose.
  const injected = scanInjectables(body);
  if (injected.length > 0) {
    text = `inject:${injected.join(',')}`;
  }

  // Attachment-reference echo: a tool result in the history carries an
  // {{attachment::ID}} reference (speak/forge_image flows). A well-behaved
  // "model" includes it in the reply so the client renders the inline player.
  if (text === defaultText) {
    const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const reqMessages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
    const allText = reqMessages
      .map((m) => {
        const c = (m as Record<string, unknown>).content;
        return typeof c === 'string' ? c : JSON.stringify(c ?? '');
      })
      .join('\n');
    const attMatch = allText.match(/\{\{attachment::[0-9a-fA-F-]+\}\}/);
    if (attMatch) text = attMatch[0];
  }

  text = applyStopStrings(text, body);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const id = `chatcmpl-${randomUUID()}`;
  const baseChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
  };

  // Tool call mode: `tool:name[json],name2[json2],...` — emit ONE tool call
  // per round, walking the sequence. The next tool is picked by counting tool
  // results already in history; when the sequence is exhausted, the "model"
  // answers with plain text. This models multi-tool sequences (call A, see
  // result, think, call B, …) instead of stopping after the first result.
  const toolSpecMatch = lastUserContent.match(/^tool:(.+)$/i);
  if (toolSpecMatch) {
    const sequence = parseToolSequence(toolSpecMatch[1]!);
    const reqMessages = Array.isArray((body as Record<string, unknown>)?.messages)
      ? ((body as Record<string, unknown>).messages as Record<string, unknown>[])
      : [];
    const resultCount = reqMessages.filter((m) => m?.role === 'tool').length;
    if (resultCount < sequence.length) {
      const tool = sequence[resultCount]!;
      const toolChunk = {
        ...baseChunk,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: tool.name, arguments: tool.args } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      writeSseChunk(res, toolChunk);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
  }

  // Reasoning / thinking mode: stream reasoning tokens, then text.
  if (lastUserContent.toLowerCase().startsWith('think:')) {
    const reasoningText = 'I am thinking through this carefully.';
    for (const token of reasoningText) {
      writeSseChunk(res, {
        ...baseChunk,
        choices: [{ index: 0, delta: { reasoning_content: token }, finish_reason: null }],
      });
    }
    const replyText = 'Here is my final answer.';
    for (const token of replyText) {
      writeSseChunk(res, {
        ...baseChunk,
        choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
      });
    }
    writeSseChunk(res, { ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Plain text mode.
  for (const token of text) {
    writeSseChunk(res, {
      ...baseChunk,
      choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
    });
    if (selector.delayMs > 0) await sleep(selector.delayMs);
  }

  writeSseChunk(res, { ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: selector.finish }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Anthropic Messages API (`POST /messages`): paired `event:`/`data:` SSE with
 * content blocks. Supports think: (thinking + signature deltas), tool:
 * (tool_use block with input_json_delta), the inject probe (scans system +
 * messages) and stop_sequences.
 */
async function sendClaudeMessages(res: http.ServerResponse, body: unknown, defaultText: string) {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const lastUserText = getClaudeLastUserText(body);

  const selector = resolveSelector(lastUserText, defaultText);
  let text = selector.text;

  // Injectable probe over system prompt + all message content.
  const probeTexts: string[] = [];
  collectText(reqBody.system, probeTexts);
  collectText(reqBody.messages, probeTexts);
  const injected = scanInjectablesInText(probeTexts.join('\n'));
  if (injected.length > 0) {
    text = `inject:${injected.join(',')}`;
  }

  text = cutAtStopStrings(text, getStopList(body, 'stop_sequences'));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const msgId = `msg_${randomUUID()}`;
  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: 'mock-claude',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 50, output_tokens: 1 },
    },
  });

  const finishMessage = (stopReason: string, outputTokens: number) => {
    writeSseEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    writeSseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
  };

  const streamTextBlock = async (index: number, content: string, delayMs: number) => {
    writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });
    for (const ch of content) {
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: ch },
      });
      if (delayMs > 0) await sleep(delayMs);
    }
    writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
  };

  // Reasoning mode: thinking block (thinking_delta + signature_delta), then text.
  if (lastUserText.toLowerCase().startsWith('think:')) {
    writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    });
    const reasoningText = 'I am thinking through this carefully.';
    for (const ch of reasoningText) {
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: ch },
      });
    }
    writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'mock-signature' },
    });
    writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });

    const replyText = 'Here is my final answer.';
    await streamTextBlock(1, replyText, 0);
    finishMessage('end_turn', replyText.length);
    return;
  }

  // Tool use mode: tool_use block with input_json_delta chunks. Walks the
  // sequence by counting tool_result blocks already in the history.
  const toolSpecMatch = lastUserText.match(/^tool:(.+)$/i);
  if (toolSpecMatch) {
    const sequence = parseToolSequence(toolSpecMatch[1]!);
    const messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
    let resultCount = 0;
    for (const m of messages) {
      const content = (m as Record<string, unknown>)?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if ((part as Record<string, unknown>)?.type === 'tool_result') resultCount += 1;
      }
    }
    if (resultCount < sequence.length) {
      const tool = sequence[resultCount]!;
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `toolu_${randomUUID()}`, name: tool.name, input: {} },
      });
      for (const ch of tool.args) {
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: ch },
        });
      }
      writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      finishMessage('tool_use', tool.args.length);
      return;
    }
  }

  // Plain text mode.
  await streamTextBlock(0, text, selector.delayMs);
  finishMessage(selector.finish === 'length' ? 'max_tokens' : 'end_turn', text.length);
}

/**
 * Google Gemini (`POST /models/{model}:streamGenerateContent?alt=sse&key=…`):
 * SSE chunks of {candidates:[{content:{parts:[…]}}]}, a final chunk carrying
 * finishReason + usageMetadata. Supports think: (thought parts), tool:
 * (functionCall part), the inject probe and generationConfig.stopSequences.
 */
async function sendGeminiStream(res: http.ServerResponse, body: unknown, defaultText: string) {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const lastUserText = getGeminiLastUserText(body);

  const selector = resolveSelector(lastUserText, defaultText);
  let text = selector.text;

  const probeTexts: string[] = [];
  collectText(reqBody.systemInstruction, probeTexts);
  collectText(reqBody.contents, probeTexts);
  const injected = scanInjectablesInText(probeTexts.join('\n'));
  if (injected.length > 0) {
    text = `inject:${injected.join(',')}`;
  }

  const genConfig = typeof reqBody.generationConfig === 'object' && reqBody.generationConfig !== null
    ? (reqBody.generationConfig as Record<string, unknown>)
    : {};
  text = cutAtStopStrings(text, getStopList(genConfig, 'stopSequences'));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const writeParts = (parts: unknown[]) => {
    writeSseChunk(res, { candidates: [{ content: { role: 'model', parts }, index: 0 }] });
  };
  const finish = (finishReason: string, outputTokens: number) => {
    writeSseChunk(res, {
      candidates: [{ index: 0, finishReason }],
      usageMetadata: {
        promptTokenCount: 50,
        candidatesTokenCount: outputTokens,
        totalTokenCount: 50 + outputTokens,
      },
    });
    res.end();
  };

  // Reasoning mode: thought parts first, then the plain answer.
  if (lastUserText.toLowerCase().startsWith('think:')) {
    const reasoningText = 'I am thinking through this carefully.';
    for (const ch of reasoningText) {
      writeParts([{ text: ch, thought: true }]);
    }
    const replyText = 'Here is my final answer.';
    for (const ch of replyText) {
      writeParts([{ text: ch }]);
    }
    finish('STOP', replyText.length);
    return;
  }

  // Tool mode: a single functionCall part. Walks the sequence by counting
  // functionResponse parts already in the history.
  const toolSpecMatch = lastUserText.match(/^tool:(.+)$/i);
  if (toolSpecMatch) {
    const sequence = parseToolSequence(toolSpecMatch[1]!);
    const contents = Array.isArray(reqBody.contents) ? reqBody.contents : [];
    let resultCount = 0;
    for (const c of contents) {
      const parts = (c as Record<string, unknown>)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if ((part as Record<string, unknown>)?.functionResponse) resultCount += 1;
      }
    }
    if (resultCount < sequence.length) {
      const tool = sequence[resultCount]!;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tool.args) as Record<string, unknown>;
      } catch {
        args = {};
      }
      writeParts([{ functionCall: { name: tool.name, args } }]);
      finish('STOP', tool.args.length);
      return;
    }
  }

  // Plain text mode: char-by-char parts.
  for (const ch of text) {
    writeParts([{ text: ch }]);
    if (selector.delayMs > 0) await sleep(selector.delayMs);
  }
  finish(selector.finish === 'length' ? 'MAX_TOKENS' : 'STOP', text.length);
}

/**
 * KoboldCpp (`POST /api/extra/generate/stream`): SSE {"token":"…"} per char,
 * a final {"token":"","finish_reason":"stop"|"length"}. The prompt is a flat
 * string, so selectors come from the line scan (like /completions).
 */
async function sendKoboldStream(res: http.ServerResponse, body: unknown, defaultText: string) {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const promptText = typeof reqBody.prompt === 'string' ? reqBody.prompt : '';

  const selector = selectorFromFlatPrompt(promptText, defaultText);
  let text = selector.text;

  const injected = scanInjectablesInText(promptText);
  if (injected.length > 0) {
    text = `inject:${injected.join(',')}`;
  }

  text = cutAtStopStrings(text, getStopList(body, 'stop_sequence'));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  for (const ch of text) {
    writeSseChunk(res, { token: ch });
    if (selector.delayMs > 0) await sleep(selector.delayMs);
  }
  writeSseChunk(res, { token: '', finish_reason: selector.finish });
  res.end();
}

/**
 * llama.cpp native (`POST /completion`): SSE {content, stop:false} deltas, a
 * final stop chunk with the stopped_* flags + token counts, then [DONE].
 * The length: selector maps to stopped_limit:true (instead of stopped_eos).
 */
async function sendLlamaCppCompletion(res: http.ServerResponse, body: unknown, defaultText: string) {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const promptText = typeof reqBody.prompt === 'string' ? reqBody.prompt : '';

  const selector = selectorFromFlatPrompt(promptText, defaultText);
  let text = selector.text;

  const injected = scanInjectablesInText(promptText);
  if (injected.length > 0) {
    text = `inject:${injected.join(',')}`;
  }

  text = cutAtStopStrings(text, getStopList(body, 'stop'));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  for (const ch of text) {
    writeSseChunk(res, { content: ch, stop: false });
    if (selector.delayMs > 0) await sleep(selector.delayMs);
  }
  const isLength = selector.finish === 'length';
  writeSseChunk(res, {
    content: '',
    stop: true,
    stopped_eos: !isLength,
    stopped_limit: isLength,
    stopped_word: false,
    tokens_evaluated: 50,
    tokens_predicted: text.length,
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

export function startMockLlmServer(options: MockLlmServerOptions = {}): Promise<MockLlmServer> {
  const port = options.port ?? 9876;
  const host = options.host ?? '127.0.0.1';
  const defaultText = options.defaultText ?? DEFAULT_RESPONSE;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (req.method === 'GET' && path === '/models') {
          // Anthropic callers authenticate with x-api-key; OpenAI callers send
          // Authorization — use that to pick the model-list shape.
          sendModels(res, req.headers['x-api-key'] !== undefined);
          return;
        }

        // Static markdown doc for hermetic "download over HTTP" test flows.
        if (req.method === 'GET' && path === '/sacred-scrolls.md') {
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
          res.end(SACRED_SCROLLS_MD);
          return;
        }

        // Test inspection: with ?route=<prefix>, the last captured POST whose
        // route starts with the prefix; without it, the legacy {count, body,
        // auth} capture for /chat/completions + /completions.
        if (req.method === 'GET' && path === '/last-request') {
          const routePrefix = url.searchParams.get('route');
          if (routePrefix !== null) {
            const found = capturedRequests
              .slice()
              .reverse()
              .find((r) => r.route.startsWith(routePrefix));
            sendJson(res, 200, found ?? null);
            return;
          }
          sendJson(res, 200, { count: completionCount, body: lastRequestBody, auth: lastRequestAuth });
          return;
        }

        // Test isolation: reset the captured request state between specs.
        if (req.method === 'POST' && path === '/__reset-requests') {
          completionCount = 0;
          lastRequestBody = null;
          lastRequestAuth = undefined;
          capturedRequests.length = 0;
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === 'POST') {
          // Generic capture: every POST route is recorded (JSON-parsed when
          // possible, raw text otherwise — e.g. Azure's SSML body).
          const raw = await readRawBody(req);
          const body = parseJson(raw);
          capturedRequests.push({ route: path, body, headers: { ...req.headers } });

          if (path === '/chat/completions') {
            console.error('[mockllm] completion request received');
            completionCount += 1;
            lastRequestBody = body;
            lastRequestAuth = req.headers['authorization'] as string | undefined;
            await sendCompletion(res, body, defaultText);
            return;
          }

          if (path === '/completions') {
            console.error('[mockllm] text-completion request received');
            completionCount += 1;
            lastRequestBody = body;
            lastRequestAuth = req.headers['authorization'] as string | undefined;
            await sendTextCompletion(res, body, defaultText);
            return;
          }

          // Anthropic Claude dialect.
          if (path === '/messages') {
            await sendClaudeMessages(res, body, defaultText);
            return;
          }

          // Google Gemini dialect (query string carries alt=sse&key=…).
          if (/^\/models\/[^/]+:streamGenerateContent$/.test(path)) {
            await sendGeminiStream(res, body, defaultText);
            return;
          }

          // KoboldCpp dialect.
          if (path === '/api/extra/generate/stream') {
            await sendKoboldStream(res, body, defaultText);
            return;
          }
          if (path === '/api/extra/abort') {
            sendJson(res, 200, { ok: true });
            return;
          }

          // llama.cpp native dialect.
          if (path === '/completion') {
            await sendLlamaCppCompletion(res, body, defaultText);
            return;
          }

          if (path === '/embeddings') {
            sendEmbeddings(res, body);
            return;
          }

          // TTS dialects — raw WAV unless noted otherwise.
          if (path === '/audio/speech' || path === '/v1/audio/speech') {
            sendSpeech(res);
            return;
          }
          if (path.startsWith('/v1/text-to-speech/')) {
            sendSpeech(res);
            return;
          }
          if (path === '/cognitiveservices/v1') {
            sendSpeech(res);
            return;
          }
          if (path === '/v1/t2a_v2') {
            // MiniMax: hex-encoded audio inside a JSON envelope.
            sendJson(res, 200, {
              data: { audio: tinyWav().toString('hex'), status: 2 },
              base_resp: { status_code: 0, status_msg: 'success' },
            });
            return;
          }
          if (path === '/api/v1/tts') {
            // VolcEngine: base64-encoded audio inside a JSON envelope.
            sendJson(res, 200, { code: 3000, message: 'Success', data: tinyWav().toString('base64') });
            return;
          }
          if (path === '/tts') {
            sendSpeech(res);
            return;
          }
          if (path === '/voice/vits') {
            sendSpeech(res);
            return;
          }
          if (path === '/tts/generate') {
            sendSpeech(res);
            return;
          }

          // Stable Diffusion image generation: a small valid 1x1 PNG.
          if (path === '/sdapi/v1/txt2img') {
            sendJson(res, 200, { images: [tinyPng().toString('base64')], parameters: {}, info: '' });
            return;
          }
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err instanceof Error ? err.message : 'Internal error');
      }
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      resolve({
        url: `http://${host}:${port}`,
        stop: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
