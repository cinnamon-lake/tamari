import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { AuthGate } from './AuthModal.js';
import { clearAuthToken, setAuthToken, getAuthToken } from '../lib/auth.js';
import { bus } from '../bus/WebSocketBus.js';

describe('AuthGate', () => {
  beforeEach(() => {
    clearAuthToken();
    vi.spyOn(bus, 'disconnect').mockImplementation(() => {});
    vi.spyOn(bus, 'connect').mockImplementation(() => {});
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows auth modal when not authenticated', () => {
    render(() => (
      <AuthGate>
        <div class="auth-gate-test-content">Protected content</div>
      </AuthGate>
    ));
    expect(screen.getByText('Authentication Required')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('shows children when authenticated', () => {
    setAuthToken('valid-token');
    render(() => (
      <AuthGate>
        <div class="auth-gate-test-content">Protected content</div>
      </AuthGate>
    ));
    expect(screen.getByText('Protected content')).toBeInTheDocument();
    expect(screen.queryByText('Authentication Required')).not.toBeInTheDocument();
  });

  it('submitting the password exchanges it for a session token and reconnects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'session-token-1' }), { status: 200 }),
    ));

    render(() => (
      <AuthGate>
        <div class="auth-gate-test-content">Protected content</div>
      </AuthGate>
    ));

    const input = screen.getByPlaceholderText('Secret token');
    fireEvent.input(input, { target: { value: 'my-secret' } });
    screen.getByText('Connect').click();
    await vi.waitFor(() => expect(getAuthToken()).toBe('session-token-1'));

    // The stored credential is the issued session token, never the password.
    expect(getAuthToken()).not.toBe('my-secret');
    expect(bus.disconnect).toHaveBeenCalled();
  });

  it('rejects a wrong password without storing anything', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid password' }), { status: 401 }),
    ));

    render(() => (
      <AuthGate>
        <div class="auth-gate-test-content">Protected content</div>
      </AuthGate>
    ));

    const input = screen.getByPlaceholderText('Secret token');
    fireEvent.input(input, { target: { value: 'wrong-password' } });
    screen.getByText('Connect').click();

    await vi.waitFor(() => expect(screen.getByText('Incorrect password')).toBeInTheDocument());
    expect(bus.disconnect).not.toHaveBeenCalled();
  });

  it('shows error for empty token', () => {
    render(() => (
      <AuthGate>
        <div class="auth-gate-test-content">Protected content</div>
      </AuthGate>
    ));
    screen.getByText('Connect').click();
    expect(screen.getByText('Please enter the secret token')).toBeInTheDocument();
  });

  it('Enter key submits', () => {
    render(() => (
      <AuthGate>
        <div class="auth-gate-test-content">Protected content</div>
      </AuthGate>
    ));
    const input = screen.getByPlaceholderText('Secret token');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Please enter the secret token')).toBeInTheDocument();
  });

  it('handles auth.error from bus', async () => {
    setAuthToken('bad-token');
    render(() => (
      <AuthGate>
        <div class="auth-gate-test-content">Protected content</div>
      </AuthGate>
    ));

    // Simulate auth error from server by directly emitting to bus handlers
    // (The WebSocket mock may have been recreated by prior tests.)
    const msg = { type: 'auth.error' as const, message: 'Invalid token' };
    // Trigger all auth.error handlers directly
    const handlers = (bus as unknown as { handlers: Map<string, Set<(m: unknown) => void>> }).handlers;
    handlers.get('auth.error')?.forEach((h) => h(msg));

    // Wait for SolidJS reactivity to update
    await new Promise((r) => setTimeout(r, 10));

    expect(screen.getByText('Invalid token')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });
});
