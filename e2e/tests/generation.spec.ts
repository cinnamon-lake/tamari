import { smokeTest as test, expect } from '../fixtures/smoke.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { uniqueName } from '../helpers/names.js';

const MOCK_REPLY = 'Hello! This is a deterministic mock response';

test.describe('Generation', () => {
  test('generates an assistant reply via the mock backend', async ({ page, app }) => {
    const charName = uniqueName('Generation Character');
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character created by e2e tests.',
      firstMes: `Hello! I am ${charName}.`,
    });

    await app.sendUserMessage('Hello!');

    await expect(app.lastBubble('assistant')).toContainText(MOCK_REPLY, { timeout: 10000 });

    await expectNoAxeViolations(page);
  });

  test('regenerates the last assistant message', async ({ page, app }) => {
    const charName = uniqueName('Regenerate Character');
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character created by e2e tests.',
      firstMes: `Hello! I am ${charName}.`,
    });

    await app.sendUserMessage('First message');
    await expect(app.lastBubble('assistant')).toContainText(MOCK_REPLY, { timeout: 10000 });

    await app.regenerate(app.lastBubble('assistant'));

    // After regeneration the assistant bubble should still contain the deterministic text.
    await expect(app.lastBubble('assistant')).toContainText(MOCK_REPLY, { timeout: 10000 });

    await expectNoAxeViolations(page);
  });
});
