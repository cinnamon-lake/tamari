import { createSignal } from 'solid-js';

const AUTH_TOKEN_KEY = 'st_auth_token';

function readToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

// Reactive signal for auth state — components subscribe to this
const [authToken, setAuthTokenSignal] = createSignal<string | null>(readToken());

export function getAuthToken(): string | null {
  return authToken();
}

export function setAuthToken(token: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // ignore
  }
  setAuthTokenSignal(token);
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // ignore
  }
  setAuthTokenSignal(null);
}

export function isAuthenticated(): boolean {
  return !!authToken();
}

export { authToken };
