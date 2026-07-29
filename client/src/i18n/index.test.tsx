import { describe, it, expect } from 'vitest';
import * as i18n from '@solid-primitives/i18n';
import { render } from '@solidjs/testing-library';
import { useI18n, normalizeLocale, REGISTRY, LOCALES, I18nProvider } from './index.js';
import { dict } from './locales/en/index.js';

describe('normalizeLocale', () => {
  it('returns a known locale unchanged', () => {
    expect(normalizeLocale('en')).toBe('en');
  });

  it('falls back to English for an unshipped locale', () => {
    // German isn't in LOCALES yet (only English ships for now).
    expect(normalizeLocale('de')).toBe('en');
  });

  it('falls back to English for garbage and undefined', () => {
    expect(normalizeLocale('xyz')).toBe('en');
    expect(normalizeLocale(undefined)).toBe('en');
  });
});

describe('locale registry', () => {
  it('every registry entry has a code that is a known Locale', () => {
    for (const entry of REGISTRY) {
      expect((LOCALES as readonly string[]).includes(entry.code)).toBe(true);
      expect(entry.nativeName.length).toBeGreaterThan(0);
    }
  });

  it('ships at least English', () => {
    expect(REGISTRY.some((e) => e.code === 'en')).toBe(true);
  });
});

describe('fallback translator (no <I18nProvider>)', () => {
  // useI18n() outside a provider returns a static English translator built from
  // the bundled dictionary — this is what component unit tests rely on.
  const { t } = useI18n();

  it('resolves a known key to its English value', () => {
    expect(t('common.close')).toBe('Close');
    expect(t('settings.title')).toBe('Settings');
  });

  it('interpolates {{ placeholders }}', () => {
    expect(t('hotswap.openCharacter', { name: 'Bob' })).toBe('Open Bob');
  });
});

describe('real <I18nProvider>', () => {
  // state.settings.language defaults to 'en' (AppSettingsSchema.parse({})), so the
  // provider resolves the bundled English dictionary and sets <html lang>.
  it('resolves keys through the mounted provider and sets <html lang>', async () => {
    const Consumer = () => {
      const { t } = useI18n();
      return <span>{t('common.close')}</span>;
    };
    const { findByText } = render(() => (
      <I18nProvider>
        <Consumer />
      </I18nProvider>
    ));
    expect(await findByText('Close')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('composed dictionary', () => {
  it('flattens to dot-path keys', () => {
    const flat = i18n.flatten(dict);
    expect(flat['common.save']).toBe('Save');
    expect(typeof flat['settings.title']).toBe('string');
  });

  it('exposes keys from every domain fragment', () => {
    const flat = i18n.flatten(dict);
    // One representative key per domain — guards against a fragment being
    // accidentally dropped from the compose.
    const samples = [
      'common.save',
      'app.dropFilesToAttach',
      'settings.title',
      'sidebar.characters',
      'messageInput.send',
      'backendConfig.provider',
    ];
    for (const key of samples) {
      expect(flat[key], `expected key "${key}" to exist`).not.toBeUndefined();
    }
  });
});
