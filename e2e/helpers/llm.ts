/**
 * Inspect the deterministic mock LLM server's captured requests from a test.
 *
 * The mock (fixtures/mockLlmServer.ts) stores the body of every
 * /chat/completions request and exposes it at GET /last-request. Because the
 * tamari server (not the browser) makes the call to the LLM, page.route
 * can't see it — so journeys fetch the mock's capture directly to assert that
 * sampler parameters actually reached the outgoing request body.
 */

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

export interface CapturedRequest {
  count: number;
  body: unknown;
  auth?: string;
}

export async function getLastLlmRequest(): Promise<CapturedRequest> {
  const res = await fetch(`${MOCK_URL}/last-request`);
  if (!res.ok) throw new Error(`mock /last-request failed: HTTP ${res.status}`);
  return (await res.json()) as CapturedRequest;
}

/**
 * Poll the mock until a request lands beyond `beforeCount`, then return it.
 * The mock increments its counter in its POST handler, but `expectReply` in
 * sendUserMessage can resolve a tick before that update is observable over the
 * /last-request GET under load — polling removes that race instead of asserting
 * on a single possibly-stale read.
 */
export async function waitForNextLlmRequest(beforeCount: number, timeout = 10000): Promise<CapturedRequest> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const cap = await getLastLlmRequest();
    if (cap.count > beforeCount) return cap;
    if (Date.now() >= deadline) {
      throw new Error(`mock LLM request count did not exceed ${beforeCount} within ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function resetLlmRequests(): Promise<void> {
  await fetch(`${MOCK_URL}/__reset-requests`, { method: 'POST' });
}
