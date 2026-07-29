import * as i18n from '@solid-primitives/i18n';
import {
  createContext,
  createEffect,
  createResource,
  Suspense,
  useContext,
  type JSX,
} from 'solid-js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { dict as enDict } from './locales/en/index.js';
import type * as enNS from './locales/en/index.js';

/** Shape of the English source dictionary — the contract every locale is checked against. */
export type RawDictionary = typeof enNS.dict;
/** Flattened (dot-path) dictionary used for lookups. */
export type Dictionary = i18n.Flatten<RawDictionary>;

/**
 * Available UI locales. To ship a new language: add its code here, drop a
 * `<code>.ts` file in `./locales/` exporting a (partial) `RawDictionary`, and
 * add a `{ code, nativeName }` entry to REGISTRY. The picker + lazy-loader
 * pick it up automatically.
 */
export const LOCALES = ['en'] as const;
export type Locale = (typeof LOCALES)[number];

export interface LocaleMeta {
  code: Locale;
  /** Endonym, shown verbatim in the language picker (e.g. "Deutsch"). */
  nativeName: string;
}

export const REGISTRY: LocaleMeta[] = [{ code: 'en', nativeName: 'English' }];

/** Coerce an arbitrary stored value to a known Locale, defaulting to English. */
export function normalizeLocale(value: string | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? '') ? (value as Locale) : 'en';
}

// Lazy loaders for every locale file. `en` is also bundled (above) so the first
// paint never blocks on a fetch. Glob matches source paths on disk (.ts).
const loaders = import.meta.glob<{ dict?: RawDictionary }>('./locales/*.ts');

/**
 * Load a locale's dictionary, deep-merging over English so any untranslated
 * keys fall back to the source strings (identity fallback — v1's model).
 */
export async function fetchDictionary(locale: Locale): Promise<Dictionary> {
  const enFlat = i18n.flatten(enDict);
  if (locale === 'en') return enFlat;
  // Non-en locales lazy-load; cast widens past the (currently single-value)
  // Locale union so the lookup compiles before a second locale ships.
  const loader = loaders[`./locales/${locale as string}.ts`];
  if (!loader) return enFlat;
  const mod = await loader();
  if (!mod.dict) return enFlat;
  return { ...enFlat, ...i18n.flatten(mod.dict) };
}

function createI18n() {
  // Locale is derived from server-truth settings; switching is hot (no reload).
  const locale = (): Locale => normalizeLocale(state.settings.language);
  const [resource] = createResource(locale, fetchDictionary, {
    initialValue: i18n.flatten(enDict),
  });
  const t = i18n.translator(resource, i18n.resolveTemplate);
  const setLocale = (next: Locale): void => {
    bus.send({ type: 'settings.set', key: 'language', value: next });
  };
  // Reflect the active locale on <html lang> for a11y / browser features.
  createEffect(() => {
    document.documentElement.lang = locale();
  });
  return { t, locale, setLocale, available: REGISTRY };
}

export type I18nApi = ReturnType<typeof createI18n>;

// Fallback used when useI18n() is called outside <I18nProvider> — chiefly in unit
// tests that render a single component without mounting the provider. It builds a
// static English translator from the bundled dictionary, so tests keep asserting on
// English text without wrapping every render. In the running app, main.tsx always
// mounts <I18nProvider>, so this path is never hit in production.
const fallbackApi: I18nApi = (() => {
  const enFlat = i18n.flatten(enDict);
  const t = i18n.translator((): Dictionary => enFlat, i18n.resolveTemplate);
  return { t, locale: () => 'en', setLocale: () => {}, available: REGISTRY };
})();
let warnedMissingProvider = false;

const I18nContext = createContext<I18nApi | undefined>();

export function I18nProvider(props: { children: JSX.Element }): JSX.Element {
  const api = createI18n();
  return (
    <I18nContext.Provider value={api}>
      <Suspense fallback={null}>{props.children}</Suspense>
    </I18nContext.Provider>
  );
}

/**
 * Access the i18n API. Outside <I18nProvider> (e.g. in unit tests) it returns a
 * static English fallback translator instead of throwing.
 */
export function useI18n(): I18nApi {
  const api = useContext(I18nContext);
  if (api) return api;
  if (!warnedMissingProvider) {
    warnedMissingProvider = true;
    // eslint-disable-next-line no-console
    console.warn('useI18n() called outside <I18nProvider>; falling back to English.');
  }
  return fallbackApi;
}
