import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { setSetting } from '../helpers/settings.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Minimal 1x1 transparent PNG (same fixture as attachments.spec.ts).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe('Message Input', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('slash command autocomplete filters, inserts, and closes', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('MsgInputSlash');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    const input = app.messageInput();
    await input.click();

    // A bare '/' parses to an empty command, which the component explicitly
    // excludes (command.length > 0), so the list stays hidden.
    await input.fill('/');
    await expect(page.locator('.slash-autocomplete')).toHaveCount(0);

    // '/na' filters the command list to the single matching command.
    await input.fill('/na');
    const autocomplete = page.locator('.slash-autocomplete');
    await expect(autocomplete).toBeVisible();
    await expect(autocomplete.locator('.slash-suggestion')).toHaveCount(1);
    await expect(autocomplete.locator('.slash-name')).toHaveText('/name');

    // Escape is only wired for the macro autocomplete in handleKeyDown; the
    // slash list ignores it and stays open.
    await input.press('Escape');
    await expect(autocomplete).toBeVisible();

    // Clicking the suggestion inserts '/name ' and closes the list.
    await autocomplete.locator('.slash-suggestion').first().click();
    await expect(input).toHaveValue('/name ');
    await expect(autocomplete).toHaveCount(0);

    // Typing an argument (args.length > 0) also keeps the list hidden.
    await input.fill('/name Bob');
    await expect(page.locator('.slash-autocomplete')).toHaveCount(0);
  });

  test('macro autocomplete opens on {{, inserts on click, closes on Escape', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('MsgInputMacro');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    const input = app.messageInput();
    await input.click();

    // '{{cha' opens the macro list filtered to char-like macros.
    await input.fill('{{cha');
    const autocomplete = page.locator('.slash-autocomplete');
    await expect(autocomplete).toBeVisible();
    const charSuggestion = autocomplete.locator('.slash-suggestion', {
      has: page.locator('.slash-name', { hasText: '{{char}}' }),
    });
    await expect(charSuggestion.first()).toBeVisible();

    // Clicking {{char}} replaces the partial macro with the full token.
    await charSuggestion.first().click();
    await expect(input).toHaveValue('{{char}}');
    await expect(autocomplete).toHaveCount(0);

    // Escape closes the macro list without changing the text.
    await input.fill('{{');
    await expect(page.locator('.slash-autocomplete')).toBeVisible();
    await input.press('Escape');
    await expect(page.locator('.slash-autocomplete')).toHaveCount(0);
    await expect(input).toHaveValue('{{');
  });

  test('Ctrl+B and Ctrl+I wrap the selection in markdown markers', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('MsgInputWrap');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    const input = app.messageInput();

    // Ctrl+B wraps the selection in '**'.
    await input.fill('hello world');
    await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 11));
    await page.keyboard.press('Control+b');
    await expect(input).toHaveValue('hello **world**');

    // Ctrl+I wraps the selection in '*'.
    await input.fill('hello world');
    await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 11));
    await page.keyboard.press('Control+i');
    await expect(input).toHaveValue('hello *world*');
  });

  test('pasting an image file attaches it and sends it with the message', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('MsgInputPaste');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    // Dispatch a paste event carrying a real image File through clipboardData,
    // matching what handlePaste reads (clipboardData.items -> getAsFile()).
    await app.messageInput().click();
    await page.evaluate((pngBase64) => {
      const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'pasted-image.png', { type: 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const textarea = document.querySelector('.message-textarea');
      if (!textarea) throw new Error('message textarea not found');
      textarea.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }),
      );
    }, PNG_BASE64);

    // The upload lands and a preview chip renders.
    const preview = page.locator('.attachment-previews .attachment-preview');
    await expect(preview).toBeVisible({ timeout: 10000 });
    await expect(preview.locator('.attachment-preview-img')).toBeVisible();

    // Send with accompanying text; the user bubble carries the attachment.
    await app.messageInput().fill('pasted image attached');
    await page.locator('.message-input-area .send-btn').click();
    await expect(app.messageInput()).toHaveValue('');
    const userBubble = app.lastBubble('user');
    await expect(userBubble).toContainText('pasted image attached', { timeout: 5000 });
    await expect(userBubble.locator('.message-attachments')).toBeVisible();
    await expect(userBubble.locator('.message-attachment-img')).toBeVisible();
    await expect(preview).toHaveCount(0);
  });

  test('draft behaviors: Enter newline when send-on-enter disabled, send button state', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('MsgInputDraft');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    const input = app.messageInput();
    const sendBtn = page.locator('.message-input-area .send-btn');

    // sendOnEnter 'auto' would SEND on desktop (shouldSendOnEnter returns
    // !isMobileDevice()), so pin the setting to 'disabled' for a deterministic
    // newline assertion, then restore it.
    await setSetting(page, 'sendOnEnter', 'disabled');
    const bubblesBefore = await page.locator('.message-bubble').count();
    await input.fill('draft line one');
    await input.press('Enter');
    await expect(input).toHaveValue('draft line one\n');
    await expect(page.locator('.message-bubble')).toHaveCount(bubblesBefore);

    // The send button's disabled state only tracks streaming/lock — it is NOT
    // content-gated. It stays enabled whether the input is empty or not, and
    // clicking it with an empty draft sends no user message.
    await input.fill('');
    await expect(sendBtn).toBeEnabled();
    const userBefore = await page.locator('.message-bubble.user').count();
    await sendBtn.click();
    await expect(page.locator('.message-bubble.user')).toHaveCount(userBefore);
    // The empty click still fires action.generate; let it settle before continuing.
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });

    await input.fill('some content');
    await expect(sendBtn).toBeEnabled();
    await input.fill('');

    await setSetting(page, 'sendOnEnter', 'auto');
  });
});
