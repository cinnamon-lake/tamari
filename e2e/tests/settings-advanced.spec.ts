/**
 * Settings — Advanced: the sections of the Settings modal not covered by
 * settings.spec.ts / settings-display.spec.ts / settings-behavior.spec.ts:
 *
 *   1. Custom instruct template CRUD (list, edit form, save, delete confirm) —
 *      in the sidebar's Instruct Templates modal (.instruct-templates-modal).
 *   2. Global regex rules CRUD + the Test input/output area — the ONLY client
 *      code path over client/src/lib/regexDisplay.ts (applyDisplayRules /
 *      parseRegexString), in the sidebar's Regex Rules modal
 *      (.regex-rules-modal). Bonus: a Display rule transforms the rendered
 *      assistant bubble (server DisplayRenderer applies the global rule).
 *   3. Regex rule validation alerts (alertPopup for empty name / bad format /
 *      uncompilable pattern).
 *   4. Stop-string row editing: TYPE a stop string (settings.spec.ts only
 *      adds/removes empty rows) and prove the mock backend cuts the reply at
 *      it (the mock honors the OpenAI `stop` param).
 *   5. Generation knobs with wire assertions against the captured mock
 *      request: stripExamples (PromptBuilder drops mesExample),
 *      customStoppingStringsMacro (GenerationService.resolveStopStrings
 *      macro-resolves stop strings). Plus the chat-messages-per-page UI
 *      round-trip (display-only render limit).
 *   6. Claude prompt caching selects/inputs — per-backend-config
 *      providerParams (cacheMode/cacheDepth/cacheTTL) in the Backend Config
 *      modal; UI persistence only (functional wire assertions live in the
 *      claude/openrouter specs).
 *   7. Auto-continue toggle + target length — UI persistence only.
 *
 * Everything created here is cleaned up: templates/rules are deleted through
 * the UI, and touched settings are reset to their schema defaults in
 * afterEach (belt-and-braces purge in case a test fails mid-way).
 */
import { smokeTest as test, expect } from '../fixtures/smoke.js';
import type { Locator, Page } from '../fixtures/base.js';
import { setSetting } from '../helpers/settings.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';
import { uniqueName as baseUniqueName } from '../helpers/names.js';

/** Marker prefix for everything this spec creates — used by the afterEach purge. */
const MARK = 'E2EAdv';

function uniqueName(base: string): string {
  return baseUniqueName(`${MARK} ${base}`);
}

/** Idempotently set a checkbox inside the open settings modal by its testid. */
async function setCheckbox(modal: Locator, testId: string, desired: boolean): Promise<void> {
  const checkbox = modal.getByTestId(testId);
  if ((await checkbox.isChecked()) !== desired) {
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: desired });
  }
}

/**
 * Remove any regex rules / instruct templates this spec may have left behind
 * (identified by the MARK prefix) and restore the scalar settings it touches
 * to their schema defaults. Runs over the WS bus so it works even when a test
 * failed with the modal open.
 */
async function purgeSpecArtifacts(page: Page): Promise<void> {
  await page.evaluate((mark) => {
    return new Promise<void>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      const sends: Array<[string, unknown]> = [];

      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            // Local const: assigning the `any` from JSON.parse into a `| null`
            // variable doesn't narrow it for the property reads below.
            const settings = (msg.state?.settings ?? {}) as Record<string, unknown>;
            const rules = Array.isArray(settings['regexRules'])
              ? (settings['regexRules'] as Array<{ name?: string }>)
              : [];
            const keptRules = rules.filter((r) => !(r?.name ?? '').includes(mark));
            if (keptRules.length !== rules.length) sends.push(['regexRules', keptRules]);
            const tpls = Array.isArray(settings['instructTemplates'])
              ? (settings['instructTemplates'] as Array<{ name?: string }>)
              : [];
            const keptTpls = tpls.filter((t) => !(t?.name ?? '').includes(mark));
            if (keptTpls.length !== tpls.length) sends.push(['instructTemplates', keptTpls]);
            const scalars: Array<[string, unknown]> = [
              ['chatMessageLoadLimit', 30],
              ['stripExamples', false],
              ['customStoppingStrings', []],
              ['customStoppingStringsMacro', false],
              ['autoContinueEnabled', false],
              ['autoContinueTargetLength', 100],
            ];
            for (const [key, def] of scalars) {
              if (JSON.stringify(settings[key]) !== JSON.stringify(def)) sends.push([key, def]);
            }
            if (sends.length === 0) {
              ws.close();
              resolve();
              return;
            }
            // Send one at a time, waiting for each settings.changed — the same
            // ack discipline as helpers/settings.ts, avoiding any coalescing
            // assumptions when several keys change at once.
            const [key, value] = sends[0]!;
            ws.send(JSON.stringify({ type: 'settings.set', key, value }));
            return;
          }
          if (msg.type === 'settings.changed') {
            if (sends.length > 0 && sends[0]![0] === msg.key) {
              sends.shift();
              if (sends.length === 0) {
                ws.close();
                resolve();
              } else {
                const [key, value] = sends[0]!;
                ws.send(JSON.stringify({ type: 'settings.set', key, value }));
              }
            }
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'purge settings.set failed'));
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      ws.onerror = (err) => reject(new Error(`WebSocket error: ${err.type}`));
      setTimeout(() => {
        ws.close();
        reject(new Error('purgeSpecArtifacts timed out'));
      }, 15000);
    });
  }, MARK);
}

