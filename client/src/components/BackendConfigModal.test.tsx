import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { BackendConfigModal } from './BackendConfigModal.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import type { BackendConfig, CustomBackend } from '@tamari/types';

function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    id: 'cfg-1',
    name: 'Test',
    description: '',
    backendProvider: 'openai',
    generationMode: 'chat',
    model: 'gpt-4o',
    apiUrl: null,
    apiKey: null,
    temperature: 1,
    maxTokens: 300,
    topP: 1,
    topK: null,
    minP: null,
    topA: null,
    repetitionPenalty: null,
    frequencyPenalty: null,
    presencePenalty: null,
    instructTemplate: '',
    contextLength: 4096,
    promptHistoryLimit: 50,
    providerParams: {},
    stopStrings: [],
    openrouterProvider: null,
    logitBias: null,
    supportsImages: true,
    supportsAudio: true,
    supportsVideo: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function valueNumberInput(labelText: string): HTMLInputElement {
  return screen.getByLabelText(labelText) as unknown as HTMLInputElement;
}
function enableCheckbox(labelText: string): HTMLInputElement {
  return screen.getByText(labelText)
    .closest('.sampler-field')!
    .querySelector('input[type="checkbox"]') as HTMLInputElement;
}

function expandAdvanced() {
  fireEvent.click(screen.getByText('Advanced Sampling'));
}

describe('BackendConfigModal advanced sampling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }),
    );
    setState('activeBackendConfig', makeConfig({ backendProvider: 'llamacpp', generationMode: 'text' }));
    setState('settings', {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders advanced knobs for the llamacpp profile and seeds from providerParams', () => {
    setState(
      'activeBackendConfig',
      makeConfig({
        backendProvider: 'llamacpp',
        generationMode: 'text',
        providerParams: { mirostat_mode: 2 },
      }),
    );
    render(() => <BackendConfigModal onClose={() => {}} />);
    expandAdvanced();
    expect(valueNumberInput('Mirostat Mode')).toHaveValue(2);
  });

  it('writes an advanced knob into the providerParams patch on save', () => {
    setState(
      'activeBackendConfig',
      makeConfig({
        id: 'cfg-save',
        backendProvider: 'llamacpp',
        generationMode: 'text',
        providerParams: { mirostat_mode: 2 },
      }),
    );
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <BackendConfigModal onClose={() => {}} />);
    expandAdvanced();

    // Mirostat Tau is disabled by default (not in providerParams). Enable it first.
    fireEvent.click(enableCheckbox('Mirostat Tau'));
    fireEvent.input(valueNumberInput('Mirostat Tau'), { target: { value: '5.5' } });
    vi.advanceTimersByTime(600);

    const update = sendSpy.mock.calls
      .map((c) => c[0])
      .find((m) => m.type === 'backendConfig.update');
    expect(update).toBeDefined();
    const patch = (update as { patch: { providerParams: Record<string, unknown> } }).patch;
    expect(patch.providerParams.mirostat_tau).toBe(5.5);
    expect(patch.providerParams.mirostat_mode).toBe(2);
  });

  it('shows only Seed for the chat profile (no mirostat/grammar)', () => {
    setState(
      'activeBackendConfig',
      makeConfig({ backendProvider: 'openai', generationMode: 'chat' }),
    );
    render(() => <BackendConfigModal onClose={() => {}} />);
    expandAdvanced();
    expect(screen.getByText('Seed')).toBeInTheDocument();
    expect(screen.queryByText('Mirostat Mode')).not.toBeInTheDocument();
    expect(screen.queryByText('Grammar (GBNF)')).not.toBeInTheDocument();
  });

  it('disabling a typed knob records it in samplerDisabled but preserves the value', () => {
    setState(
      'activeBackendConfig',
      makeConfig({
        id: 'cfg-disable',
        backendProvider: 'openai',
        generationMode: 'chat',
        temperature: 0.5,
        topK: 40,
      }),
    );
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <BackendConfigModal onClose={() => {}} />);

    expect(enableCheckbox('Top K')).toBeChecked();
    fireEvent.click(enableCheckbox('Top K'));
    expect(enableCheckbox('Top K')).not.toBeChecked();
    expect(valueNumberInput('Top K')).toBeDisabled();

    vi.advanceTimersByTime(600);

    const update = sendSpy.mock.calls
      .map((c) => c[0])
      .find((m) => m.type === 'backendConfig.update');
    expect(update).toBeDefined();
    const patch = (update as { patch: { topK: number | null; providerParams: Record<string, unknown> } }).patch;
    expect(patch.topK).toBe(40);
    // samplerDisabled includes topK (user-disabled) + any auto-disabled advanced knobs (e.g. seed).
    expect(patch.providerParams.samplerDisabled).toMatchObject({ topK: true });
    expect((patch.providerParams.samplerDisabled as Record<string, unknown>).temperature).toBeUndefined();
  });
});

