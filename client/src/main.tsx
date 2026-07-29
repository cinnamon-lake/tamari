import { render } from 'solid-js/web';
import { ErrorBoundary } from 'solid-js';
import type { JSX } from 'solid-js';
import App from './App';
import { I18nProvider } from './i18n/index.js';
import './styles/utilities.css';
import './styles/global.css';
import './styles/hljs-theme.css';
import { applyBrowserFixes } from './lib/browser.js';

// Global error handlers to prevent silent failures and log to console
window.addEventListener('error', (event) => {
  console.error('[Global Error]', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Unhandled Rejection]', event.reason);
});

applyBrowserFixes();

// Top-level fallback so a render-time exception in any component shows a recoverable
// error screen instead of blanking the whole app.
const renderErrorFallback = (err: unknown, reset: () => void): JSX.Element => (
  <div class="app-error" role="alert">
    <h1 class="app-error-title">Something went wrong</h1>
    <p class="app-error-message">An unexpected error occurred while rendering the app.</p>
    {err instanceof Error && err.message ? <pre class="app-error-detail">{err.message}</pre> : null}
    <button class="app-error-retry" type="button" onClick={() => reset()}>
      Try again
    </button>
  </div>
);

const root = document.getElementById('root');
if (root) {
  render(
    () => (
      <ErrorBoundary fallback={renderErrorFallback}>
        <I18nProvider>
          <App />
        </I18nProvider>
      </ErrorBoundary>
    ),
    root,
  );
}
