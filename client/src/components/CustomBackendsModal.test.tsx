import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { CustomBackendsModal } from './CustomBackendsModal.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import type { CustomBackend } from '@tamari/types';

vi.mock('../stores/popupStore.js', () => ({
  confirmPopup: vi.fn(async () => true),
  alertPopup: vi.fn(async () => undefined),
}));
import { confirmPopup } from '../stores/popupStore.js';

function makeBackend(overrides: Partial<CustomBackend> = {}): CustomBackend {
  return {
    id: 'cb-1',
    name: 'Lua One',
    description: 'First script',
    luaSource: 'function generate(prompt, ctx) end',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('CustomBackendsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState('customBackends', []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the title and requests the list on mount', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <CustomBackendsModal onClose={() => {}} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Custom Backends' })).toBeInTheDocument();
    expect(sendSpy).toHaveBeenCalledWith({ type: 'custombackend.list' });
  });

  it('shows the empty state when no custom backends exist', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <CustomBackendsModal onClose={() => {}} />);
    expect(screen.getByText('No custom backends yet.')).toBeInTheDocument();
  });

  it('lists existing custom backends from the store', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('customBackends', [makeBackend()]);
    render(() => <CustomBackendsModal onClose={() => {}} />);
    expect(screen.getByText('Lua One')).toBeInTheDocument();
    expect(screen.getByText('First script')).toBeInTheDocument();
  });

  it('creates a custom backend via custombackend.create', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <CustomBackendsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Add Custom Backend'));
    fireEvent.input(screen.getByPlaceholderText('my-backend'), { target: { value: 'My Script' } });
    fireEvent.input(screen.getByPlaceholderText(/function generate/), {
      target: { value: 'function generate(p, c) return p end' },
    });
    fireEvent.click(screen.getByText('Save'));

    const create = sendSpy.mock.calls.map((c) => c[0]).find((m) => m.type === 'custombackend.create');
    expect(create).toBeDefined();
    expect((create as { data: unknown }).data).toEqual({
      name: 'My Script',
      description: '',
      luaSource: 'function generate(p, c) return p end',
    });
  });

  it('edits a custom backend via custombackend.update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('customBackends', [makeBackend()]);
    render(() => <CustomBackendsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.input(screen.getByDisplayValue('Lua One'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByText('Save'));

    const update = sendSpy.mock.calls.map((c) => c[0]).find((m) => m.type === 'custombackend.update');
    expect(update).toBeDefined();
    expect(update).toMatchObject({
      id: 'cb-1',
      patch: { name: 'Renamed', description: 'First script' },
    });
  });

  it('deletes a custom backend after confirmation', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('customBackends', [makeBackend()]);
    render(() => <CustomBackendsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalled());
    expect(sendSpy).toHaveBeenCalledWith({ type: 'custombackend.delete', id: 'cb-1' });
  });

  it('does not delete when confirmation is declined', async () => {
    vi.mocked(confirmPopup).mockResolvedValueOnce(false);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('customBackends', [makeBackend()]);
    render(() => <CustomBackendsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalled());
    expect(sendSpy).not.toHaveBeenCalledWith({ type: 'custombackend.delete', id: 'cb-1' });
  });
});
