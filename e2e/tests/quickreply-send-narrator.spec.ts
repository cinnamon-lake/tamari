import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Reproduces docs/quality/audits/interface-audit-2026-07-20.md live bug #1:
// `st.send_narrator` (server/src/scripting/StApi.ts:763) references
// `arguments` inside an arrow function to detect the single-argument form
// documented in docs/user/lua-scripting.md (`st.send_narrator(content)`).
// Arrow functions have no own `arguments`: the reference lexically binds to
// the enclosing regular function `createStApi(ctx, deps)`, so
// `arguments.length` is always 2, the single-arg overload is never detected,
// and every `st.send_narrator(content)` call throws
// "send_narrator: expected (name, content) or (content)".
// (The audit predicted `ReferenceError: arguments is not defined` under ESM;
// the observed production failure is the validation throw above — same root
// cause. Vitest masks it because the unit tests only exercise the two-arg
// form, which works.)
//
// User-facing path driven here: create a global quick reply whose Lua script
// calls st.send_narrator, click it in the quick reply bar, and expect the
// narrator (system-role) message to appear in the chat.
//
// EXPECTED TODAY: FAILS — the script errors server-side, a script.error toast
// is shown instead, and no narrator bubble ever renders.
test.describe('st.send_narrator via quick reply (audit: ESM arguments crash)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('clicking a quick reply that calls st.send_narrator appends a narrator message', async ({ page }) => {
    const app = new App(page);
    const scriptErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') scriptErrors.push(msg.text());
    });

    await app.createCharacterAndChat({
      name: uniqueName('Narrator Host'),
      firstMes: 'Ready.',
    });

    const label = uniqueName('Narrate QR');
    const narratorToken = `E2E_NARRATOR_${Date.now()}`;

    // Create the quick reply through the quick reply bar's own editor.
    await page.locator('.quick-reply-bar .quick-reply-add').click();
    const editor = page.locator('.qr-modal');
    await expect(editor).toBeVisible();
    await editor.locator('#qr-label').fill(label);
    await editor.locator('#qr-script').fill(`st.send_narrator("${narratorToken}"):await()`);
    await editor.locator('.btn-primary').click();
    await expect(editor).not.toBeVisible();

    // Sanity: the quickreply.created broadcast lands and the button renders.
    const qrButton = page.locator('.quick-reply-bar .quick-reply-btn', { hasText: label });
    await expect(qrButton).toBeVisible({ timeout: 10000 });

    // Execute it — this runs the Lua script server-side with the full st API.
    await qrButton.click();

    // The narrator message should be appended and broadcast as a system bubble.
    try {
      await expect(
        page.locator('.message-bubble.system .message-content', { hasText: narratorToken }),
      ).toBeVisible({ timeout: 15000 });
    } catch (err) {
      // Surface the server-side script error (relayed as script.error →
      // console.error in serverStore) so the failure names the root cause.
      console.log('[e2e] st.send_narrator produced no narrator message. Browser console errors:');
      for (const line of scriptErrors) console.log(`[e2e]   ${line}`);
      throw err;
    }
  });
});
