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

  const submit = () => {
    const token = tokenInput().trim();
    if (!token) {
      setAuthError(t('auth.errors.tokenRequired'));
      return;
    }
    setAuthToken(token);
    setAuthError('');
    // Reconnect WebSocket with the new token
    bus.disconnect();
    setTimeout(() => bus.connect(), 100);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') submit();
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
            <button class="btn btn-primary" onClick={submit} data-testid="auth-submit">
              {t('auth.connect')}
            </button>
          </div>
        </div>
      }
    >
      {props.children}
    </Show>
  );
}
