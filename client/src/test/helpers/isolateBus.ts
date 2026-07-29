import { WebSocketBus } from '../../bus/WebSocketBus.js';
import { MockWebSocket } from '../mocks/WebSocketMock.js';

/**
 * Creates an isolated WebSocketBus with a MockWebSocket for testing.
 *
 * Use this when testing code that imports the global `bus` singleton.
 * The returned bus is a fresh instance; you control message delivery
 * via `mock.simulateMessage()` and inspect sent messages via
 * `mock.sent`.
 */
export function createIsolatedBus(): { bus: WebSocketBus; mock: MockWebSocket } {
  const bus = new WebSocketBus('ws://localhost:8000/ws');

  // The WebSocketBus constructor calls new WebSocket(this.url).
  // We need to swap in our mock. Because WebSocket is a global,
  // we stub it before creating the bus. This helper assumes
  // the caller has already stubbed global.WebSocket with MockWebSocket.
  //
  // For tests, use:
  //   vi.stubGlobal('WebSocket', MockWebSocket);
  //   const { bus, mock } = createIsolatedBus();

  // Find the mock instance created by the bus constructor
  const mock = (bus as unknown as { ws: MockWebSocket }).ws;

  return { bus, mock };
}
