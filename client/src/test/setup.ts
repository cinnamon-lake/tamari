import '@testing-library/jest-dom/vitest';
import { cleanup } from '@solidjs/testing-library';
import { afterEach } from 'vitest';
import { MockWebSocket } from './mocks/WebSocketMock.js';

// Replace jsdom's WebSocket with our mock for all tests.
// This must happen before any module creates a WebSocket.
Object.assign(globalThis, { WebSocket: MockWebSocket });

// Node >= 22.4 exposes a stub `localStorage` global that returns undefined
// unless --localstorage-file is passed. It shadows jsdom's implementation in
// the vitest environment (window === globalThis here), leaving localStorage
// undefined in tests. Install a simple in-memory Storage instead.
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}
Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});

// SolidJS testing-library cleanup after each test
afterEach(() => cleanup());
