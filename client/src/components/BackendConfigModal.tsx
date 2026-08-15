import { createSignal, Show, For, createEffect, onMount, onCleanup, untrack } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { activeBackendConfigId, setActiveBackendConfigId } from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { confirmPopup, alertPopup } from '../stores/popupStore.js';
import { apiFetch } from '../lib/apiFetch.js';
import { IdBadge } from './IdBadge.js';
import { str } from '../lib/coerce.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../timing.js';
import { getSamplerProfile, type SamplerKnob } from './samplerProfiles.js';
import { isDeclaredProviderParamKey, type AppSettings } from '@tamari/types';
import { SecretPicker } from './SecretPicker.js';
import './BackendConfigModal.css';

function parseLogitBias(text: string): Record<string, number> | null {
  const result: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [rawToken, ...rest] = trimmed.split(':');
    if (rawToken === undefined || rest.length === 0) continue;
    const token = rawToken.trim();
    const biasStr = rest.join(':').trim();
    const bias = Number(biasStr);
    if (token && !isNaN(bias)) {
      result[token] = bias;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function formatLogitBias(bias: Record<string, number> | null | undefined): string {
  if (!bias) return '';
  return Object.entries(bias)
    .map(([k, v]) => `${k}:${v}`)
    .join('\n');
}

/**
 * Build the `providerParams` patch for saveConfig: only DECLARED keys survive
 * (@tamari/types providerParams contract) — structural keys are carried over from
 * the existing config, requestScript is always set, and for each rendered
 * advanced knob serialize its value — dropping it when empty/unset so unset
 * knobs do not pollute the request body. Checkboxes send only when true.
 * Undeclared keys (e.g. legacy v1 settings dumps) are NOT preserved; the
 * server repo sanitizes on write too, so they never come back.
 * Carries the per-knob `samplerDisabled` record (typed camelCase + advanced wire
 * keys) so the server can omit disabled samplers from the request.
 */
function buildAdvancedProviderParams(
  existing: Record<string, unknown> | undefined,
  requestScriptValue: string,
  profile: SamplerKnob[],
  values: Record<string, unknown>,
  disabled: Record<string, true>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Carry over declared keys only (structural + escape-hatch params like cacheTTL
  // that the modal doesn't render); undeclared junk is dropped for good.
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (isDeclaredProviderParamKey(key)) result[key] = value;
  }
  result['requestScript'] = requestScriptValue;
  for (const knob of profile) {
    const raw = values[knob.wireName];
    const serialized =
      knob.serialize === 'jsonArray'
        ? Array.isArray(raw)
          ? raw
          : typeof raw === 'string'
            ? raw.split('\n').map((s) => s.trim()).filter(Boolean)
            : []
        : raw;
    const isEmpty =
      serialized === null ||
      serialized === undefined ||
      serialized === '' ||
      (Array.isArray(serialized) && serialized.length === 0);
    if (isEmpty) {
      delete result[knob.wireName];
    } else {
      result[knob.wireName] = serialized;
    }
  }
  if (Object.keys(disabled).length > 0) {
    result['samplerDisabled'] = disabled;
  } else {
    delete result['samplerDisabled'];
  }
  return result;
}

export function BackendConfigModal(props: { onClose: () => void }) {
  const { t } = useI18n();
  // t() narrows literal keys to string but returns `unknown` for dynamically-built
  // key paths (@solid-primitives/i18n); coerce the advanced-sampler lookups.
  const td = (key: string): string => t(key) as string;
  const activeBackendConfig = () => state.activeBackendConfig;

  // Editor signals (initialized from active config)
  const [configName, setConfigName] = createSignal(activeBackendConfig()?.name ?? 'Default');
  const [backendProvider, setBackendProvider] = createSignal(activeBackendConfig()?.backendProvider ?? 'openai');
  const [model, setModel] = createSignal(activeBackendConfig()?.model ?? 'gpt-3.5-turbo');
  const [generationMode, setGenerationMode] = createSignal(activeBackendConfig()?.generationMode ?? 'chat');
  const [temperature, setTemperature] = createSignal(activeBackendConfig()?.temperature ?? 1);
  const [maxTokens, setMaxTokens] = createSignal(activeBackendConfig()?.maxTokens ?? 300);
  const [topP, setTopP] = createSignal(activeBackendConfig()?.topP ?? 1);
  const [topK, setTopK] = createSignal(activeBackendConfig()?.topK ?? null);
  const [minP, setMinP] = createSignal(activeBackendConfig()?.minP ?? null);
  const [topA, setTopA] = createSignal(activeBackendConfig()?.topA ?? null);
  const [repetitionPenalty, setRepetitionPenalty] = createSignal(activeBackendConfig()?.repetitionPenalty ?? null);
  const [frequencyPenalty, setFrequencyPenalty] = createSignal(activeBackendConfig()?.frequencyPenalty ?? null);
  const [presencePenalty, setPresencePenalty] = createSignal(activeBackendConfig()?.presencePenalty ?? null);
  const [contextLength, setContextLength] = createSignal(activeBackendConfig()?.contextLength ?? 4096);
  const [promptHistoryLimit, setPromptHistoryLimit] = createSignal(activeBackendConfig()?.promptHistoryLimit ?? 50);
  const [instructTemplate, setInstructTemplate] = createSignal(activeBackendConfig()?.instructTemplate ?? '');
  const [stopStrings, setStopStrings] = createSignal((activeBackendConfig()?.stopStrings ?? []).join('\n'));
  const [reasoningAddToPrompts, setReasoningAddToPrompts] = createSignal(
    Boolean(state.settings['reasoningAddToPrompts']),
  );
  const [openrouterReasoningEffort, setOpenrouterReasoningEffort] = createSignal(
    state.settings['openrouter.reasoningEffort'] ?? '',
  );
  const [openrouterReasoningSummary, setOpenrouterReasoningSummary] = createSignal(
    state.settings['openrouter.reasoningSummary'] ?? '',
  );
  const [requestScript, setRequestScript] = createSignal(
    str(
      activeBackendConfig()?.providerParams?.['requestScript'] ??
        activeBackendConfig()?.providerParams?.['custom.requestScript'],
    ),
  );
  // `custom` provider (Lua-driven adapters): which registry script runs and
  // which backend config the script delegates to by default. Stored in
  // providerParams; '' means unset (delegate falls back to the active backend
  // at generation time).
  const [customBackendId, setCustomBackendId] = createSignal(
    str(activeBackendConfig()?.providerParams?.['customBackendId']),
  );
  const [delegateConfigId, setDelegateConfigId] = createSignal(
    str(activeBackendConfig()?.providerParams?.['delegateConfigId']),
  );
  // `mock` provider: the inline canned-response script (providerParams.mockScript).
  const [mockScript, setMockScript] = createSignal(str(activeBackendConfig()?.providerParams?.['mockScript']));
  // Prompt caching for the claude/openrouter providers: providerParams.cacheMode
  // ('off' | 'auto' | 'manual'), cacheDepth (manual mode only) and cacheTTL —
  // consumed server-side by ChatPromptAssembly and the adapters, never sent as
  // sampler params (cacheMode/cacheDepth are structural providerParams keys).
  const initialCacheMode = activeBackendConfig()?.providerParams?.['cacheMode'];
  const [cacheMode, setCacheMode] = createSignal<'off' | 'auto' | 'manual'>(
    initialCacheMode === 'auto' || initialCacheMode === 'manual' ? initialCacheMode : 'off',
  );
  const [cacheDepth, setCacheDepth] = createSignal(Number(activeBackendConfig()?.providerParams?.['cacheDepth'] ?? 0));
  const [cacheTTL, setCacheTTL] = createSignal(str(activeBackendConfig()?.providerParams?.['cacheTTL']));
  const [logitBias, setLogitBias] = createSignal(formatLogitBias(activeBackendConfig()?.logitBias));
  const [openrouterProvider, setOpenrouterProvider] = createSignal(activeBackendConfig()?.openrouterProvider ?? '');
  const [apiUrl, setApiUrl] = createSignal(activeBackendConfig()?.apiUrl ?? '');
  const [apiKey, setApiKey] = createSignal(activeBackendConfig()?.apiKey ?? '');
  const [supportsImages, setSupportsImages] = createSignal(activeBackendConfig()?.supportsImages ?? true);
  const [supportsAudio, setSupportsAudio] = createSignal(activeBackendConfig()?.supportsAudio ?? true);
  const [supportsVideo, setSupportsVideo] = createSignal(activeBackendConfig()?.supportsVideo ?? true);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  /** True once loadConfigData has run at least once this session. A whole-form
      save before then would write defaults over the real config — saveConfig
      refuses until the form has seen server values. */
  const [formLoaded, setFormLoaded] = createSignal(false);
  const [loadedConfigId, setLoadedConfigId] = createSignal<string | null>(null);

  // Advanced sampler knobs (provider-gated) — stored in providerParams.
  const [advancedParams, setAdvancedParams] = createSignal<Record<string, unknown>>({});
  const activeProfile = () => getSamplerProfile(backendProvider(), generationMode());
  const setAdvanced = (wireName: string, value: unknown) => {
    setAdvancedParams((p) => ({ ...p, [wireName]: value }));
    setDirty(true);
  };
  const advancedValue = (knob: SamplerKnob): string => {
    const v = advancedParams()[knob.wireName];
    if (v === undefined || v === null) return '';
    if (knob.serialize === 'jsonArray' && Array.isArray(v)) return v.join('\n');
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  };

  // Per-knob disable record (providerParams.samplerDisabled): a knob listed here
  // is kept on the config but NOT sent — e.g. a model that dropped top_k. Keys
  // are camelCase for typed knobs, wire-name for advanced knobs. Sparse.
  const [samplerDisabled, setSamplerDisabled] = createSignal<Record<string, true>>({});
  const isSamplerDisabled = (id: string): boolean => Boolean(samplerDisabled()[id]);
  const setSamplerEnabled = (id: string, enabled: boolean) => {
    setSamplerDisabled((prev) => {
      if (enabled) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: true };
    });
    setDirty(true);
  };

  // 3-state radio for boolean knobs: omit (not sent) / on (true) / off (false).
  const knobState = (wireName: string): 'omit' | 'on' | 'off' => {
    if (isSamplerDisabled(wireName) || advancedParams()[wireName] === undefined) return 'omit';
    return advancedParams()[wireName] === true ? 'on' : 'off';
  };
  const setKnobState = (wireName: string, state: 'omit' | 'on' | 'off') => {
    setSamplerDisabled((prev) => {
      if (state === 'omit') return { ...prev, [wireName]: true };
      const next = { ...prev };
      delete next[wireName];
      return next;
    });
    setAdvancedParams((prev) => {
      if (state === 'omit') {
        const next = { ...prev };
        delete next[wireName];
        return next;
      }
      return { ...prev, [wireName]: state === 'on' };
    });
    setDirty(true);
  };

  // Model listing. fetchSeq makes out-of-order responses harmless: only the
  // latest request may write results, so a list fetched for the previous
  // config never repopulates the picker after a config switch.
  const [availableModels, setAvailableModels] = createSignal<
    Array<{ id: string; name: string; contextLength?: number }>
  >([]);
  const [modelsLoading, setModelsLoading] = createSignal(false);
  const [modelsFailed, setModelsFailed] = createSignal(false);
  let fetchSeq = 0;

  const fetchModels = async () => {
    const seq = ++fetchSeq;
    setModelsLoading(true);
    setModelsFailed(false);
    try {
      const res = await apiFetch('/api/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: Array<{ id: string; name: string; contextLength?: number }> };
      if (seq !== fetchSeq) return;
      setAvailableModels(data.items ?? []);
    } catch (err) {
      if (seq !== fetchSeq) return;
      console.error('[BackendConfigModal] Model listing failed:', err);
      setModelsFailed(true);
      setAvailableModels([]);
    } finally {
      if (seq === fetchSeq) setModelsLoading(false);
    }
  };

  // Extract OpenRouter providers from model IDs
  const openrouterProviders = () => {
    const providers = new Set<string>();
    for (const m of availableModels()) {
      const slashIdx = m.id.indexOf('/');
      if (slashIdx > 0) providers.add(m.id.slice(0, slashIdx));
    }
    return Array.from(providers).sort();
  };

  const filteredModels = () => {
    if (!openrouterProvider()) return availableModels();
    return availableModels().filter((m) => m.id.startsWith(openrouterProvider() + '/'));
  };

  createEffect(() => {
    backendProvider();
    void fetchModels();
  });

  onMount(() => {
    saveFocus();
    // Cheap — keeps the `custom` provider dropdown populated even when the
    // Custom Backends modal was never opened this session.
    bus.send({ type: 'custombackend.list' });
  });

  // Select the active config reactively. The initial state snapshot can land
  // after this modal mounts (open it right after login on a fresh install):
  // without waiting for it, there is no config to save against and every
  // edit is silently dropped. Once state populates, select the configured
  // (or first available) config so the form always has a real target.
  createEffect(() => {
    if (loadedConfigId()) return;
    const configId = state.settings['activeBackendConfigId'] ?? state.backendConfigs[0]?.id;
    if (!configId) return;
    const id = String(configId);
    setActiveBackendConfigId(id);
    bus.send({ type: 'backendConfig.select', backendConfigId: id });
  });

  const PROVIDERS_BY_MODE: Record<'chat' | 'text', Array<{ value: string; label: string }>> = {
    chat: [
      { value: 'openai', label: 'OpenAI' },
      { value: 'openrouter', label: 'OpenRouter' },
      { value: 'claude', label: 'Claude' },
      { value: 'gemini', label: 'Gemini' },
      { value: 'custom', label: 'Custom (Lua)' },
      { value: 'mock', label: 'Mock (deterministic)' },
    ],
    text: [
      { value: 'openai', label: 'OpenAI' },
      { value: 'llamacpp', label: 'llama.cpp' },
      { value: 'tabbyapi', label: 'TabbyAPI' },
      { value: 'koboldcpp', label: 'KoboldCPP' },
      { value: 'mock', label: 'Mock (deterministic)' },
    ],
  };

  const API_URLS: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    openai: 'https://api.openai.com/v1',
    claude: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    llamacpp: 'http://localhost:8080',
    tabbyapi: 'http://localhost:5000',
    koboldcpp: 'http://localhost:5001',
  };

  const validateProviderForMode = (mode: 'chat' | 'text', currentProvider: string) => {
    const valid = PROVIDERS_BY_MODE[mode].some((p) => p.value === currentProvider);
    if (!valid) {
      const fallback = PROVIDERS_BY_MODE[mode][0]!;
      setBackendProvider(fallback.value);
      return fallback.value;
    }
    return currentProvider;
  };

  const loadConfigData = (config: NonNullable<typeof state.activeBackendConfig>) => {
    // A different config means a different model list: drop the previous
    // config's list (and failure state) so the picker falls back to the text
    // input with this config's model until the fresh fetch lands — otherwise
    // the <select> renders the old list with no valid selection. The initial
    // load skips the refetch (the mount effect above already covers it).
    const prevConfigId = untrack(loadedConfigId);
    if (prevConfigId !== config.id) {
      setAvailableModels([]);
      setModelsFailed(false);
      if (prevConfigId !== null) void fetchModels();
    }
    setConfigName(config.name);
    setModel(config.model);
    setGenerationMode(config.generationMode);
    const provider = validateProviderForMode(config.generationMode, config.backendProvider);
    setBackendProvider(provider);
    setTemperature(config.temperature ?? 1);
    setMaxTokens(config.maxTokens ?? 300);
    setTopP(config.topP ?? 1);
    setTopK(config.topK ?? null);
    setMinP(config.minP ?? null);
    setTopA(config.topA ?? null);
    setRepetitionPenalty(config.repetitionPenalty ?? null);
    setFrequencyPenalty(config.frequencyPenalty ?? null);
    setPresencePenalty(config.presencePenalty ?? null);
    setContextLength(config.contextLength ?? 4096);
    setPromptHistoryLimit(config.promptHistoryLimit ?? 50);
    setInstructTemplate(config.instructTemplate ?? '');
    setStopStrings((config.stopStrings ?? []).join('\n'));
    setRequestScript(
      str(config.providerParams?.['requestScript'] ?? config.providerParams?.['custom.requestScript']),
    );
    setCustomBackendId(str(config.providerParams?.['customBackendId']));
    setDelegateConfigId(str(config.providerParams?.['delegateConfigId']));
    setMockScript(str(config.providerParams?.['mockScript']));
    const configCacheMode = config.providerParams?.['cacheMode'];
    setCacheMode(configCacheMode === 'auto' || configCacheMode === 'manual' ? configCacheMode : 'off');
    setCacheDepth(Number(config.providerParams?.['cacheDepth'] ?? 0));
    setCacheTTL(str(config.providerParams?.['cacheTTL']));
    setLogitBias(formatLogitBias(config.logitBias));
    setOpenrouterProvider(config.openrouterProvider ?? '');
    setApiUrl(config.apiUrl ?? '');
    setApiKey(config.apiKey ?? '');
    setSupportsImages(config.supportsImages ?? true);
    setSupportsAudio(config.supportsAudio ?? true);
    setSupportsVideo(config.supportsVideo ?? true);
    // Seed advanced knobs: knobs the user explicitly set (in providerParams) keep
    // their value + enabled state. Knobs NOT in providerParams get a real default
    // value (for display) and are disabled (not sent) until the user enables them.
    const pp = { ...config.providerParams };
    const existingDisabled = (pp['samplerDisabled'] as Record<string, true> | undefined) ?? {};
    const profile = getSamplerProfile(provider, config.generationMode);
    const seeded: Record<string, unknown> = { ...pp };
    const disabled: Record<string, true> = {};
    for (const knob of profile) {
      const wasSet = knob.wireName in pp;
      if (!wasSet && knob.default !== undefined) {
        seeded[knob.wireName] = knob.default;
      }
      if (!wasSet) {
        disabled[knob.wireName] = true;
      }
    }
    setAdvancedParams(seeded);
    setSamplerDisabled({ ...existingDisabled, ...disabled });
    setFormLoaded(true);
  };

  // Refresh editor fields from the active config whenever it changes and the
  // user is not mid-edit: config switches, the first backendConfig.snapshot
  // of the session, and save round-trips from OTHER clients. The dirty()
  // guard applies only AFTER the first load — a first snapshot always loads,
  // even if the user already typed: an edit made against unloaded defaults
  // cannot be merged into a whole-form save (every untouched field would be
  // a default), so showing the real values is the only safe move. Own save
  // round-trips are skipped: the store applied the canonical config, but the
  // form already holds these values — reloading would only churn the DOM.
  createEffect(() => {
    const config = state.activeBackendConfig;
    if (!config) return;
    if (formLoaded() && dirty()) return;
    if (loadedConfigId() === config.id && state.activeBackendConfigOrigin === state.clientId) return;
    loadConfigData(config);
    setLoadedConfigId(config.id);
  });

  const customTemplates = () => {
    const raw = state.settings['instructTemplates'];
    if (!Array.isArray(raw)) return [] as Array<{ id: string; name: string }>;
    return raw
      .filter((tpl): tpl is Record<string, unknown> => typeof tpl === 'object' && tpl !== null)
      .map((tpl) => ({ id: str(tpl['id']), name: str(tpl['name'] ?? tpl['id']) }))
      .filter((tpl) => tpl.id);
  };

  const switchConfig = (configId: string) => {
    // Flush pending edits against the OLD config first — setDirty(false)
    // below would cancel the debounce timer and silently drop them.
    if (dirty()) saveConfig();
    setActiveBackendConfigId(configId);
    bus.send({ type: 'settings.set', key: 'activeBackendConfigId', value: configId });
    bus.send({ type: 'backendConfig.select', backendConfigId: configId });
    setDirty(false);
  };

  /**
   * providerParams for save/create: advanced sampler knobs (existing keys
   * preserved) plus, for the `custom` provider, the selected Lua script and
   * its default delegate. Empty selections drop the key so the server falls
   * back to the active backend at generation time.
   */
  const buildProviderParams = (existing: Record<string, unknown> | undefined): Record<string, unknown> => {
    const params = buildAdvancedProviderParams(
      existing,
      requestScript(),
      activeProfile(),
      advancedParams(),
      samplerDisabled(),
    );
    if (backendProvider() === 'custom') {
      if (customBackendId()) params['customBackendId'] = customBackendId();
      else delete params['customBackendId'];
      if (delegateConfigId()) params['delegateConfigId'] = delegateConfigId();
      else delete params['delegateConfigId'];
    }
    if (backendProvider() === 'mock') {
      if (mockScript()) params['mockScript'] = mockScript();
      else delete params['mockScript'];
    }
    if (backendProvider() === 'claude' || backendProvider() === 'openrouter') {
      // Off mode drops the keys entirely; an absent cacheMode reads as 'off'
      // server-side. cacheDepth is only meaningful in manual mode.
      if (cacheMode() !== 'off') params['cacheMode'] = cacheMode();
      else delete params['cacheMode'];
      if (cacheMode() === 'manual' && cacheDepth() > 0) params['cacheDepth'] = cacheDepth();
      else delete params['cacheDepth'];
      if (cacheTTL().trim()) params['cacheTTL'] = cacheTTL().trim();
      else delete params['cacheTTL'];
    }
    return params;
  };

  const saveConfig = () => {
    // Never save an unloaded form: the whole-form patch would write defaults
    // over every field the user didn't touch.
    if (!formLoaded()) return;
    const config = activeBackendConfig();
    // Fall back to the selected id when the backendConfig.snapshot for this
    // session hasn't landed yet — otherwise early edits are silently dropped.
    const configId = config?.id ?? activeBackendConfigId();
    if (!configId) return;
    setSaving(true);
    bus.send({
      type: 'backendConfig.update',
      backendConfigId: configId,
      patch: {
        name: configName(),
        backendProvider: backendProvider(),
        model: model(),
        generationMode: generationMode(),
        temperature: temperature(),
        maxTokens: maxTokens(),
        topP: topP(),
        topK: topK(),
        minP: minP(),
        topA: topA(),
        repetitionPenalty: repetitionPenalty(),
        frequencyPenalty: frequencyPenalty(),
        presencePenalty: presencePenalty(),
        contextLength: contextLength(),
        promptHistoryLimit: promptHistoryLimit(),
        instructTemplate: instructTemplate(),
        stopStrings: stopStrings()
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        logitBias: parseLogitBias(logitBias()),
        providerParams: buildProviderParams(config?.providerParams),
        openrouterProvider: backendProvider() === 'openrouter' ? openrouterProvider() || null : null,
        apiUrl: apiUrl() || null,
        apiKey: apiKey() || null,
        supportsImages: supportsImages(),
        supportsAudio: supportsAudio(),
        supportsVideo: supportsVideo(),
      },
    });
    setTimeout(() => setSaving(false), 300);
  };

  // Auto-save config fields (debounced)
  createEffect(() => {
    if (!dirty()) return;
    configName();
    backendProvider();
    model();
    generationMode();
    temperature();
    maxTokens();
    topP();
    topK();
    minP();
    topA();
    repetitionPenalty();
    frequencyPenalty();
    presencePenalty();
    contextLength();
    promptHistoryLimit();
    instructTemplate();
    stopStrings();
    requestScript();
    customBackendId();
    delegateConfigId();
    mockScript();
    cacheMode();
    cacheDepth();
    cacheTTL();
    logitBias();
    openrouterProvider();
    apiUrl();
    apiKey();
    supportsImages();
    supportsAudio();
    supportsVideo();
    advancedParams();
    samplerDisabled();

    const timer = setTimeout(() => {
      saveConfig();
      setDirty(false);
    }, AUTOSAVE_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  // Auto-save settings fields immediately. The effect also fires on mount
  // with the initial values — those must NOT trigger writes (a settings.set
  // costs a DB write plus a settings.changed fan-out to every client), so
  // only send keys whose value actually changed.
  let prevReasoningAddToPrompts = reasoningAddToPrompts();
  let prevReasoningEffort = openrouterReasoningEffort();
  let prevReasoningSummary = openrouterReasoningSummary();
  createEffect(() => {
    const rp = reasoningAddToPrompts();
    const re = openrouterReasoningEffort();
    const rs = openrouterReasoningSummary();
    if (rp !== prevReasoningAddToPrompts) bus.send({ type: 'settings.set', key: 'reasoningAddToPrompts', value: rp });
    if (re !== prevReasoningEffort) bus.send({ type: 'settings.set', key: 'openrouter.reasoningEffort', value: re });
    if (rs !== prevReasoningSummary) bus.send({ type: 'settings.set', key: 'openrouter.reasoningSummary', value: rs });
    prevReasoningAddToPrompts = rp;
    prevReasoningEffort = re;
    prevReasoningSummary = rs;
  });

  const duplicateConfig = () => {
    const current = activeBackendConfig();
    const baseName = current?.name ?? 'Default';
    const name = t('backendConfig.copySuffix', { name: baseName });
    bus.send({
      type: 'backendConfig.create',
      data: {
        name,
        description: current?.description ?? '',
        backendProvider: backendProvider(),
        generationMode: generationMode(),
        model: model(),
        apiUrl: apiUrl() || null,
        apiKey: apiKey() || null,
        temperature: temperature(),
        maxTokens: maxTokens(),
        topP: topP(),
        topK: topK(),
        minP: minP(),
        topA: topA(),
        repetitionPenalty: repetitionPenalty(),
        frequencyPenalty: frequencyPenalty(),
        presencePenalty: presencePenalty(),
        contextLength: contextLength(),
        promptHistoryLimit: promptHistoryLimit(),
        instructTemplate: instructTemplate(),
        stopStrings: stopStrings()
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        providerParams: buildProviderParams(current?.providerParams),
        supportsImages: supportsImages(),
        supportsAudio: supportsAudio(),
        supportsVideo: supportsVideo(),
      },
    });
  };

  const deleteConfig = async () => {
    const config = activeBackendConfig();
    if (!config) return;
    if (state.backendConfigs.length <= 1) {
      await alertPopup(t('backendConfig.cannotDeleteLast'));
      return;
    }
    if (!(await confirmPopup(t('backendConfig.deleteConfirm', { name: config.name })))) return;
    // Cancel any pending debounced save — its target is about to disappear.
    // Letting it fire would error server-side or, worse, write the deleted
    // config's form values into the fallback config after the echo lands.
    setDirty(false);
    bus.send({ type: 'backendConfig.delete', backendConfigId: config.id });
  };

  // Helper to mark fields dirty on input
  const markDirty = (setter: (v: unknown) => void) => (value: unknown) => {
    setter(value);
    setDirty(true);
  };

  const close = () => {
    if (dirty()) saveConfig();
    restoreFocus();
    props.onClose();
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label={t('backendConfig.ariaLabel')} data-form-loaded={formLoaded() ? 'true' : 'false'} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <h2 class="modal-title">{t('backendConfig.title')} {saving() && <span class="text-sm text-muted">{t('backendConfig.saving')}</span>}</h2>

        {/* Config Selector */}
        <section class="settings-section">
          <h3 class="section-title">{t('backendConfig.activeSection')}</h3>
          <label class="field-label">
            {t('backendConfig.configLabel')}
            <select class="select" value={activeBackendConfigId() ?? ''} onChange={(e) => switchConfig(e.currentTarget.value)}>
              <For each={state.backendConfigs}>
                {(config) => (
                  <option class="select-option" id={config.id} value={config.id}>
                    {config.name}
                  </option>
                )}
              </For>
            </select>
          </label>

          <Show when={activeBackendConfigId()}>
            {(id) => <IdBadge id={id()} />}
          </Show>

          <div class="preset-actions">
            <button class="btn btn-ghost" onClick={duplicateConfig} type="button">
              <i class="bi bi-copy" /> {t('backendConfig.duplicateConfig')}
            </button>
            <button class="btn btn-danger" onClick={deleteConfig} type="button">
              {t('backendConfig.deleteConfig')}
            </button>
          </div>
        </section>

        {/* Config Editor */}
        <section class="settings-section">
          <h3 class="section-title">{t('backendConfig.editing', { name: configName() })}</h3>
          <label class="field-label">
            {t('common.name')}
            <input class="input" value={configName()} onInput={(e) => markDirty(setConfigName)(e.currentTarget.value)} />
          </label>
          <label class="field-label">
            {t('backendConfig.generationMode')}
            <select
              class="select"
              value={generationMode()}
              onChange={(e) => {
                const mode = e.currentTarget.value as 'chat' | 'text';
                markDirty(setGenerationMode)(mode);
                validateProviderForMode(mode, backendProvider());
              }}
            >
              <option class="select-option" value="chat">{t('backendConfig.generationModeChat')}</option>
              <option class="select-option" value="text">{t('backendConfig.generationModeText')}</option>
            </select>
          </label>
          <label class="field-label">
            {t('backendConfig.provider')}
            <select
              class="select"
              value={backendProvider()}
              onChange={(e) => {
                const provider = e.currentTarget.value;
                setBackendProvider(provider);
                setDirty(true);
              }}
            >
              <For each={PROVIDERS_BY_MODE[generationMode()]}>{(p) => <option class="select-option" id={p.value} value={p.value}>{p.label}</option>}</For>
            </select>
          </label>
          <Show when={!['custom', 'mock'].includes(backendProvider())}>
          <label class="field-label">
            {t('backendConfig.apiUrl')}
            <input
              class="input"
              value={apiUrl()}
              onInput={(e) => {
                setApiUrl(e.currentTarget.value);
                setDirty(true);
              }}
              placeholder={API_URLS[backendProvider()] ?? 'https://...'}
            />
          </label>
          <label class="field-label">
            {t('backendConfig.apiKey')}
            <span class="flex-row-sm">
              <input
                class="input flex-1 min-w-0"
                type="password"
                value={apiKey()}
                onInput={(e) => {
                  setApiKey(e.currentTarget.value);
                  setDirty(true);
                }}
                placeholder="sk-..."
              />
              <SecretPicker onPick={(ref) => { setApiKey(ref); setDirty(true); }} />
            </span>
          </label>
          </Show>
          <Show when={backendProvider() === 'mock'}>
            <label class="field-label">
              {t('backendConfig.mockScript')}
              <textarea
                value={mockScript()}
                onInput={(e) => markDirty(setMockScript)(e.currentTarget.value)}
                placeholder={'respond:Hello there.\nseq:2:A reply just for the second call.\ntool:get_weather:{"city":"Paris"}'}
                rows={6}
                class="font-mono text-sm resize-v"
              />
              <span class="hint-text">{t('backendConfig.mockScriptHint')}</span>
            </label>
          </Show>
          <Show when={backendProvider() === 'custom'}>
            <label class="field-label">
              {t('customBackends.providerSection')}
              <select
                class="select"
                value={customBackendId()}
                onChange={(e) => markDirty(setCustomBackendId)(e.currentTarget.value)}
              >
                <option class="select-option" value="">{t('customBackends.selectBackend')}</option>
                <For each={state.customBackends}>
                  {(b) => <option class="select-option" id={b.id} value={b.id}>{b.name}</option>}
                </For>
              </select>
              <Show when={state.customBackends.length === 0}>
                <span class="hint-text">{t('customBackends.noneAvailable')}</span>
              </Show>
            </label>
            <label class="field-label">
              {t('customBackends.delegateBackend')}
              <select
                class="select"
                value={delegateConfigId()}
                onChange={(e) => markDirty(setDelegateConfigId)(e.currentTarget.value)}
              >
                <option class="select-option" value="">{t('customBackends.delegateDefault')}</option>
                <For each={state.backendConfigs.filter((c) => c.id !== activeBackendConfigId())}>
                  {(c) => <option class="select-option" id={c.id} value={c.id}>{c.name}</option>}
                </For>
              </select>
              <span class="hint-text">{t('customBackends.delegateHint')}</span>
            </label>
          </Show>
          <Show when={backendProvider() === 'openrouter' && openrouterProviders().length > 0}>
            <label class="field-label">
              {t('backendConfig.openrouterProvider')}
              <select
                class="select"
                value={openrouterProvider()}
                onChange={(e) => {
                  const val = e.currentTarget.value;
                  markDirty(setOpenrouterProvider)(val);
                  if (val && !model().startsWith(val + '/')) {
                    markDirty(setModel)('');
                  }
                }}
              >
                <option class="select-option" value="">{t('backendConfig.allProviders')}</option>
                <For each={openrouterProviders()}>{(p, index) => <option class="select-option" id={`provider-${index()}`} value={p}>{p}</option>}</For>
              </select>
            </label>
          </Show>
          <label class="field-label">
            <div class="flex-row-sm justify-between">
              <span class="label-text">{t('backendConfig.model')}</span>
              <Show when={modelsLoading()}>
                <span class="text-xs text-muted">{t('common.loading')}</span>
              </Show>
            </div>
            <Show
              when={availableModels().length > 0 && !modelsFailed()}
              fallback={
                <div class="model-picker-row">
                  <input
                    class="input"
                    value={model()}
                    onInput={(e) => markDirty(setModel)(e.currentTarget.value)}
                    placeholder={modelsFailed() ? t('backendConfig.modelsFailedPlaceholder') : t('backendConfig.modelNamePlaceholder')}
                  />
                  <button
                    type="button"
                    class="icon-btn small"
                    onClick={fetchModels}
                    title={t('backendConfig.refreshModels')} aria-label={t('backendConfig.refreshModels')}
                    disabled={modelsLoading()}
                  >
                    <i class="bi bi-arrow-clockwise" />
                  </button>
                </div>
              }
            >
              <div class="model-picker-row">
                <select class="select" value={model()} onChange={(e) => markDirty(setModel)(e.currentTarget.value)}>
                  <option class="select-option" value="" disabled={!model()}>
                    {t('backendConfig.selectModel')}
                  </option>
                  <For each={filteredModels()}>
                    {(m) => (
                      <option class="select-option" id={m.id} value={m.id}>
                        {m.name}
                        {m.contextLength ? ` ${t('backendConfig.modelContextBadge', { n: m.contextLength.toLocaleString() })}` : ''}
                      </option>
                    )}
                  </For>
                </select>
                <button
                  type="button"
                  class="icon-btn small"
                  onClick={fetchModels}
                  title={t('backendConfig.refreshModels')} aria-label={t('backendConfig.refreshModels')}
                  disabled={modelsLoading()}
                >
                  <i class="bi bi-arrow-clockwise" />
                </button>
              </div>
            </Show>
          </label>
          <label class="field-label">
            {t('backendConfig.requestTransformer')}
            <textarea
              value={requestScript()}
              onInput={(e) => markDirty(setRequestScript)(e.currentTarget.value)}
              placeholder={`-- ${t('backendConfig.requestScriptHint')}\nrequest.headers['X-Custom-Auth'] = 'secret'\nrequest.body.temperature = 0.7`}
              rows={6}
              class="font-mono text-sm resize-v"
            />
          </label>
          <Show when={generationMode() === 'text'}>
            <label class="field-label">
              {t('backendConfig.instructTemplate')}
              <select
                class="select"
                value={instructTemplate()}
                onChange={(e) => markDirty(setInstructTemplate)(e.currentTarget.value)}
              >
                <option class="select-option" value="">{t('backendConfig.instructNone')}</option>
                <option class="select-option" value="alpaca">Alpaca</option>
                <option class="select-option" value="chatml">ChatML</option>
                <option class="select-option" value="deepseek-v4-pro">DeepSeek V4 Pro</option>
                <option class="select-option" value="deepseek-v4-pro-thinking">DeepSeek V4 Pro (Thinking)</option>
                <option class="select-option" value="gemma4">Gemma 4</option>
                <option class="select-option" value="gemma4-thinking">Gemma 4 (Thinking)</option>
                <option class="select-option" value="glm-5.1">GLM 5.1</option>
                <option class="select-option" value="glm-5.1-thinking">GLM 5.1 (Thinking)</option>
                <option class="select-option" value="granite-4.0">IBM Granite 4.0 / 4.1</option>
                <option class="select-option" value="kimi-k2.6">Kimi K2.6</option>
                <option class="select-option" value="kimi-k2.6-thinking">Kimi K2.6 (Thinking)</option>
                <option class="select-option" value="kimi-k3">Kimi K3</option>
                <option class="select-option" value="kimi-k3-thinking">Kimi K3 (Thinking)</option>
                <option class="select-option" value="llama2">Llama 2</option>
                <option class="select-option" value="llama3">Llama 3</option>
                <option class="select-option" value="llama4">Llama 4</option>
                <option class="select-option" value="minimax-text-01">MiniMax Text-01</option>
                <option class="select-option" value="mistral">Mistral</option>
                <option class="select-option" value="mistral-large-2411">Mistral Large 2411</option>
                <option class="select-option" value="mistral-nemo">Mistral Nemo</option>
                <option class="select-option" value="mistral-v0.1">Mistral v0.1</option>
                <option class="select-option" value="mistral-v0.3">Mistral v0.3</option>
                <option class="select-option" value="mistral-v3">Mistral v3</option>
                <option class="select-option" value="mistral-v3-thinking">Mistral v3 (Thinking)</option>
                <option class="select-option" value="nemotron-3">NVIDIA Nemotron 3</option>
                <option class="select-option" value="nemotron-3-thinking">NVIDIA Nemotron 3 (Thinking)</option>
                <option class="select-option" value="phi-4-mini">Phi-4 Mini</option>
                <option class="select-option" value="phi-4-reasoning-plus">Phi-4 Reasoning Plus</option>
                <option class="select-option" value="qwen3">Qwen 3</option>
                <option class="select-option" value="qwen3-thinking">Qwen 3 (Thinking)</option>
                <option class="select-option" value="qwen3.5">Qwen 3.5 / 3.6</option>
                <option class="select-option" value="qwen3.5-thinking">Qwen 3.5 / 3.6 (Thinking)</option>
                <For each={customTemplates()}>{(tpl) => <option class="select-option" id={tpl.id} value={tpl.id}>{tpl.name}</option>}</For>
              </select>
            </label>
          </Show>
          <h4 class="text-sm text-muted mb-0 mt-md">{t('backendConfig.samplingSection')}</h4>
          <div class="sampler-field">
            <label class="field-label" for="sampler-temperature">{t('backendConfig.temperature')}</label>
            <div class="sampler-input-group">
              <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                <input
                  class="checkbox-input"
                  type="checkbox"
                  checked={!isSamplerDisabled('temperature')}
                  onChange={(e) => setSamplerEnabled('temperature', e.currentTarget.checked)}
                  aria-label={t('backendConfig.samplerEnabled')}
                />
              </label>
              <input
                id="sampler-temperature"
                class="input sampler-value-input"
                type="number"
                step={0.1}
                min={0}
                max={2}
                value={temperature()}
                disabled={isSamplerDisabled('temperature')}
                onInput={(e) => markDirty(setTemperature)(Number(e.currentTarget.value))}
              />
            </div>
          </div>
          <label class="field-label">
            {t('backendConfig.maxTokens')}
            <input
              class="input"
              type="number"
              min={1}
              max={8192}
              value={maxTokens()}
              onInput={(e) => markDirty(setMaxTokens)(Number(e.currentTarget.value))}
            />
          </label>
          {/* KoboldCpp is the only provider that consumes contextLength (its
              max_context_length wire param); everyone else gets metadata only,
              so the field stays hidden for them. */}
          <Show when={backendProvider() === 'koboldcpp'}>
            <label class="field-label">
              {t('backendConfig.contextLength')}
              <input
                class="input"
                type="number"
                min={512}
                max={128000}
                value={contextLength()}
                onInput={(e) => markDirty(setContextLength)(Number(e.currentTarget.value))}
              />
            </label>
          </Show>
          <div class="sampler-field">
            <label class="field-label" for="sampler-topP">{t('backendConfig.topP')}</label>
            <div class="sampler-input-group">
              <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                <input
                  class="checkbox-input"
                  type="checkbox"
                  checked={!isSamplerDisabled('topP')}
                  onChange={(e) => setSamplerEnabled('topP', e.currentTarget.checked)}
                  aria-label={t('backendConfig.samplerEnabled')}
                />
              </label>
              <input
                id="sampler-topP"
                class="input sampler-value-input"
                type="number"
                step={0.1}
                min={0}
                max={1}
                value={topP()}
                disabled={isSamplerDisabled('topP')}
                onInput={(e) => markDirty(setTopP)(Number(e.currentTarget.value))}
              />
            </div>
          </div>
          <div class="sampler-field">
            <label class="field-label" for="sampler-topK">{t('backendConfig.topK')}</label>
            <div class="sampler-input-group">
              <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                <input
                  class="checkbox-input"
                  type="checkbox"
                  checked={!isSamplerDisabled('topK')}
                  onChange={(e) => setSamplerEnabled('topK', e.currentTarget.checked)}
                  aria-label={t('backendConfig.samplerEnabled')}
                />
              </label>
              <input
                id="sampler-topK"
                class="input sampler-value-input"
                type="number"
                min={1}
                value={topK() ?? ''}
                disabled={isSamplerDisabled('topK')}
                onInput={(e) => markDirty(setTopK)(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
              />
            </div>
          </div>
          <div class="sampler-field">
            <label class="field-label" for="sampler-minP">{t('backendConfig.minP')}</label>
            <div class="sampler-input-group">
              <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                <input
                  class="checkbox-input"
                  type="checkbox"
                  checked={!isSamplerDisabled('minP')}
                  onChange={(e) => setSamplerEnabled('minP', e.currentTarget.checked)}
                  aria-label={t('backendConfig.samplerEnabled')}
                />
              </label>
              <input
                id="sampler-minP"
                class="input sampler-value-input"
                type="number"
                step={0.01}
                min={0}
                max={1}
                value={minP() ?? ''}
                disabled={isSamplerDisabled('minP')}
                onInput={(e) => markDirty(setMinP)(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
              />
            </div>
          </div>
          <div class="sampler-field">
            <label class="field-label" for="sampler-topA">{t('backendConfig.topA')}</label>
            <div class="sampler-input-group">
              <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                <input
                  class="checkbox-input"
                  type="checkbox"
                  checked={!isSamplerDisabled('topA')}
                  onChange={(e) => setSamplerEnabled('topA', e.currentTarget.checked)}
                  aria-label={t('backendConfig.samplerEnabled')}
                />
              </label>
              <input
                id="sampler-topA"
                class="input sampler-value-input"
                type="number"
                step={0.01}
                min={0}
                value={topA() ?? ''}
                disabled={isSamplerDisabled('topA')}
                onInput={(e) => markDirty(setTopA)(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
              />
            </div>
          </div>
          <div class="sampler-field">
            <label class="field-label" for="sampler-repetitionPenalty">{t('backendConfig.repetitionPenalty')}</label>
            <div class="sampler-input-group">
              <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                <input
                  class="checkbox-input"
                  type="checkbox"
                  checked={!isSamplerDisabled('repetitionPenalty')}
                  onChange={(e) => setSamplerEnabled('repetitionPenalty', e.currentTarget.checked)}
                  aria-label={t('backendConfig.samplerEnabled')}
                />
              </label>
              <input
                id="sampler-repetitionPenalty"
                class="input sampler-value-input"
                type="number"
                step={0.1}
                min={0}
                value={repetitionPenalty() ?? ''}
                disabled={isSamplerDisabled('repetitionPenalty')}
                onInput={(e) => markDirty(setRepetitionPenalty)(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
              />
            </div>
          </div>
          <div class="sampler-field">
            <label class="field-label" for="sampler-frequencyPenalty">{t('backendConfig.frequencyPenalty')}</label>
            <div class="sampler-input-group">
              <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                <input
                  class="checkbox-input"
                  type="checkbox"
                  checked={!isSamplerDisabled('frequencyPenalty')}
                  onChange={(e) => setSamplerEnabled('frequencyPenalty', e.currentTarget.checked)}
                  aria-label={t('backendConfig.samplerEnabled')}
                />
              </label>
              <input
                id="sampler-frequencyPenalty"
                class="input sampler-value-input"
                type="number"
                step={0.1}
                value={frequencyPenalty() ?? ''}
                disabled={isSamplerDisabled('frequencyPenalty')}
                onInput={(e) => markDirty(setFrequencyPenalty)(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
              />
            </div>
          </div>
          <div class="sampler-field">
            <label class="field-label" for="sampler-presencePenalty">{t('backendConfig.presencePenalty')}</label>
            <div class="sampler-input-group">
              <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                <input
                  class="checkbox-input"
                  type="checkbox"
                  checked={!isSamplerDisabled('presencePenalty')}
                  onChange={(e) => setSamplerEnabled('presencePenalty', e.currentTarget.checked)}
                  aria-label={t('backendConfig.samplerEnabled')}
                />
              </label>
              <input
                id="sampler-presencePenalty"
                class="input sampler-value-input"
                type="number"
                step={0.1}
                value={presencePenalty() ?? ''}
                disabled={isSamplerDisabled('presencePenalty')}
                onInput={(e) => markDirty(setPresencePenalty)(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
              />
            </div>
          </div>

          <Show when={activeProfile().length > 0}>
            <details class="advanced-sampling mt-md">
              <summary class="section-title text-sm">{t('backendConfig.advSection')}</summary>
              <div class="flex-col-sm mt-sm">
                <For each={activeProfile()}>
                  {(knob, i) => (
                    <>
                      <Show when={i() === 0 || activeProfile()[i() - 1]?.group !== knob.group}>
                        <h4 class="text-sm text-muted mb-0 mt-sm">
                          {td('backendConfig.adv.group.' + knob.group)}
                        </h4>
                      </Show>
                      <Show when={knob.type === 'checkbox'}>
                        <label class="field-label">
                          {td('backendConfig.adv.' + knob.labelKey)}
                          <div class="flex-row-sm">
                            <label class="radio-row">
                              <input
                                type="radio"
                                name={`knob-${knob.wireName}`}
                                checked={knobState(knob.wireName) === 'omit'}
                                onChange={() => setKnobState(knob.wireName, 'omit')}
                              />
                              {t('backendConfig.adv.omit')}
                            </label>
                            <label class="radio-row">
                              <input
                                type="radio"
                                name={`knob-${knob.wireName}`}
                                checked={knobState(knob.wireName) === 'on'}
                                onChange={() => setKnobState(knob.wireName, 'on')}
                              />
                              {t('backendConfig.adv.on')}
                            </label>
                            <label class="radio-row">
                              <input
                                type="radio"
                                name={`knob-${knob.wireName}`}
                                checked={knobState(knob.wireName) === 'off'}
                                onChange={() => setKnobState(knob.wireName, 'off')}
                              />
                              {t('backendConfig.adv.off')}
                            </label>
                          </div>
                        </label>
                      </Show>
                      <Show when={knob.type === 'textarea' || knob.type === 'list'}>
                        <div class="sampler-field">
                          <label class="field-label" for={`sampler-${knob.wireName}`}>
                            {td('backendConfig.adv.' + knob.labelKey)}
                          </label>
                          <div class="sampler-input-group">
                            <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                              <input
                                class="checkbox-input"
                                type="checkbox"
                                checked={!isSamplerDisabled(knob.wireName)}
                                onChange={(e) => setSamplerEnabled(knob.wireName, e.currentTarget.checked)}
                                aria-label={t('backendConfig.samplerEnabled')}
                              />
                            </label>
                            <textarea
                              id={`sampler-${knob.wireName}`}
                              rows={3}
                              class="input resize-v sampler-value-input"
                              value={advancedValue(knob)}
                              disabled={isSamplerDisabled(knob.wireName)}
                              placeholder={
                                knob.placeholderKey
                                  ? td('backendConfig.adv.placeholder.' + knob.placeholderKey)
                                  : undefined
                              }
                              onInput={(e) => setAdvanced(knob.wireName, e.currentTarget.value)}
                            />
                          </div>
                        </div>
                      </Show>
                      <Show when={knob.type === 'number' || knob.type === 'slider'}>
                        <div class="sampler-field">
                          <label class="field-label" for={`sampler-${knob.wireName}`}>
                            {td('backendConfig.adv.' + knob.labelKey)}
                          </label>
                          <div class="sampler-input-group">
                            <label class="sampler-input-addon" title={t('backendConfig.samplerEnabled')}>
                              <input
                                class="checkbox-input"
                                type="checkbox"
                                checked={!isSamplerDisabled(knob.wireName)}
                                onChange={(e) => setSamplerEnabled(knob.wireName, e.currentTarget.checked)}
                                aria-label={t('backendConfig.samplerEnabled')}
                              />
                            </label>
                            <input
                              id={`sampler-${knob.wireName}`}
                              class="input sampler-value-input"
                              type="number"
                              min={knob.min}
                              max={knob.max}
                              step={knob.step}
                              value={advancedValue(knob)}
                              disabled={isSamplerDisabled(knob.wireName)}
                              onInput={(e) =>
                                setAdvanced(
                                  knob.wireName,
                                  e.currentTarget.value === '' ? '' : Number(e.currentTarget.value),
                                )
                              }
                            />
                          </div>
                        </div>
                      </Show>
                    </>
                  )}
                </For>
              </div>
            </details>
          </Show>

          <h4 class="text-sm text-muted mb-0 mt-md">{t('backendConfig.contextSection')}</h4>
          <label class="field-label">
            {t('backendConfig.promptHistoryLimit')}
            <input
              class="input"
              type="number"
              min={5}
              max={200}
              value={promptHistoryLimit()}
              onInput={(e) => markDirty(setPromptHistoryLimit)(Number(e.currentTarget.value))}
            />
          </label>
          <label class="field-label">
            {t('backendConfig.stopStrings')}
            <textarea
              rows={3}
              value={stopStrings()}
              onInput={(e) => markDirty(setStopStrings)(e.currentTarget.value)}
              placeholder={t('backendConfig.stopStringsPlaceholder')}
              class="resize-v"
            />
          </label>
          <label class="field-label">
            {t('backendConfig.logitBias')}
            <textarea
              rows={3}
              value={logitBias()}
              onInput={(e) => markDirty(setLogitBias)(e.currentTarget.value)}
              placeholder={t('backendConfig.logitBiasPlaceholder')}
              class="resize-v"
            />
          </label>
          <h4 class="text-sm text-muted mb-0 mt-md">{t('backendConfig.optionsSection')}</h4>
          <label class="checkbox-row" title={state.settings['appendOnlyPromptLayout'] ? t('backendConfig.disabledByAppendOnly') : ''}>
            <input
              class="checkbox-input"
              type="checkbox"
              checked={reasoningAddToPrompts()}
              disabled={Boolean(state.settings['appendOnlyPromptLayout'])}
              onChange={(e) => setReasoningAddToPrompts(e.currentTarget.checked)}
            />
            {t('backendConfig.includeReasoning')}
            <Show when={state.settings['appendOnlyPromptLayout']}>
              <span class="hint-text">{t('backendConfig.disabledByAppendOnly')}</span>
            </Show>
          </label>

          <div class="mt-md flex-col-sm">
            <h4 class="text-sm text-muted mb-0">{t('backendConfig.mediaSupport')}</h4>
            <label class="checkbox-row">
              <input
                class="checkbox-input"
                type="checkbox"
                checked={supportsImages()}
                onChange={(e) => markDirty(setSupportsImages)(e.currentTarget.checked)}
              />
              {t('backendConfig.mediaImages')}
            </label>
            <label class="checkbox-row">
              <input
                class="checkbox-input"
                type="checkbox"
                checked={supportsAudio()}
                onChange={(e) => markDirty(setSupportsAudio)(e.currentTarget.checked)}
              />
              {t('backendConfig.mediaAudio')}
            </label>
            <label class="checkbox-row">
              <input
                class="checkbox-input"
                type="checkbox"
                checked={supportsVideo()}
                onChange={(e) => markDirty(setSupportsVideo)(e.currentTarget.checked)}
              />
              {t('backendConfig.mediaVideo')}
            </label>
          </div>

          <Show when={backendProvider() === 'openrouter'}>
            <div class="mt-md flex-col-sm">
              <h4 class="text-sm text-muted mb-0">{t('backendConfig.openrouterReasoning')}</h4>
              <label class="field-label">
                {t('backendConfig.reasoningEffort')}
                <select
                  class="select"
                  value={openrouterReasoningEffort()}
                  onChange={(e) => setOpenrouterReasoningEffort(e.currentTarget.value as AppSettings['openrouter.reasoningEffort'])}
                >
                  <option class="select-option" value="">{t('backendConfig.optionDefault')}</option>
                  <option class="select-option" value="xhigh">{t('backendConfig.effortExtremeHigh')}</option>
                  <option class="select-option" value="high">{t('backendConfig.effortHigh')}</option>
                  <option class="select-option" value="medium">{t('backendConfig.effortMedium')}</option>
                  <option class="select-option" value="low">{t('backendConfig.effortLow')}</option>
                  <option class="select-option" value="minimal">{t('backendConfig.effortMinimal')}</option>
                  <option class="select-option" value="none">{t('backendConfig.effortNone')}</option>
                </select>
              </label>
              <label class="field-label">
                {t('backendConfig.reasoningSummary')}
                <select
                  class="select"
                  value={openrouterReasoningSummary()}
                  onChange={(e) => setOpenrouterReasoningSummary(e.currentTarget.value as AppSettings['openrouter.reasoningSummary'])}
                >
                  <option class="select-option" value="">{t('backendConfig.optionDefault')}</option>
                  <option class="select-option" value="auto">{t('backendConfig.summaryAuto')}</option>
                  <option class="select-option" value="concise">{t('backendConfig.summaryConcise')}</option>
                  <option class="select-option" value="detailed">{t('backendConfig.summaryDetailed')}</option>
                </select>
              </label>
            </div>
          </Show>

          <Show when={backendProvider() === 'claude' || backendProvider() === 'openrouter'}>
            <div class="mt-md flex-col-sm">
              <h4 class="text-sm text-muted mb-0">{t('backendConfig.promptCaching')}</h4>
              <label class="field-label">
                {t('backendConfig.cacheMode')}
                <select
                  class="select"
                  value={cacheMode()}
                  onChange={(e) => markDirty(setCacheMode)(e.currentTarget.value)}
                >
                  <option class="select-option" value="off">{t('backendConfig.cacheModeOff')}</option>
                  <option class="select-option" value="auto">{t('backendConfig.cacheModeAuto')}</option>
                  <option class="select-option" value="manual">{t('backendConfig.cacheModeManual')}</option>
                </select>
                <span class="hint-text">{t('backendConfig.cacheModeHint')}</span>
              </label>
              <Show when={cacheMode() === 'manual'}>
                <label class="field-label">
                  {t('backendConfig.cacheDepth')}
                  <input
                    class="input"
                    type="number"
                    min={0}
                    max={100}
                    value={cacheDepth()}
                    onInput={(e) => markDirty(setCacheDepth)(Number(e.currentTarget.value))}
                  />
                  <span class="hint-text">{t('backendConfig.cacheDepthHint')}</span>
                </label>
              </Show>
              <label class="field-label">
                {t('backendConfig.cacheTtl')}
                <input
                  class="input"
                  type="text"
                  value={cacheTTL()}
                  disabled={cacheMode() === 'off'}
                  onInput={(e) => markDirty(setCacheTTL)(e.currentTarget.value)}
                  placeholder={t('backendConfig.cacheTtlPlaceholder')}
                />
                <span class="hint-text">{t('backendConfig.cacheTtlHint')}</span>
              </label>
            </div>
          </Show>

        </section>

        <div class="modal-actions">
          <button class="btn" onClick={close}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
