import '@testing-library/jest-dom/vitest';
import { cleanup } from '@solidjs/testing-library';
import { afterEach } from 'vitest';
import { MockWebSocket } from './mocks/WebSocketMock.js';

// Replace jsdom's WebSocket with our mock for all tests.
// This must happen before any module creates a WebSocket.
Object.assign(globalThis, { WebSocket: MockWebSocket });

// SolidJS testing-library cleanup after each test
afterEach(() => cleanup());
