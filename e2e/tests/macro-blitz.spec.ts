import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** The whole captured request body as one searchable string. */
function bodyString(captured: { body: unknown }): string {
  return JSON.stringify(captured.body);
}

test.describe('Macro Blitz', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('blocks ({%if}/{%unless}/{%for}) and the {{?}} boolean evaluator resolve', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Block Char');
    await app.createCharacterAndChat({
      name: charName,
      description: [
        `{%if {{equal::{{char}}::${charName}}}%}IFYES{%else%}IFNO{%endif%}`,
        `{%unless {{equal::{{char}}::someone-else}}%}UNLESSYES{%else%}UNLESSNO{%endunless%}`,
        `{%for thing::alpha::beta%}[{{thing}}-{{forIndex}}]{%endfor%}`,
        `Q=[{{? {{equal::a::a}} && {{equal::b::b}} || {{equal::x::y}}}}]`,
        `F=[{{? {{equal::a::b}} && {{equal::a::a}}}}]`,
      ].join('\n'),
      firstMes: 'Ready.',
    });

    await app.sendUserMessage('hello', { expectReply: true });
    const all = bodyString(await getLastLlmRequest());

    // if: condition resolved truthy -> first branch only.
    expect(all).toContain('IFYES');
    expect(all).not.toContain('IFNO');
    // unless: condition resolved falsy -> first branch only.
    expect(all).toContain('UNLESSYES');
    expect(all).not.toContain('UNLESSNO');
    // for: one iteration per item, loop var + forIndex substituted.
    expect(all).toContain('[alpha-0][beta-1]');
    // {{?}} evaluator: && binds tighter than ||, falsy expression -> empty.
    expect(all).toContain('Q=[true]');
    expect(all).toContain('F=[]');
    // No directive or macro residue survives.
    expect(all).not.toContain('{%if');
    expect(all).not.toContain('{%unless');
    expect(all).not.toContain('{%for');
    expect(all).not.toContain('{{equal');
    expect(all).not.toContain('{{thing}}');
    expect(all).not.toContain('{{forIndex}}');
  });

  test('time/date macros resolve to the current UTC clock values', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({
      name: uniqueName('Date Char'),
      description: 'ISO=[{{isodate}}] DATE=[{{date}}] WD=[{{weekday}}] DTF=[{{datetimeformat::YYYY/MM/DD}}] TM=[{{time}}]',
      firstMes: 'Ready.',
    });

    await app.sendUserMessage('hello', { expectReply: true });
    const all = bodyString(await getLastLlmRequest());

    // The server resolves against new Date() in UTC; same host, same clock.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const iso = now.toISOString().slice(0, 10);
    const longDate = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    const dtf = `${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())}`;

    expect(all).toContain(`ISO=[${iso}]`);
    expect(all).toContain(`DATE=[${longDate}]`);
    expect(all).toContain(`WD=[${weekday}]`);
    expect(all).toContain(`DTF=[${dtf}]`);
    // {{time}} is HH:MM UTC — assert shape only to avoid minute-rollover flakes.
    expect(all).toMatch(/TM=\[\d{2}:\d{2}\]/);

    expect(all).not.toContain('{{isodate}}');
    expect(all).not.toContain('{{date}}');
    expect(all).not.toContain('{{weekday}}');
    expect(all).not.toContain('{{datetimeformat');
    expect(all).not.toContain('{{time}}');
  });

  test('chat inspection macros see the placeholder on generate and content on continue', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({
      name: uniqueName('Inspect Char'),
      description: 'prev=[{{lastCharMessage}}] u=[{{lastUserMessage}}] lm=[{{lastMessage}}]',
      firstMes: 'Ready.',
    });

    // Fresh generation: the server appends the empty assistant streaming target
    // BEFORE building the prompt, so lastMessage/lastCharMessage see that empty
    // placeholder while lastUserMessage sees the just-sent user text.
    await app.sendUserMessage('respond: MARKER1', { expectReply: true });
    const first = bodyString(await getLastLlmRequest());
    expect(first).toContain('u=[respond: MARKER1]');
    expect(first).toContain('prev=[]');
    expect(first).toContain('lm=[]');

    // Continue re-generates into the existing assistant message, so the target
    // already holds MARKER1 and both chat-inspection macros resolve to it.
    const before = (await getLastLlmRequest()).count;
    await app.clickMessageAction(app.lastBubble('assistant'), 'Continue');
    const second = bodyString(await waitForNextLlmRequest(before));
    expect(second).toContain('prev=[MARKER1]');
    expect(second).toContain('lm=[MARKER1]');
    expect(second).toContain('u=[respond: MARKER1]');

    // Let the continued stream settle so the afterEach reset runs clean.
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
  });

  test('random macros resolve in range without residue', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({
      name: uniqueName('Random Char'),
      description: 'P=[{{pick::alpha::beta}}] R=[{{random::5::9}}]',
      firstMes: 'Ready.',
    });

    await app.sendUserMessage('hello', { expectReply: true });
    const all = bodyString(await getLastLlmRequest());

    expect(all).toMatch(/P=\[(alpha|beta)\]/);
    expect(all).toMatch(/R=\[[5-9]\]/);
    expect(all).not.toContain('{{pick');
    expect(all).not.toContain('{{random');
  });

  test('utility macros resolve, comments vanish, and {{.var}} chains across turns', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({
      name: uniqueName('Utility Char'),
      description:
        'T=[{{trim::  padded  }}] R=[{{reverse::abc}}] N=[{{noop}}done] NL=[A{{newline}}B]' +
        '{{comment::topsecret}}{{hidden_key::k=v}}{{// note}} legacy=[{{.blitzkey}}]',
      firstMes: 'Ready.',
    });

    // Turn 1 plants the variable; the utility batch resolves on every turn.
    await app.sendUserMessage('{{setvar::blitzkey::blitzval}} hello', { expectReply: true, userText: 'hello' });
    const first = bodyString(await getLastLlmRequest());
    expect(first).toContain('T=[padded]');
    expect(first).toContain('R=[cba]');
    expect(first).toContain('N=[done]');
    // JSON.stringify escapes the resolved newline.
    expect(first).toContain('NL=[A\\nB]');
    expect(first).not.toContain('topsecret');
    expect(first).not.toContain('{{comment');
    expect(first).not.toContain('{{hidden_key');
    expect(first).not.toContain('{{//');
    expect(first).not.toContain('{{trim');
    expect(first).not.toContain('{{reverse');
    expect(first).not.toContain('{{noop');
    // Already set on the first request: the pipeline's world-info pre-scan
    // resolves the user message (running setvar against the shared macroVars
    // object) before the renderer resolves the description.
    expect(first).toContain('legacy=[blitzval]');

    // Turn 2 inherits the accumulated message variables.
    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('ping', { expectReply: true });
    const second = bodyString(await waitForNextLlmRequest(before));
    expect(second).toContain('legacy=[blitzval]');
    expect(second).not.toContain('{{.blitzkey}}');
  });

  test('model/config macros resolve and unknown macros pass through literally', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({
      name: uniqueName('Config Char'),
      description: 'M=[{{model}}] C=[{{maxContext}}] U=[{{not_a_real_macro}}]',
      firstMes: 'Ready.',
    });

    await app.sendUserMessage('hello', { expectReply: true });
    const all = bodyString(await getLastLlmRequest());

    // configureMockBackend pins the model id; context length is a plain number.
    expect(all).toContain('M=[mock-model]');
    expect(all).toMatch(/C=\[\d+\]/);
    expect(all).not.toContain('{{model}}');
    expect(all).not.toContain('{{maxContext}}');
    // Unknown macros survive verbatim (name + args untouched).
    expect(all).toContain('U=[{{not_a_real_macro}}]');
  });
});
