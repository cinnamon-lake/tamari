import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';

test.describe('App Layout', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('renders main layout when authenticated', async ({ page }) => {
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.main-panel')).toBeVisible();
  });

  test('renders sidebar', async ({ page }) => {
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.sidebar')).toContainText('tamari');
  });

  test('renders global toast container', async ({ page }) => {
    // Toast container is in the DOM but visually hidden until a toast appears
    const toastContainer = page.locator('.toast-container');
    await expect(toastContainer).toBeAttached();
    await expect(toastContainer).toHaveAttribute('role', 'region');
    await expect(toastContainer).toHaveAttribute('aria-live', 'polite');
  });
});

test.describe('Drag and Drop', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('shows drag overlay on drag enter with files', async ({ page }) => {
    const main = page.locator('.main-panel');
    await main.evaluate((el) => {
      // Create a DataTransfer with a dummy file so types includes 'Files'
      const dt = new DataTransfer();
      dt.items.add(new File([''], 'test.txt', { type: 'text/plain' }));
      el.dispatchEvent(
        new DragEvent('dragenter', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
    });

    await expect(page.locator('.drag-drop-overlay')).toBeVisible();
    await expect(page.locator('.drag-drop-hint')).toContainText('Drop files to attach');
  });

  test('hides drag overlay on drag leave', async ({ page }) => {
    const main = page.locator('.main-panel');

    // Trigger drag enter
    await main.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File([''], 'test.txt', { type: 'text/plain' }));
      el.dispatchEvent(
        new DragEvent('dragenter', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
    });
    await expect(page.locator('.drag-drop-overlay')).toBeVisible();

    // Trigger drag leave — the app decrements a drag counter, so send leave twice
    // to ensure counter hits zero (initial dragenter counts as entering window)
    await main.evaluate((el) => {
      el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.drag-drop-overlay')).not.toBeVisible();
  });
});
