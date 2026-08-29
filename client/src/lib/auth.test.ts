import { describe, it, expect, beforeEach } from 'vitest';
import { getAuthToken, setAuthToken, clearAuthToken, authToken } from './auth.js';

describe('auth', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAuthToken();
  });

  it('returns null when localStorage is empty', () => {
    expect(getAuthToken()).toBeNull();
  });

  it('sets token in localStorage and signal', () => {
    setAuthToken('my-token');
    expect(localStorage.getItem('st_auth_token')).toBe('my-token');
    expect(getAuthToken()).toBe('my-token');
    expect(authToken()).toBe('my-token');
  });

  it('clears token from localStorage and signal', () => {
    setAuthToken('my-token');
    clearAuthToken();
    expect(localStorage.getItem('st_auth_token')).toBeNull();
    expect(getAuthToken()).toBeNull();
    expect(authToken()).toBeNull();
  });

  it('overwrites existing token', () => {
    setAuthToken('old');
    setAuthToken('new');
    expect(getAuthToken()).toBe('new');
  });
});
