import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseLogitBias,
  formatLogitBias,
  splitStopStrings,
  buildAdvancedProviderParams,
  buildProviderParams,
  seedAdvancedParams,
  fetchModelList,
  extractOpenRouterProviders,
  filterModelsByProvider,
} from './backendConfig.js';
import type { SamplerKnob } from '../components/samplerProfiles.js';

function knob(overrides: Partial<SamplerKnob> & { wireName: string }): SamplerKnob {
  return {
    id: overrides.wireName,
    labelKey: overrides.wireName,
    type: 'number',
    group: 'samplers',
    serialize: 'raw',
    ...overrides,
  };
}

describe('parseLogitBias', () => {
  it('parses token:bias lines', () => {
    expect(parseLogitBias('1234:-10\nhello:2.5')).toEqual({ '1234': -10, hello: 2.5 });
  });

  it('trims whitespace around tokens, biases, and lines', () => {
    expect(parseLogitBias('  1234 : -10  \n\n  \nfoo: 1')).toEqual({ '1234': -10, foo: 1 });
  });

  it('returns null for empty or fully-invalid input', () => {
    expect(parseLogitBias('')).toBeNull();
    expect(parseLogitBias('\n  \n')).toBeNull();
    expect(parseLogitBias('no-colon-line\n: 5\nbad:number')).toBeNull();
  });

  it('skips lines whose bias is not numeric (including multi-colon lines)', () => {
    // 'a:1:2' parses bias from '1:2' → NaN → skipped.
    expect(parseLogitBias('a:1:2\nb:3')).toEqual({ b: 3 });
  });

  it('lets the last duplicate token win', () => {
    expect(parseLogitBias('a:1\na:-2')).toEqual({ a: -2 });
  });
});

describe('formatLogitBias', () => {
  it('round-trips with parseLogitBias', () => {
    const parsed = parseLogitBias('1234:-10\nhello:2.5');
    expect(parsed).not.toBeNull();
    expect(parseLogitBias(formatLogitBias(parsed))).toEqual(parsed);
  });

  it('formats empty/unset as empty string', () => {
    expect(formatLogitBias(null)).toBe('');
    expect(formatLogitBias(undefined)).toBe('');
    expect(formatLogitBias({})).toBe('');
  });
});

describe('splitStopStrings', () => {
  it('splits on newlines, trims, and drops blanks', () => {
    expect(splitStopStrings('foo\n  bar  \n\n\nbaz qux')).toEqual(['foo', 'bar', 'baz qux']);
  });

  it('returns [] for empty input', () => {
    expect(splitStopStrings('')).toEqual([]);
    expect(splitStopStrings('\n \n')).toEqual([]);
  });
});

describe('buildAdvancedProviderParams', () => {
  const profile = [
    knob({ wireName: 'mirostat_mode' }),
    knob({ wireName: 'dry_sequence_breakers', type: 'list', serialize: 'jsonArray' }),
  ];

  it('carries over declared keys and drops undeclared ones', () => {
    const result = buildAdvancedProviderParams(
      { cacheTTL: '1h', 'legacy.junk': true, mirostat_mode: 2 },
      '',
      profile,
      {},
      {},
    );
    expect(result['cacheTTL']).toBe('1h');
    expect(result['legacy.junk']).toBeUndefined();
  });

  it('always sets requestScript', () => {
    const result = buildAdvancedProviderParams(undefined, '-- script', [], {}, {});
    expect(result['requestScript']).toBe('-- script');
  });

  it('serializes jsonArray knobs from newline text and drops empties', () => {
    const result = buildAdvancedProviderParams(
      undefined,
      '',
      profile,
      { dry_sequence_breakers: 'a\n b \n\n', mirostat_mode: '' },
      {},
    );
    expect(result['dry_sequence_breakers']).toEqual(['a', 'b']);
    expect(result['mirostat_mode']).toBeUndefined();
  });

  it('passes through array values for jsonArray knobs', () => {
    const result = buildAdvancedProviderParams(undefined, '', profile, { dry_sequence_breakers: ['\\n', '###'] }, {});
    expect(result['dry_sequence_breakers']).toEqual(['\\n', '###']);
  });

  it('drops null/undefined/empty-array knob values even when carried over', () => {
    const result = buildAdvancedProviderParams(
      { mirostat_mode: 2 },
      '',
      profile,
      { mirostat_mode: null, dry_sequence_breakers: [] },
      {},
    );
    expect(result['mirostat_mode']).toBeUndefined();
    expect(result['dry_sequence_breakers']).toBeUndefined();
  });

  it('keeps false and 0 as real values', () => {
    const result = buildAdvancedProviderParams(undefined, '', profile, { mirostat_mode: 0 }, {});
    expect(result['mirostat_mode']).toBe(0);
  });

  it('carries samplerDisabled only when non-empty', () => {
    const withDisabled = buildAdvancedProviderParams(undefined, '', [], {}, { topK: true });
    expect(withDisabled['samplerDisabled']).toEqual({ topK: true });
    const without = buildAdvancedProviderParams({ samplerDisabled: { topK: true } }, '', [], {}, {});
    expect(without['samplerDisabled']).toBeUndefined();
  });
});