describe('BackendConfigModal delete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }),
    );
    setState('settings', {});
    setState('backendConfigs', [
      { id: 'cfg-1', name: 'Test' },
      { id: 'cfg-2', name: 'Other' },
    ]);
    setState('activeBackendConfig', makeConfig({ id: 'cfg-1' }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('cancels a pending autosave when the active config is deleted', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    const popupStore = await import('../stores/popupStore.js');
    vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
    render(() => <BackendConfigModal onClose={() => {}} />);

    // Local edit -> debounced save pending.
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    // Delete before the 500ms debounce fires.
    fireEvent.click(screen.getByText('Delete Config'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(sendSpy).toHaveBeenCalledWith({ type: 'backendConfig.delete', backendConfigId: 'cfg-1' });
    // The fix: no backendConfig.update may fire after the delete.
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'backendConfig.update' }));
  });
});

function makeCustomBackend(overrides: Partial<CustomBackend> = {}): CustomBackend {
  return {
    id: 'cb-1',
    name: 'Lua One',
    description: '',
    luaSource: 'function generate(prompt, ctx) end',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('BackendConfigModal custom provider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }),
    );
    setState('settings', {});
    setState('customBackends', [makeCustomBackend()]);
    setState('backendConfigs', [
      { id: 'cfg-custom', name: 'Custom Cfg' },
      { id: 'cfg-other', name: 'Other Cfg' },
    ]);
    setState(
      'activeBackendConfig',
      makeConfig({
        id: 'cfg-custom',
        name: 'Custom Cfg',
        backendProvider: 'custom',
        generationMode: 'chat',
        providerParams: { customBackendId: 'cb-1' },
      }),
    );
  });

  afterEach(() => {
    setState('customBackends', []);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the custom backend and delegate dropdowns and hides API URL/key', () => {
    render(() => <BackendConfigModal onClose={() => {}} />);
    expect(screen.getByText('Custom Backend')).toBeInTheDocument();
    expect(screen.getByText('Lua One')).toBeInTheDocument();
    expect(screen.getByText('Delegate Backend')).toBeInTheDocument();
    // The delegate dropdown lists the OTHER backend configs, not this one.
    // ('Other Cfg' also appears in the top config selector, hence getAllByText.)
    expect(screen.getAllByText('Other Cfg').length).toBeGreaterThan(0);
    expect(screen.queryByText('API URL')).not.toBeInTheDocument();
    expect(screen.queryByText('API Key')).not.toBeInTheDocument();
  });

  it('shows a hint when no custom backends exist', () => {
    setState('customBackends', []);
    render(() => <BackendConfigModal onClose={() => {}} />);
    expect(
      screen.getByText('No custom backends yet. Create one in the Custom Backends menu.'),
    ).toBeInTheDocument();
  });

  it('writes customBackendId and delegateConfigId into providerParams on save', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <BackendConfigModal onClose={() => {}} />);

    fireEvent.change(screen.getByDisplayValue('Active backend at generation time'), {
      target: { value: 'cfg-other' },
    });
    vi.advanceTimersByTime(600);

    const update = sendSpy.mock.calls
      .map((c) => c[0])
      .find((m) => m.type === 'backendConfig.update');
    expect(update).toBeDefined();
    const patch = (update as { patch: { providerParams: Record<string, unknown> } }).patch;
    expect(patch.providerParams.customBackendId).toBe('cb-1');
    expect(patch.providerParams.delegateConfigId).toBe('cfg-other');
  });

  it('requests the custom backend list on mount', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <BackendConfigModal onClose={() => {}} />);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'custombackend.list' });
  });
});
