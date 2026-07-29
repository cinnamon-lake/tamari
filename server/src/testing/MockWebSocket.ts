/**
 * Minimal WebSocket mock for bus-level integration tests.
 *
 * Implements only the subset of the `ws` WebSocket interface
 * that EventBus actually touches: readyState, send(), close().
 */

export class MockWebSocket {
  readyState = 1; // OPEN
  sentMessages: string[] = [];
  private _onClose?: () => void;

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this._onClose?.();
  }

  on(event: 'close', handler: () => void): void;
  on(_event: string, handler: () => void): void {
    this._onClose = handler;
  }
}