describe('buildProviderParams', () => {
  const base = {
    existing: undefined,
    requestScript: '',
    profile: [] as SamplerKnob[],
    values: {},
    disabled: {},
    provider: 'openai',
    customBackendId: '',
    delegateConfigId: '',
    mockScript: '',
    cacheMode: 'off' as const,
    cacheDepth: 0,
    cacheTTL: '',
  };

  it('sets custom-provider keys only when selected', () => {
    const set = buildProviderParams({
      ...base,
      provider: 'custom',
      customBackendId: 'cb-1',
      delegateConfigId: 'cfg-2',
    });
    expect(set['customBackendId']).toBe('cb-1');
    expect(set['delegateConfigId']).toBe('cfg-2');
    const unset = buildProviderParams({ ...base, provider: 'custom', existing: { customBackendId: 'cb-1' } });
    expect(unset['customBackendId']).toBeUndefined();
    expect(unset['delegateConfigId']).toBeUndefined();
  });

  it('sets mockScript only for the mock provider when non-empty', () => {
    const mock = buildProviderParams({ ...base, provider: 'mock', mockScript: 'respond:hi' });
    expect(mock['mockScript']).toBe('respond:hi');
    const other = buildProviderParams({ ...base, provider: 'openai', mockScript: 'respond:hi' });
    expect(other['mockScript']).toBeUndefined();
  });

  it('writes cacheMode/cacheDepth/cacheTTL for claude; depth only in manual mode', () => {
    const manual = buildProviderParams({
      ...base,
      provider: 'claude',
      cacheMode: 'manual',
      cacheDepth: 3,
      cacheTTL: ' 1h ',
    });
    expect(manual['cacheMode']).toBe('manual');
    expect(manual['cacheDepth']).toBe(3);
    expect(manual['cacheTTL']).toBe('1h');

    const auto = buildProviderParams({ ...base, provider: 'claude', cacheMode: 'auto', cacheDepth: 3 });
    expect(auto['cacheMode']).toBe('auto');
    expect(auto['cacheDepth']).toBeUndefined();
  });

  it('drops mode/depth when off but keeps a set TTL', () => {
    const off = buildProviderParams({
      ...base,
      provider: 'claude',
      existing: { cacheMode: 'manual', cacheDepth: 3, cacheTTL: '1h' },
      cacheMode: 'off',
      cacheTTL: '1h',
    });
    expect(off['cacheMode']).toBeUndefined();
    expect(off['cacheDepth']).toBeUndefined();
    expect(off['cacheTTL']).toBe('1h');
  });

  it('leaves cache fields alone for non-caching providers (declared carry-over only)', () => {
    const result = buildProviderParams({
      ...base,
      provider: 'openai',
      existing: { cacheMode: 'manual', cacheTTL: '1h' },
      cacheMode: 'manual',
      cacheDepth: 2,
      cacheTTL: '1h',
    });
    // Declared keys carry over from existing regardless of provider; the
    // cacheMode/cacheDepth/cacheTTL writes only happen for claude/openrouter.
    expect(result['cacheMode']).toBe('manual');
    expect(result['cacheTTL']).toBe('1h');
    expect(result['cacheDepth']).toBeUndefined();
  });
});

describe('seedAdvancedParams', () => {
  const profile = [knob({ wireName: 'mirostat_mode', default: 0 }), knob({ wireName: 'seed', default: -1 })];

  it('keeps explicitly-set knobs enabled and at their stored value', () => {
    const { values, disabled } = seedAdvancedParams({ mirostat_mode: 2 }, profile);
    expect(values['mirostat_mode']).toBe(2);
    expect(disabled['mirostat_mode']).toBeUndefined();
  });

  it('seeds unset knobs with their default and disables them', () => {
    const { values, disabled } = seedAdvancedParams({}, profile);
    expect(values['seed']).toBe(-1);
    expect(disabled['seed']).toBe(true);
  });

  it('merges an existing samplerDisabled record', () => {
    const { disabled } = seedAdvancedParams({ samplerDisabled: { topK: true } }, profile);
    expect(disabled['topK']).toBe(true);
    expect(disabled['mirostat_mode']).toBe(true); // unset knob
  });
});

describe('model listing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchModelList returns items on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ id: 'm1', name: 'M1' }] }) }),
    );
    await expect(fetchModelList()).resolves.toEqual([{ id: 'm1', name: 'M1' }]);
  });

  it('fetchModelList returns [] when items is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(fetchModelList()).resolves.toEqual([]);
  });

  it('fetchModelList throws with the HTTP status on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(fetchModelList()).rejects.toThrow('HTTP 503');
  });

  it('extractOpenRouterProviders collects unique sorted prefixes', () => {
    const models = [
      { id: 'openai/gpt-4o', name: 'GPT' },
      { id: 'anthropic/claude', name: 'Claude' },
      { id: 'openai/gpt-4o-mini', name: 'GPT mini' },
      { id: 'local-model', name: 'Local' },
      { id: '/leading-slash', name: 'Weird' },
    ];
    expect(extractOpenRouterProviders(models)).toEqual(['anthropic', 'openai']);
  });

  it("filterModelsByProvider filters by prefix; '' disables the filter", () => {
    const models = [
      { id: 'openai/gpt-4o', name: 'GPT' },
      { id: 'anthropic/claude', name: 'Claude' },
    ];
    expect(filterModelsByProvider(models, 'openai')).toEqual([{ id: 'openai/gpt-4o', name: 'GPT' }]);
    expect(filterModelsByProvider(models, '')).toEqual(models);
  });
});
