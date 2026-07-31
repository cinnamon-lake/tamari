import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import type { Locator, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Shared across the serial tests: created in one test, driven/cleaned up in later ones.
const speakToolsetName = uniqueName('Modal Speak TS');
const luaTemplateName = uniqueName('Modal Lua');
const greetingValue = `hello-${Date.now()}`;

// Lua source authored through the LuaTemplateEditor in test 4. Its configSchema
// deliberately covers the SchemaForm branches no builtin template exercises:
// a plain text input, an enum select, a boolean checkbox and a number input.
const LUA_CODE = `Tool = {}
Tool.state = {}

function Tool.getDefinition()
  return {
    stateKey = "modal_lua",
    configSchema = {
      type = "object",
      properties = {
        greeting = { type = "string", description = "Greeting text", default = "" },
        mode = { type = "string", enum = { "alpha", "beta" }, default = "alpha" },
        verbose = { type = "boolean", description = "Verbose output", default = false },
        retries = { type = "number", description = "Retry count", default = 1 }
      }
    },
    tools = {
      {
        name = "modal_echo",
        description = "Echoes the input back.",
        parameters = {
          type = "object",
          properties = {
            input = { type = "string", description = "Input text" }
          },
          required = { "input" }
        }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  return { content = "echo:" .. tostring(args.input), extra = {} }
end

function Tool.serialize()
  return json.encode(Tool.state)
end

function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end

return Tool
`;

async function openToolsModal(page: Page): Promise<Locator> {
  const btn = page.locator('button.settings-btn:has-text("Tools")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.locator('.tools-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function closeToolsModal(page: Page): Promise<void> {
  await page.locator('.modal-overlay:has(.tools-modal)').click({ position: { x: 0, y: 0 } });
  await expect(page.locator('.tools-modal')).not.toBeVisible();
}

function toolsetCard(modal: Locator, name: string): Locator {
  return modal.locator('.toolset-card', { hasText: name });
}

// Every auto-save triggers a server-side `toolset.listed` rebroadcast which
// re-creates every card and collapses it — that collapse is the save receipt.
// Exception: within ~3s of creation the card's auto-expand wins and the panel
// stays open, so a collapse never comes; in that case the round-trip has long
// finished by the time the short wait elapses.
async function waitToolsetSaveReceipt(card: Locator): Promise<void> {
  try {
    await expect(card.locator('button[title="Show config"]')).toBeVisible({ timeout: 4000 });
  } catch {
    // Auto-expand window kept the card open; the save already round-tripped.
  }
}

async function expandToolsetCard(card: Locator): Promise<void> {
  await expect(card).toBeVisible();
  // Wait for the header to render before the one-shot expanded/collapsed check.
  await expect(card.locator('button[title="Show config"], button[title="Hide config"]')).toBeVisible();
  const showBtn = card.locator('button[title="Show config"]');
  if (await showBtn.isVisible()) {
    await showBtn.click();
  }
  await expect(card.locator('.toolset-body')).toBeVisible();
}

async function editToolsetAndSave(card: Locator, edit: () => Promise<void>): Promise<void> {
  await expandToolsetCard(card);
  await edit();
  await waitToolsetSaveReceipt(card);
}

// Same rebroadcast dance for Lua template rows: `toolTemplate.listed`
// re-creates the row and drops it back to display mode (unless still inside
// the auto-edit window after creation).
async function waitLuaSaveReceipt(row: Locator): Promise<void> {
  try {
    await expect(row.locator('button[title="Edit Lua template"]')).toBeVisible({ timeout: 4000 });
  } catch {
    // Auto-edit window kept the editor open; the save already round-tripped.
  }
}

async function ensureLuaEditing(row: Locator): Promise<void> {
  // Wait for the row to render before the one-shot editing/display check.
  await expect(row.locator('button[title="Edit Lua template"], .instance-row-editor')).toBeVisible();
  const editBtn = row.locator('button[title="Edit Lua template"]');
  if (await editBtn.isVisible()) {
    await editBtn.click();
  }
  await expect(row.locator('.instance-row-editor')).toBeVisible();
}

test.describe('Tools Modal', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('creates a toolset from a picked template and it persists across reopen', async ({ page }) => {
    const modal = await openToolsModal(page);

    // The modal's two sections.
    await expect(modal.locator('h3:has-text("Toolsets")')).toBeVisible();
    await expect(modal.locator('h3:has-text("Lua Templates")')).toBeVisible();
    await expect(modal.locator('.tools-empty', { hasText: 'No toolsets yet' })).toBeVisible();

    await modal.locator('button:has-text("New Toolset")').click();
    const card = toolsetCard(modal, 'New Toolset');
    await expect(card).toBeVisible();
    await expect(modal.locator('.tools-empty', { hasText: 'No toolsets yet' })).not.toBeVisible();
    // Newly created toolsets start enabled and auto-expanded.
    await expect(card.locator('.toolset-checkbox')).toBeChecked();
    await expect(card.locator('.toolset-body')).toBeVisible();

    // The template picker lists builtin templates plus seeded Lua templates.
    const templateSelect = card.locator('select.select');
    await expect(templateSelect).toBeVisible();
    const optionLabels = (await templateSelect.locator('option').allTextContents()).map((s) => s.trim());
    expect(optionLabels.length).toBeGreaterThanOrEqual(10);
    expect(optionLabels).toContain('Speak');
    expect(optionLabels).toContain('Lua Runner');
    expect(optionLabels).toContain('Forge Image Generator');
    expect(optionLabels).toContain('lua_dice');

    // Pick a template, then name the toolset. The header reflects each save
    // once the server rebroadcasts the toolset.
    await templateSelect.selectOption({ label: 'Speak' });
    await expect(card.locator('.toolset-header-meta')).toHaveText('Speak', { timeout: 5000 });

    await expandToolsetCard(card);
    await card.locator('.toolset-body .instance-field input.input').first().fill(speakToolsetName);
    const renamed = toolsetCard(modal, speakToolsetName);
    await expect(renamed.locator('.toolset-header-name')).toHaveText(speakToolsetName, { timeout: 5000 });

    await closeToolsModal(page);
    const modal2 = await openToolsModal(page);
    await expect(toolsetCard(modal2, speakToolsetName).locator('.toolset-header-name')).toHaveText(speakToolsetName);
  });

  test('edits SchemaForm config fields (select, text, secret, textarea) and they persist', async ({ page }) => {
    const modal = await openToolsModal(page);
    const card = toolsetCard(modal, speakToolsetName);
    await expect(card).toBeVisible();

    const voiceId = `voice-${Date.now()}`;
    await editToolsetAndSave(card, () =>
      card.locator('#provider select.schema-select').selectOption('elevenlabs'),
    );
    await editToolsetAndSave(card, () => card.locator('#voiceId input.schema-input').fill(voiceId));
    await editToolsetAndSave(card, () =>
      card.locator('#requestScript textarea.schema-input').fill('return request'),
    );
    await editToolsetAndSave(card, () => card.locator('#apiKey input[type="password"]').fill('e2e-secret-key'));

    await closeToolsModal(page);
    const modal2 = await openToolsModal(page);
    const card2 = toolsetCard(modal2, speakToolsetName);
    await expandToolsetCard(card2);
    await expect(card2.locator('#provider select.schema-select')).toHaveValue('elevenlabs');
    await expect(card2.locator('#voiceId input.schema-input')).toHaveValue(voiceId);
    await expect(card2.locator('#requestScript textarea.schema-input')).toHaveValue('return request');
    await expect(card2.locator('#apiKey input[type="password"]')).toHaveValue('e2e-secret-key');
  });

  test('overrides a tool name, description and parameter description and they persist', async ({ page }) => {
    const modal = await openToolsModal(page);
    const card = toolsetCard(modal, speakToolsetName);
    await expandToolsetCard(card);

    // "Tools Available" section: one row per tool the template exposes.
    await expect(card.locator('.section-label', { hasText: 'Tools Available' })).toBeVisible();
    const row = card.locator('.instance-row', { hasText: 'speak' });
    await expect(row.locator('code.tool-code')).toHaveText('speak');
    // The row exposes the parameter from the tool's JSON schema.
    await expect(row.locator('.instance-param .instance-param-key')).toHaveText('text');

    await editToolsetAndSave(card, () => row.locator('input.input').fill('speak_e2e'));
    await editToolsetAndSave(card, () => row.locator('textarea.textarea').fill('Custom speak description'));
    await editToolsetAndSave(card, () =>
      row.locator('.instance-param input.instance-input').fill('Custom text parameter'),
    );

    await closeToolsModal(page);
    const modal2 = await openToolsModal(page);
    const card2 = toolsetCard(modal2, speakToolsetName);
    await expandToolsetCard(card2);
    const row2 = card2.locator('.instance-row', { hasText: 'speak' });
    await expect(row2.locator('input.input')).toHaveValue('speak_e2e');
    await expect(row2.locator('textarea.textarea')).toHaveValue('Custom speak description');
    await expect(row2.locator('.instance-param input.instance-input')).toHaveValue('Custom text parameter');
  });

  test('authors a Lua template: name, code and sandbox flags persist', async ({ page }) => {
    const modal = await openToolsModal(page);

    await modal.locator('button:has-text("New Lua Template")').click();
    // Newest template sorts first (created_at DESC) and auto-opens its editor.
    const row = modal.locator('.lua-tool-list .instance-row').first();
    await expect(row.locator('.instance-row-editor')).toBeVisible();
    // The editor starts from the default template code.
    await expect(row.locator('.lua-tool-editor-code textarea')).toHaveValue(/function Tool\.getDefinition/);

    await row.locator('.lua-tool-editor-fields input.input').fill(luaTemplateName);
    await waitLuaSaveReceipt(row);

    await ensureLuaEditing(row);
    await row.locator('.lua-tool-editor-code textarea').fill(LUA_CODE);
    await waitLuaSaveReceipt(row);

    await ensureLuaEditing(row);
    await row.locator('.lua-tool-sandbox label:has-text("Allow fetch") input').check();
    await waitLuaSaveReceipt(row);

    await ensureLuaEditing(row);
    await row.locator('.lua-tool-sandbox label:has-text("Allow st API") input').check();
    await waitLuaSaveReceipt(row);

    await ensureLuaEditing(row);
    await row.locator('.instance-row-actions button:has-text("Done")').click();
    await expect(row.locator('.lua-tool-name')).toHaveText(luaTemplateName);

    // Reopen the editor: everything read back comes from the server broadcast.
    await row.locator('button[title="Edit Lua template"]').click();
    await expect(row.locator('.lua-tool-editor-fields input.input')).toHaveValue(luaTemplateName);
    await expect(row.locator('.lua-tool-editor-code textarea')).toHaveValue(LUA_CODE);
    await expect(row.locator('.lua-tool-sandbox label:has-text("Allow fetch") input')).toBeChecked();
    await expect(row.locator('.lua-tool-sandbox label:has-text("Allow st API") input')).toBeChecked();
    await expect(row.locator('.lua-tool-sandbox label:has-text("Allow io") input')).not.toBeChecked();
    await row.locator('.instance-row-actions button:has-text("Done")').click();
  });

  test('builds a toolset on the Lua template and edits checkbox/number SchemaForm fields', async ({ page }) => {
    // Reload so the fresh snapshot's `tools` list carries the new Lua template
    // with the configSchema its getDefinition() returns (state.tools only
    // updates on snapshot, not on toolTemplate.* broadcasts).
    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    // Same slow-runner read race as the settings modal: the tools modal reads
    // state.tools at open — wait for the post-reload snapshot.
    await new App(page).waitForInitialSnapshot();

    const modal = await openToolsModal(page);
    await modal.locator('button:has-text("New Toolset")').click();
    const card = toolsetCard(modal, 'New Toolset');
    await expect(card).toBeVisible();

    const templateSelect = card.locator('select.select');
    await expect(templateSelect.locator('option', { hasText: luaTemplateName })).toHaveCount(1);
    await templateSelect.selectOption({ label: luaTemplateName });
    await expect(card.locator('.toolset-header-meta')).toHaveText(luaTemplateName, { timeout: 5000 });

    // The Lua tool definition renders in the Tools Available section.
    await expandToolsetCard(card);
    await expect(card.locator('code.tool-code', { hasText: 'modal_echo' })).toBeVisible();

    // SchemaForm branches: text input, enum select, boolean checkbox, number input.
    await editToolsetAndSave(card, () => card.locator('#greeting input.schema-input').fill(greetingValue));
    await editToolsetAndSave(card, () => card.locator('#mode select.schema-select').selectOption('beta'));
    await editToolsetAndSave(card, () => card.locator('#verbose input.schema-checkbox').check());
    await editToolsetAndSave(card, () => card.locator('#retries input[type="number"]').fill('3'));

    // Cheap extra surface: the enable/disable toggle round-trips too.
    const toggle = card.locator('.toolset-checkbox');
    await toggle.click();
    await expect(toggle).not.toBeChecked({ timeout: 5000 });
    await toggle.click();
    await expect(toggle).toBeChecked({ timeout: 5000 });

    await closeToolsModal(page);
    const modal2 = await openToolsModal(page);
    const card2 = toolsetCard(modal2, 'New Toolset');
    await expandToolsetCard(card2);
    await expect(card2.locator('#greeting input.schema-input')).toHaveValue(greetingValue);
    await expect(card2.locator('#mode select.schema-select')).toHaveValue('beta');
    await expect(card2.locator('#verbose input.schema-checkbox')).toBeChecked();
    await expect(card2.locator('#retries input[type="number"]')).toHaveValue('3');
  });

  test('clears the override, then deletes both toolsets and the Lua template', async ({ page }) => {
    const modal = await openToolsModal(page);

    // Delete the override: clearing the row's fields removes it on save.
    const speakCard = toolsetCard(modal, speakToolsetName);
    const row = speakCard.locator('.instance-row', { hasText: 'speak' });
    await editToolsetAndSave(speakCard, () => row.locator('input.input').fill(''));
    await editToolsetAndSave(speakCard, () => row.locator('textarea.textarea').fill(''));
    await editToolsetAndSave(speakCard, () => row.locator('.instance-param input.instance-input').fill(''));

    await expandToolsetCard(speakCard);
    await expect(row.locator('input.input')).toHaveValue('');
    await expect(row.locator('textarea.textarea')).toHaveValue('');
    await expect(row.locator('.instance-param input.instance-input')).toHaveValue('');

    // Delete the Lua-backed toolset first (it references the template).
    const luaCard = toolsetCard(modal, 'New Toolset');
    await luaCard.locator('button[title="Delete"]').click();
    let popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.popup-message')).toContainText('Delete toolset "New Toolset"?');
    await popup.locator('button:has-text("Confirm")').click();
    await expect(popup).not.toBeVisible();
    await expect(toolsetCard(modal, 'New Toolset')).toHaveCount(0);

    // Then the Speak toolset.
    await speakCard.locator('button[title="Delete"]').click();
    popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.popup-message')).toContainText(`Delete toolset "${speakToolsetName}"?`);
    await popup.locator('button:has-text("Confirm")').click();
    await expect(popup).not.toBeVisible();
    await expect(toolsetCard(modal, speakToolsetName)).toHaveCount(0);
    await expect(modal.locator('.tools-empty', { hasText: 'No toolsets yet' })).toBeVisible();

    // Finally the Lua template.
    const luaRow = modal.locator('.lua-tool-list .instance-row', { hasText: luaTemplateName });
    await luaRow.locator('button[title="Delete Lua template"]').click();
    popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.popup-message')).toContainText(`Delete Lua template "${luaTemplateName}"?`);
    await popup.locator('button:has-text("Confirm")').click();
    await expect(popup).not.toBeVisible();
    await expect(modal.locator('.lua-tool-list .instance-row', { hasText: luaTemplateName })).toHaveCount(0);
  });
});