/** Stringified messages array of a captured mock-LLM request body. */
function requestText(body: unknown): string {
  const messages = (body as { messages?: unknown[] })?.messages ?? [];
  return JSON.stringify(messages);
}

/** `stop` array of a captured mock-LLM request body (OpenAI wire shape). */
function requestStop(body: unknown): string[] {
  const stop = (body as { stop?: unknown })?.stop;
  return Array.isArray(stop) ? stop.map(String) : [];
}

/** Sidebar "Instruct Templates" button → .instruct-templates-modal. */
async function openInstructTemplates(page: Page): Promise<Locator> {
  await page.getByTestId('open-instruct-templates').click();
  const modal = page.locator('.instruct-templates-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function closeInstructTemplates(page: Page): Promise<void> {
  const modal = page.locator('.instruct-templates-modal');
  await page.locator('.modal-overlay:has(.instruct-templates-modal)').click({ position: { x: 0, y: 0 } });
  await expect(modal).not.toBeVisible();
}

/** Sidebar "Regex Rules" button → .regex-rules-modal. */
async function openRegexRules(page: Page): Promise<Locator> {
  await page.getByTestId('open-regex-rules').click();
  const modal = page.locator('.regex-rules-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function closeRegexRules(page: Page): Promise<void> {
  const modal = page.locator('.regex-rules-modal');
  await page.locator('.modal-overlay:has(.regex-rules-modal)').click({ position: { x: 0, y: 0 } });
  await expect(modal).not.toBeVisible();
}

/** Sidebar "Backend Config" button → the Backend Config modal. */
async function openBackendConfig(page: Page): Promise<Locator> {
  const btn = page.getByTestId('open-backend-config');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.getByTestId('backend-config-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function closeBackendConfig(modal: Locator): Promise<void> {
  // The Close button runs the modal's close(): a dirty form is saved first.
  await modal.getByTestId('backend-config-close').click();
  await expect(modal).not.toBeVisible();
}

test.describe('Settings — Advanced', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async ({ page }) => {
    await purgeSpecArtifacts(page);
  });

  test('instruct template CRUD: create, edit, persist across reopen, delete', async ({ page, app: _app }) => {
    test.setTimeout(90000);
    const stamp = Date.now();
    const tplId = `${MARK.toLowerCase()}-tpl-${stamp}`;
    const tplName = uniqueName('Tpl');
    const sysPrefix = `SYSMARK-${stamp}`;
    const userPrefix = `USERMARK-${stamp}`;

    const modal = await openInstructTemplates(page);

    // New Template → fill the form with distinctive markers → save.
    await modal.getByTestId('instruct-template-new').click();
    await modal.getByTestId('instruct-template-id').fill(tplId);
    await modal.getByTestId('instruct-template-name').fill(tplName);
    await modal.getByTestId('instruct-template-system-prefix').fill(sysPrefix);
    await modal.getByTestId('instruct-template-user-prefix').fill(userPrefix);
    await modal.getByTestId('instruct-template-save').click();

    // Appears in the list with its id.
    const row = modal.locator(`.worldinfo-item[id="${tplId}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('.worldinfo-name')).toHaveText(tplName);
    await expect(row.locator('.worldinfo-meta')).toContainText(`ID: ${tplId}`);

    // Edit → change a field → save.
    await row.getByTestId('instruct-template-edit').click();
    const editedSysPrefix = `${sysPrefix}-EDITED`;
    await modal.getByTestId('instruct-template-system-prefix').fill(editedSysPrefix);
    await modal.getByTestId('instruct-template-save').click();
    await expect(row).toBeVisible();

    // Persists after modal close/reopen (round-tripped to the server).
    await closeInstructTemplates(page);
    const modal2 = await openInstructTemplates(page);
    const row2 = modal2.locator(`.worldinfo-item[id="${tplId}"]`);
    await expect(row2).toBeVisible();
    await row2.getByTestId('instruct-template-edit').click();
    await expect(modal2.getByTestId('instruct-template-system-prefix')).toHaveValue(editedSysPrefix);
    await expect(modal2.getByTestId('instruct-template-user-prefix')).toHaveValue(userPrefix);
    await modal2.getByTestId('instruct-template-cancel').click();

    // Delete → confirm popup → gone.
    await row2.getByTestId('instruct-template-delete').click();
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.popup-message')).toHaveText('Delete this custom template?');
    await popup.getByTestId('popup-confirm').click();
    await expect(popup).not.toBeVisible();
    await expect(modal2.locator(`.worldinfo-item[id="${tplId}"]`)).toHaveCount(0);

    await closeInstructTemplates(page);
  });

  test('global regex rule CRUD, Test area transform, and display-rule bubble transform', async ({ page, app }) => {
    test.setTimeout(120000);
    const charName = uniqueName('Regex Char');
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello from ${charName}.` });

    const ruleName = uniqueName('Rule');
    const modal = await openRegexRules(page);

    // New Regex Rule → fill name/find/replace → tick Display placement.
    await modal.getByTestId('regex-rule-new').click();
    await modal.getByTestId('regex-rule-name').fill(ruleName);
    await modal.getByTestId('regex-rule-find').fill('/deterministic/g');
    await modal.getByTestId('regex-rule-replace').fill('DETERMINISTIC');
    const displayCheckbox = modal.getByTestId('regex-rule-display');
    await displayCheckbox.click();
    await expect(displayCheckbox).toBeChecked();

    // Test area: typing in Test Input transforms via applyDisplayRules
    // (client/src/lib/regexDisplay.ts) into the read-only Test Output.
    await modal.getByTestId('regex-test-input').fill('a deterministic reply');
    await expect(modal.getByTestId('regex-test-output')).toHaveValue('a DETERMINISTIC reply');

    // Save Rule → row appears in the list.
    await modal.getByTestId('regex-rule-save').click();
    const row = modal.locator('.worldinfo-item', { hasText: ruleName });
    await expect(row).toBeVisible();
    await expect(row.locator('.worldinfo-meta').first()).toContainText('/deterministic/g → DETERMINISTIC');

    // Edit → change the replacement → meta updates.
    await row.getByTestId('regex-rule-edit').click();
    await modal.getByTestId('regex-rule-replace').fill('DETERMINISTIC!');
    await modal.getByTestId('regex-rule-save').click();
    await expect(row.locator('.worldinfo-meta').first()).toContainText('/deterministic/g → DETERMINISTIC!');

    // Bonus: with the Display rule active, a generated reply renders
    // transformed in the assistant bubble (server DisplayRenderer).
    await closeRegexRules(page);
    await app.sendUserMessage('respond:this is deterministic text', { expectReply: true });
    await app.waitForAssistantText('this is DETERMINISTIC! text');

    // Cleanup: delete the rule through the UI.
    const modal2 = await openRegexRules(page);
    const row2 = modal2.locator('.worldinfo-item', { hasText: ruleName });
    await expect(row2).toBeVisible();
    await row2.getByTestId('regex-rule-delete').click();
    const popup = page.locator('.popup-modal');
    await expect(popup.locator('.popup-message')).toHaveText('Delete this regex rule?');
    await popup.getByTestId('popup-confirm').click();
    await expect(popup).not.toBeVisible();
    await expect(modal2.locator('.worldinfo-item', { hasText: ruleName })).toHaveCount(0);

    await closeRegexRules(page);
  });

  test('regex rule validation alerts on empty name and bad find regex', async ({ page, app: _app }) => {
    const modal = await openRegexRules(page);

    await modal.getByTestId('regex-rule-new').click();
    const popup = page.locator('.popup-modal');

    // Empty name → "Rule name is required".
    await modal.getByTestId('regex-rule-save').click();
    await expect(popup.locator('.popup-message')).toHaveText('Rule name is required');
    await popup.getByTestId('popup-confirm').click();
    await expect(popup).not.toBeVisible();

    // Find regex not in /pattern/flags format → invalidFormat alert.
    await modal.getByTestId('regex-rule-name').fill(uniqueName('Invalid'));
    await modal.getByTestId('regex-rule-find').fill('not-a-regex');
    await modal.getByTestId('regex-rule-save').click();
    await expect(popup.locator('.popup-message')).toHaveText('Regex must be in /pattern/flags format');
    await popup.getByTestId('popup-confirm').click();
    await expect(popup).not.toBeVisible();

    // Correct format but uncompilable pattern → invalidPattern alert.
    await modal.getByTestId('regex-rule-find').fill('/[/g');
    await modal.getByTestId('regex-rule-save').click();
    await expect(popup.locator('.popup-message')).toHaveText('Invalid regex pattern');
    await popup.getByTestId('popup-confirm').click();
    await expect(popup).not.toBeVisible();

    // Cancel: nothing was saved.
    await modal.getByTestId('regex-rule-cancel').click();
    await expect(modal.locator('.worldinfo-item', { hasText: MARK })).toHaveCount(0);

    await closeRegexRules(page);
  });

  test('stop-string row editing cuts the reply at the typed stop string', async ({ page, app }) => {
    test.setTimeout(90000);
    const charName = uniqueName('Stop Char');
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello from ${charName}.` });

    const stopToken = `STOPHERE${Date.now()}`;

    // Add a row and TYPE the stop string into it (settings.spec.ts only
    // adds/removes empty rows). Cleanup goes through setSetting afterwards,
    // avoiding the stale remove-button handle noted there.
    const modal = await app.openSettings();
    await modal.getByTestId('settings-section-generation').scrollIntoViewIfNeeded();
    await modal.getByTestId('add-stop-string').click();
    // `.last()` = the row just appended.
    const stopInput = modal.getByTestId('stop-string-input').last();
    await stopInput.fill(stopToken);
    await expect(stopInput).toHaveValue(stopToken);
    await app.closeSettings();

    // The mock honors the OpenAI `stop` param: the reply is cut at the token.
    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage(`respond:keep this ${stopToken} drop this`, { expectReply: true });
    expect(await app.lastAssistantText()).toBe('keep this');
    const captured = await waitForNextLlmRequest(before);
    expect(requestStop(captured.body)).toContain(stopToken);

    await setSetting(page, 'customStoppingStrings', []);
  });

  test('generation knobs: stripExamples, stop-string macros on the wire', async ({ page, app }) => {
    test.setTimeout(180000);
    const charName = uniqueName('Knob Char');
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello from ${charName}.` });

    // Example dialogue with a distinctive sentinel (set via WS like
    // example-dialogue.spec.ts — the server-side field the pipeline reads).
    await page.evaluate(
      ({ name }) =>
        new Promise<void>((resolve, reject) => {
          const token = localStorage.getItem('st_auth_token') ?? '';
          const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'snapshot') {
              const char = (msg.state?.characters ?? []).find((c: { name: string }) => c.name === name);
              if (!char) {
                ws.close();
                reject(new Error('character not found'));
                return;
              }
              ws.send(
                JSON.stringify({
                  type: 'character.update',
                  characterId: char.id,
                  patch: { mesExample: '<START>\nUser: Example question\nChar: EXAMPLEDLG_SENTINEL reply' },
                }),
              );
            }
            if (msg.type === 'character.updated') {
              ws.close();
              resolve();
            }
            if (msg.type === 'error') {
              ws.close();
              reject(new Error(msg.message));
            }
          };
          setTimeout(() => {
            ws.close();
            reject(new Error('patchCharacter timeout'));
          }, 10000);
        }),
      { name: charName },
    );

    // ── stripExamples ─────────────────────────────────────────────────────
    // PromptBuilder drops mesExample entirely when stripExamples is set.
    await app.sendUserMessage('seq:alpha-one', { expectReply: true });
    let before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('seq:alpha-two', { expectReply: true });
    let captured = await waitForNextLlmRequest(before);
    expect(requestText(captured.body)).toContain('EXAMPLEDLG_SENTINEL');
    await app.ensureSetting('Strip dialogue examples from prompt', true);
    before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('seq:alpha-five', { expectReply: true });
    captured = await waitForNextLlmRequest(before);
    expect(requestText(captured.body)).not.toContain('EXAMPLEDLG_SENTINEL');
    await app.ensureSetting('Strip dialogue examples from prompt', false);

    // ── customStoppingStringsMacro ────────────────────────────────────────
    // resolveStopStrings macro-resolves {{char}} in custom stop strings only
    // when the toggle is on; otherwise the literal macro is sent.
    await setSetting(page, 'customStoppingStrings', ['{{char}}ENDTOKEN']);
    before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('seq:alpha-six', { expectReply: true });
    captured = await waitForNextLlmRequest(before);
    expect(requestStop(captured.body)).toContain('{{char}}ENDTOKEN');

    await app.ensureSetting('Resolve macros in custom stopping strings', true);
    before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('seq:alpha-seven', { expectReply: true });
    captured = await waitForNextLlmRequest(before);
    expect(requestStop(captured.body)).toContain(`${charName}ENDTOKEN`);
    expect(requestStop(captured.body)).not.toContain('{{char}}ENDTOKEN');

    await app.ensureSetting('Resolve macros in custom stopping strings', false);
    await setSetting(page, 'customStoppingStrings', []);

    // Reopen the modal once to prove the messages-per-page setting round-trips.
    // (Display-only render limit — it never touches the prompt.)
    await setSetting(page, 'chatMessageLoadLimit', 42);
    const modal = await app.openSettings();
    await modal.getByTestId('settings-section-generation').scrollIntoViewIfNeeded();
    const loadLimitInput = modal.getByTestId('setting-chatMessageLoadLimit');
    await expect(loadLimitInput).toHaveValue('42');
    await app.closeSettings();
    await setSetting(page, 'chatMessageLoadLimit', 30);
  });

  test('claude cache mode, manual depth and TTL persist across reopen', async ({ page, app: _app }) => {
    // The caching controls live in the Backend Config modal (per-config
    // providerParams) and only render for claude/openrouter providers —
    // switch the provider first so the section appears.
    const modal = await openBackendConfig(page);
    const providerSelect = modal.getByTestId('backend-config-provider');
    await providerSelect.selectOption('claude');

    // Functional wire assertions for Claude caching live in the claude /
    // openrouter specs — here we only verify the UI round-trips.
    const modeSelect = modal.getByTestId('backend-config-cache-mode');
    await modeSelect.selectOption('manual');
    await expect(modeSelect).toHaveValue('manual');

    // The depth input only renders in manual mode.
    const depthInput = modal.getByTestId('backend-config-cache-depth');
    await expect(depthInput).toBeVisible();
    await depthInput.fill('3');
    await expect(depthInput).toHaveValue('3');

    // Cache TTL is a free-text input (e.g. "5m", "1h"), not a select.
    const ttlInput = modal.getByTestId('backend-config-cache-ttl');
    await ttlInput.fill('1h');
    await expect(ttlInput).toHaveValue('1h');

    // Close runs the modal's close(): the dirty form is saved first.
    await closeBackendConfig(modal);

    const modal2 = await openBackendConfig(page);
    await expect(modal2.getByTestId('backend-config-cache-mode')).toHaveValue('manual');
    await expect(modal2.getByTestId('backend-config-cache-depth')).toHaveValue('3');
    await expect(modal2.getByTestId('backend-config-cache-ttl')).toHaveValue('1h');

    // Restore defaults (off hides the depth input; TTL blank => null). The
    // provider itself is reset by the smokeTest fixture's backend-config reset.
    await modal2.getByTestId('backend-config-cache-ttl').fill('');
    await modal2.getByTestId('backend-config-cache-mode').selectOption('off');
    await expect(modal2.getByTestId('backend-config-cache-depth')).toHaveCount(0);
    await closeBackendConfig(modal2);
  });

  test('auto-continue toggle and target length persist across reopen', async ({ app }) => {
    const modal = await app.openSettings();
    await modal.getByTestId('settings-section-generation').scrollIntoViewIfNeeded();

    // The functional auto-continue behavior is covered elsewhere — UI only.
    await setCheckbox(modal, 'setting-autoContinueEnabled', true);
    const targetInput = modal.getByTestId('setting-autoContinueTargetLength');
    await expect(targetInput).toBeVisible();
    await targetInput.fill('150');
    await expect(targetInput).toHaveValue('150');
    await app.closeSettings();

    const modal2 = await app.openSettings();
    await modal2.getByTestId('settings-section-generation').scrollIntoViewIfNeeded();
    await expect(modal2.getByTestId('setting-autoContinueEnabled')).toBeChecked();
    await expect(modal2.getByTestId('setting-autoContinueTargetLength')).toHaveValue('150');

    // Restore defaults.
    await modal2.getByTestId('setting-autoContinueTargetLength').fill('100');
    await setCheckbox(modal2, 'setting-autoContinueEnabled', false);
    await expect(modal2.getByTestId('setting-autoContinueTargetLength')).toHaveCount(0);
    await app.closeSettings();
  });
});
