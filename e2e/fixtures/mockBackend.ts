/**
 * Mock backend adapter responses for E2E tests.
 *
 * Intercepts LLM API calls so tests don't need real API keys.
 */

import type { Page } from '@playwright/test';

export interface MockResponse {
  text?: string;
  delayMs?: number;
}

/**
 * Set up route interception to mock LLM generation responses.
 */
export async function mockGeneration(page: Page, response: MockResponse = {}): Promise<void> {
  const text = response.text ?? 'Hello! This is a mock response from the e2e test.';
  const delayMs = response.delayMs ?? 100;

  // Mock the model listing endpoint
  await page.route('**/api/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{ id: 'mock-model', name: 'Mock Model' }],
        total: 1,
      }),
    });
  });

  // Mock generation responses via WebSocket is harder;
  // for e2e tests we primarily test UI flows without real generation.
  // If you need to test streaming, mock the backend adapter's HTTP calls.
}

/**
 * Mock avatar upload processing.
 */
export async function mockAvatarProcessing(page: Page): Promise<void> {
  await page.route('**/api/characters/*/avatar', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });
}
