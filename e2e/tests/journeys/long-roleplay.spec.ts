/**
 * Flagship "long roleplay" journey.
 *
 * This is the shape the rest of the journey tier should follow: one long,
 * serial, human-shaped session that keeps going through many features instead
 * of poking one button and stopping. It exercises character creation, a
 * multi-turn conversation, in-place edit, regenerate-into-swipe + swipe
 * navigation, hide/unhide, fork + rename, and switching back to the original
 * chat — all against the deterministic mock LLM.
 *
 * `seq:` user turns (see fixtures/mockLlmServer.ts) make each assistant reply a
 * distinct `Turn N`, so regenerate/swipe variants are assertably different.
 */
import { journeyTest as test, expect } from '../../fixtures/journey.js';
import * as fs from 'node:fs';

test.describe('Long Roleplay Journey', () => {
  test('one session: character → conversation → edit → swipe → hide → fork → return', async ({ app, page }) => {
    page.on('console', (m) => console.error('[browser]', m.text()));
    page.on('pageerror', (e) => console.error('[browser-err]', e.message));
    page.on('framenavigated', (f) => console.error('[STALL-PAGE] framenavigated url=' + f.url()));
    page.on('close', () => console.error('[STALL-PAGE] page CLOSED'));
    page.on('crash', () => console.error('[STALL-PAGE] page CRASHED'));
    // pageerror does NOT capture unhandled promise rejections — add a listener.
    await page.evaluate(() => {
      window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        console.error(
          '[UNHANDLED-REJECTION]',
          e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack}` : String(e.reason),
        );
      });
    });
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => {
        const p = typeof frame.payload === 'string' ? frame.payload : String(frame.payload);
        if (p.includes('action.')) console.error('[STALL-WS-CLIENT] SENT: ' + p.slice(0, 200));
      });
      ws.on('framereceived', (frame) => {
        const p = typeof frame.payload === 'string' ? frame.payload : String(frame.payload);
        if (p.includes('"type":"snapshot"') || p.includes('"type":"message.snapshot"'))
          console.error('[STALL-WS-CLIENT] RECV snapshot bytes=' + p.length);
      });
    });
    const charName = `Journey Char ${Date.now()}`;
    const greeting = `Hello! I am ${charName}. Ask me anything.`;
    // `seq:` turns each yield a distinct `Turn N` from the mock.
    const turns = [
      'seq:Tell me about the kingdom.',
      'seq:Who are its enemies?',
      'seq:Describe the marketplace.',
      'seq:Introduce a mysterious stranger.',
      'seq:What happens next?',
    ];

    await test.step('create a character with a greeting', async () => {
      await app.createCharacter({
        name: charName,
        description: 'A character for the long roleplay journey.',
        firstMes: greeting,
      });
    });

    await test.step('start a chat and see the greeting', async () => {
      await app.startChat(charName);
      await expect(page.locator('.message-bubble.assistant').first()).toContainText(greeting);
    });

    await test.step('hold a multi-turn conversation', async () => {
      fs.writeFileSync('/tmp/stall-diag.log', '');
      // 1 greeting bubble to start; each turn adds a user + assistant bubble.
      let expected = 1;
      const seenTurns: string[] = [];
      for (const text of turns) {
        const diag = await page
          .locator('.message-input-area .send-btn')
          .evaluateAll((btns) =>
            btns.map((b) => ({
              title: b.getAttribute('title'),
              cls: b.className,
              disabled: (b as HTMLButtonElement).disabled,
            })),
          );
        const busState = await page.evaluate(() => {
          const b = (window as unknown as { __stBus?: { ws?: { readyState: number }; pending?: unknown[]; connected: boolean; authError: boolean } }).__stBus;
          return b
            ? { readyState: b.ws?.readyState, pending: b.pending?.length, connected: b.connected, authError: b.authError }
            : null;
        });
        fs.appendFileSync('/tmp/stall-diag.log', `turn btn=${JSON.stringify(diag)} bus=${JSON.stringify(busState)}\n`);
        await app.sendUserMessage(text, { expectReply: true });
        expected += 2;
        await app.waitForBubbleCount(expected);
        await app.waitForAssistantText(/Turn \d+/);
        const reply = await app.lastAssistantText();
        expect(reply).toMatch(/Turn \d+/);
        // Each reply in the thread is distinct — threading/generation stayed sane.
        expect(seenTurns, 'assistant reply repeated a previous turn').not.toContain(reply);
        seenTurns.push(reply);
      }
    });

    await test.step('edit the greeting in place', async () => {
      const greetingBubble = page.locator('.message-bubble.assistant').first();
      const edited = `Welcome, traveler. I am ${charName}.`;
      await app.editMessage(greetingBubble, edited);
    });

    await test.step('regenerate into a swipe and navigate between swipes', async () => {
      const lastAssistant = app.lastBubble('assistant');
      const firstSwipe = await app.lastAssistantText();

      // Regenerate creates a sibling swipe (GenerationService "create a swipe /
      // sibling message"), so the counter moves to 2/2 with different text.
      await app.regenerate(lastAssistant);
      await expect(page.locator('.swipe-counter')).toHaveText('2/2', { timeout: 10000 });
      await app.waitForAssistantText(/Turn \d+/);
      const secondSwipe = await app.lastAssistantText();
      expect(secondSwipe, 'regenerate produced an identical swipe').not.toBe(firstSwipe);

      // Navigate back to the first swipe.
      await app.swipe('left');
      await expect(page.locator('.swipe-counter')).toHaveText('1/2', { timeout: 10000 });
      await expect(app.lastBubble('assistant').locator('.message-content')).toContainText(firstSwipe);

      // And forward to the second again.
      await app.swipe('right');
      await expect(page.locator('.swipe-counter')).toHaveText('2/2', { timeout: 10000 });
      await expect(app.lastBubble('assistant').locator('.message-content')).toContainText(secondSwipe);
    });

    await test.step('hide a message, then unhide it', async () => {
      // Hidden messages are filtered out of the view unless this setting is on.
      // ensureSetting (not toggle) because the setting persists across specs.
      await app.ensureSetting('Show hidden messages', true);

      const firstUser = page.locator('.message-bubble.user').first();
      await app.hideMessage(firstUser);
      await expect(page.locator('.message-bubble.user.hidden-message').last()).toBeVisible({ timeout: 5000 });

      await app.unhideMessage(page.locator('.message-bubble.user').first());
      await expect(page.locator('.message-bubble.user.hidden-message')).toHaveCount(0);
    });

    await test.step('fork into a new chat, rename it, then return to the original', async () => {
      const originalChatId = await app.activeChatId();
      expect(originalChatId).toBeTruthy();

      const firstUser = page.locator('.message-bubble.user').first();
      await app.forkAt(firstUser);

      // The fork became active; rename it to prove the new chat is fully usable.
      const forkName = `Branch ${Date.now()}`;
      await app.renameActiveChat(forkName);
      await expect(page.locator('.chat-list')).toContainText(forkName);

      // Switch back to the original and confirm the whole session survived.
      await app.selectChatById(originalChatId as string);
      await expect(page.locator('.message-bubble.assistant').first()).toContainText(
        `I am ${charName}`,
      );
      // Greeting + several conversational turns should still be present.
      const bubbleCount = await page.locator('.message-bubble').count();
      expect(bubbleCount).toBeGreaterThanOrEqual(3);
    });
  });
});
