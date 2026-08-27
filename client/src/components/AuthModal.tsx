import { createSignal, Show, onMount, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { setAuthToken, authToken, clearAuthToken } from '../lib/auth.js';
import { bus } from '../bus/WebSocketBus.js';
import { useI18n } from '../i18n/index.js';
import './AuthModal.css';


export function AuthGate(props: { children: JSX.Element }) {
  const { t } = useI18n();
  const [tokenInput, setTokenInput] = createSignal('');
  const [authError, setAuthError] = createSignal('');
  const [isSubmitting, setIsSubmitting] = createSignal(false);

  // Listen for auth errors from the WebSocket bus
  onMount(() => {
    const unsub = bus.on('auth.error', (msg) => {
      // The bus connects on startup even with no token, which always produces
      // an auth.error — don't greet a first-run user with a red banner for it.
      // Only surface the error when a token was actually presented (a stored
      // session that expired, or one the user just submitted).
      const hadToken = Boolean(authToken());
      clearAuthToken();
      bus.disconnect();
      if (hadToken) setAuthError(msg.message);
    });
    onCleanup(unsub);
  });

  // Exchange the password for a revocable session token; only that token is
  // ever persisted — the password itself stays out of localStorage.
  const submit = async () => {
    const password = tokenInput().trim();
    if (!password) {
      setAuthError(t('auth.errors.tokenRequired'));
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setAuthError(res.status === 401 ? t('auth.errors.invalid') : t('auth.errors.requestFailed'));
        return;
      }
      const data = (await res.json()) as { token?: string };
      if (!data.token) {
        setAuthError(t('auth.errors.requestFailed'));
        return;
      }
      setAuthToken(data.token);
      setAuthError('');
      // Reconnect WebSocket with the new token
      bus.disconnect();
      setTimeout(() => bus.connect(), 100);
    } catch {
      setAuthError(t('auth.errors.network'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = () => {
    void submit();
  };

  return (
    <Show
      when={authToken() && !authError()}
      fallback={
        <div class="auth-overlay">
          <div class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
            <h2 class="auth-modal-title" id="auth-modal-title">{t('auth.title')}</h2>
            <p class="auth-modal-description">{t('auth.description')}</p>
            <p class="auth-hint">
              {t('auth.hintPrefix')} <code class="auth-modal-env-var">TAMARI_SECRET</code> {t('auth.hintSuffix')}
            </p>
            <Show when={authError()}>
              <div class="auth-error" id="auth-error">{authError()}</div>
            </Show>
            <label for="auth-token" class="sr-only">{t('auth.secretTokenLabel')}</label>
            <input
              id="auth-token"
              type="password"
              class="auth-input"
              placeholder={t('auth.secretTokenPlaceholder')}
              value={tokenInput()}
              onInput={(e) => setTokenInput(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              autofocus={!window.matchMedia('(pointer: coarse)').matches}
              autocomplete="current-password"
              aria-describedby={authError() ? 'auth-error' : undefined}
              data-testid="auth-input"
            />
            <button
              class="btn btn-primary"
              onClick={() => void submit()}
              disabled={isSubmitting()}
              data-testid="auth-submit"
            >
              {isSubmitting() ? t('auth.connecting') : t('auth.connect')}
            </button>
          </div>
        </div>
      }
    >
      {props.children}
    </Show>
  );
}
