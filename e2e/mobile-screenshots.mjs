/**
 * Mobile screenshot tour of the main tamari surfaces.
 *
 * Standalone script (not a playwright test): starts a fresh server + a tiny
 * mock LLM, drives a mobile-viewport browser through the main pages/modals,
 * and writes PNGs to e2e/test-results/mobile-screenshots/.
 *
 * Usage:  node e2e/mobile-screenshots.mjs [--suffix NAME]
 *
 * Requires server/dist + client/dist to be built (the server serves the
 * built client, so rebuild the client after changing client/src).
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const suffixArg = process.argv.includes('--suffix')
  ? process.argv[process.argv.indexOf('--suffix') + 1]
  : '';
const outDir = path.join(__dirname, 'test-results', `mobile-screenshots${suffixArg ? `-${suffixArg}` : ''}`);
const PORT = 8910;
const MOCK_PORT = 9877;
const SECRET = 'e2e-test-secret';
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = path.join(repoRoot, 'server', '.mobile-audit-data');

fs.mkdirSync(outDir, { recursive: true });

// ── tiny mock LLM (OpenAI-compatible, SSE streaming) ──────────────────────
const REPLY =
  'Ah, welcome, traveler! *She gestures toward the crackling hearth, flames painting amber across her silvered cloak.* ' +
  'It is not often that someone braves the Thornwood road this late in the season. Come — sit, warm yourself, and tell me what tidings you carry from the lowlands.';

function startMockLlm() {
  const server = http.createServer((req, res) => {
    console.log(`[mock] ${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let stream = true;
        try {
          stream = JSON.parse(body).stream !== false;
        } catch { /* default stream */ }
        if (!stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 0,
            choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const words = REPLY.split(' ');
        let i = 0;
        const timer = setInterval(() => {
          if (i >= words.length) {
            clearInterval(timer);
            res.write(`data: ${JSON.stringify({
              id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          const content = words.slice(i, (i += 6)).join(' ') + ' ';
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`);
        }, 15);
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

// ── ST server lifecycle ────────────────────────────────────────────────────
function startServer() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const proc = spawn('node', ['dist/main.js'], {
    cwd: path.join(repoRoot, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      TAMARI_SECRET: SECRET,
      LOG_LEVEL: 'debug',
      DISABLE_CSRF: 'true',
    },
    stdio: 'pipe',
  });
  proc.stdout.on('data', (d) => process.stderr.write(`[server] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return proc;
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE);
      if (res.status === 200 || res.status === 401 || res.status === 403) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

// ── main tour ──────────────────────────────────────────────────────────────
const shots = [];
async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  console.log(`shot: ${name}.png`);
}

async function configureMockBackend(page) {
  await page.evaluate((mockUrl) => {
    return new Promise((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      const data = {
        name: 'Mock',
        description: '',
        backendProvider: 'openai',
        generationMode: 'chat',
        model: 'mock-model',
        apiUrl: mockUrl,
        apiKey: 'mock-api-key',
      };
      let phase = 'patch';
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'snapshot') {
          const existing =
            msg.state?.settings?.activeBackendConfigId ??
            msg.state?.backendConfigs?.[0]?.id;
          if (existing) {
            ws.send(JSON.stringify({ type: 'backendConfig.update', backendConfigId: existing, patch: data }));
          } else {
            // Fresh server: no configs at all — create one, then activate it.
            phase = 'create';
            ws.send(JSON.stringify({ type: 'backendConfig.create', data }));
          }
        }
        if (msg.type === 'backendConfig.created') {
          const id = msg.backendConfig.id;
          phase = 'select';
          ws.send(JSON.stringify({ type: 'settings.set', key: 'activeBackendConfigId', value: id }));
          ws.send(JSON.stringify({ type: 'backendConfig.select', backendConfigId: id }));
        }
        if (
          msg.type === 'backendConfig.updated' ||
          (msg.type === 'backendConfig.snapshot' && phase === 'select')
        ) {
          ws.close(); resolve();
        }
        if (msg.type === 'error') {
          ws.close(); reject(new Error(msg.message ?? 'backendConfig error'));
        }
      };
      ws.onerror = () => reject(new Error('ws error'));
      setTimeout(() => { ws.close(); reject(new Error('backend config timed out')); }, 10000);
    });
  }, `http://127.0.0.1:${MOCK_PORT}`);
}

async function sendAndWaitReply(page, text) {
  const before = await page.locator('.message-bubble.assistant').count();
  await page.locator('.message-textarea').fill(text);
  await page.locator('.message-input-area .send-btn').click();
  await page.locator('.message-bubble.assistant').nth(before).waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForFunction(
    () => {
      const bubbles = [...document.querySelectorAll('.message-bubble.assistant .message-content')];
      return bubbles.length > 0 && bubbles[bubbles.length - 1].textContent.trim().length > 0;
    },
    { timeout: 20000 },
  );
  await page.locator('.message-bubble.streaming').waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`STEP FAILED: ${name}: ${err.message}`);
  }
}

const mockLlm = await startMockLlm();
const server = startServer();
await waitForServer();

const browser = await chromium.launch({
  executablePath: '/run/current-system/sw/bin/chromium-browser',
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

try {
  // 01 — auth
  await page.goto(BASE);
  await page.locator('[data-testid="auth-input"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(500);
  await shot(page, '01-auth');

  // login
  await page.locator('[data-testid="auth-input"]').fill(SECRET);
  await page.locator('[data-testid="auth-submit"]').click();
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(500);
  await shot(page, '02-app-empty');

  // 03 — sidebar drawer
  await step('sidebar', async () => {
    await page.locator('.mobile-menu-btn').click();
    await page.waitForTimeout(400);
    await shot(page, '03-sidebar');
  });

  // 04 — character editor
  await step('character editor', async () => {
    await page.locator('[title="Create character"]').click();
    const editor = page.locator('.character-editor-modal');
    await editor.waitFor({ state: 'visible' });
    await editor.locator('.text-input').first().fill('Seraphina Vale');
    await editor.locator('.textarea-input').nth(0).fill(
      'A wandering cartographer-mage who charts the borderlands between the mortal realm and the Feywild. ' +
      'Speaks softly, carries a silvered compass that points toward whatever the holder most desires, and never sleeps under the same stars twice.',
    );
    await editor.locator('.textarea-input').nth(3).fill(
      '*The tavern door creaks open, and a figure in a travel-worn cloak shakes the rain from her hood. ' +
      'Her eyes — violet, flecked with gold — find yours across the room.* You look lost, stranger. Most who come through the Thornwood do. I\'m Seraphina. Can I buy you a drink?',
    );
    await editor.locator('.save-indicator').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(600);
    await shot(page, '04-character-editor');
    await editor.locator('[title="Close"]').click();
    await editor.waitFor({ state: 'detached' });
  });

  // start chat
  await step('start chat', async () => {
    const search = page.locator('input[placeholder="Search characters..."]');
    if (!(await search.isVisible().catch(() => false))) {
      await page.locator('.mobile-menu-btn').click();
      await page.waitForTimeout(400);
    }
    await search.fill('Seraphina');
    const row = page.locator('.character-list li', { hasText: 'Seraphina Vale' });
    await row.waitFor({ state: 'visible' });
    await row.locator('[title="New chat"]').click({ force: true });
    await page.locator('.chat-view').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.message-bubble').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(500);
  });

  await configureMockBackend(page)
    .then(() => console.log('backend configured OK'))
    .catch((e) => console.error('backend config failed:', e.message));

  // 05 — chat with conversation
  await step('chat conversation', async () => {
    await sendAndWaitReply(page, 'Hi Seraphina! I\'m not lost, exactly — I\'m looking for the old observatory north of the river. Do you know it?');
    await sendAndWaitReply(page, 'That sounds dangerous. Is the road safe to travel at night?');
    await shot(page, '05-chat');
  });

  // 06 — chat header menu
  await step('chat header menu', async () => {
    await page.locator('.chat-header button[title="Menu"]').click();
    await page.waitForTimeout(300);
    await shot(page, '06-chat-header-menu');
    await page.keyboard.press('Escape');
    await page.locator('.chat-header .dropdown-menu').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  });

  // 07 — message actions / editing
  await step('message actions', async () => {
    const msg = page.locator('.message-bubble.assistant').last();
    await msg.scrollIntoViewIfNeeded();
    await msg.tap();
    await page.waitForTimeout(300);
    await shot(page, '07-message-actions');
  });

  // ── modals from the sidebar footer ──────────────────────────────────────
  const modals = [
    ['Personas', '08-personas', '.persona-modal'],
    ['World Info', '09-world-info', '.worldinfo-modal'],
    ['Stats', '10-stats', '.stats-modal'],
    ['Backend Config', '11-backend-config', '.modal.settings-modal'],
    ['Secrets', '12-secrets', '.modal.settings-modal'],
    ['Prompt List', '13-prompt-list', '.modal.settings-modal'],
    ['Tools', '14-tools', '.tools-modal'],
    ['Settings', '15-settings', '.settings-modal'],
  ];
  for (const [label, name, selector] of modals) {
    await step(`modal ${label}`, async () => {
      await page.locator('.mobile-menu-btn').click();
      await page.waitForTimeout(400);
      const btn = page.locator('button.settings-btn', { hasText: label });
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await page.locator(selector).first().waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(500);
      await shot(page, name);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    });
  }

  // 16 — new group chat popup
  await step('group chat popup', async () => {
    await page.locator('.mobile-menu-btn').click();
    await page.waitForTimeout(400);
    await page.locator('[title="New group chat"]').click();
    const popup = page.locator('.popup-modal');
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
    await shot(page, '16-group-chat-popup');
    await popup.locator('button:has-text("Cancel")').click();
    await popup.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
    // Close the drawer again so later steps see the chat view.
    await page.locator('.mobile-close.icon-btn').click().catch(() => {});
    await page.waitForTimeout(400);
  });

  // 17 — message input focused (long text)
  await step('message input', async () => {
    await page.locator('.message-textarea').tap();
    await page.locator('.message-textarea').fill('This is a longer draft message to show how the input area wraps and grows on a narrow mobile screen when the user types multiple lines of text.');
    await page.waitForTimeout(300);
    await shot(page, '17-message-input-draft');
  });
} finally {
  await browser.close();
  server.kill('SIGTERM');
  mockLlm.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\nDone. ${shots.length} screenshots in ${outDir}`);
