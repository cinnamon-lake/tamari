import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { TransformerScriptsModal } from './TransformerScriptsModal.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import type { TransformerScript } from '@tamari/types';

vi.mock('../stores/popupStore.js', () => ({
  confirmPopup: vi.fn(async () => true),
  alertPopup: vi.fn(async () => undefined),
}));
import { confirmPopup } from '../stores/popupStore.js';

type ValidatedMessage = {
  type: 'transformerscript.validated';
  requestId?: string;
  ok: boolean;
  error?: string;
};

function makeScript(overrides: Partial<TransformerScript> = {}): TransformerScript {
  return {
    id: 'ts-1',
    name: 'Strip OOC',
    description: 'Drops OOC lines',
    luaSource: 'return messages',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('TransformerScriptsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState('transformerScripts', []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the title and requests the list on mount', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <TransformerScriptsModal onClose={() => {}} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Transformer Scripts' })).toBeInTheDocument();
    expect(sendSpy).toHaveBeenCalledWith({ type: 'transformerscript.list' });
  });

  it('shows the empty state when no scripts exist', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <TransformerScriptsModal onClose={() => {}} />);
    expect(screen.getByText('No transformer scripts yet.')).toBeInTheDocument();
  });

  it('lists existing scripts from the store', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerScripts', [makeScript()]);
    render(() => <TransformerScriptsModal onClose={() => {}} />);
    expect(screen.getByText('Strip OOC')).toBeInTheDocument();
    expect(screen.getByText('Drops OOC lines')).toBeInTheDocument();
  });

  it('creates a script via transformerscript.save without an id', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Add Script'));
    fireEvent.input(screen.getByPlaceholderText('strip-ooc'), { target: { value: 'My Script' } });
    fireEvent.input(screen.getByPlaceholderText(/for i = #messages/), {
      target: { value: 'table.remove(messages, 1)' },
    });
    fireEvent.click(screen.getByText('Save'));

    const save = sendSpy.mock.calls.map((c) => c[0]).find((m) => m.type === 'transformerscript.save');
    expect(save).toBeDefined();
    expect((save as { id?: string }).id).toBeUndefined();
    expect((save as { data: unknown }).data).toEqual({
      name: 'My Script',
      description: '',
      luaSource: 'table.remove(messages, 1)',
    });
  });

  it('edits a script via transformerscript.save with the id', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerScripts', [makeScript()]);
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.input(screen.getByDisplayValue('Strip OOC'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByText('Save'));

    const save = sendSpy.mock.calls.map((c) => c[0]).find((m) => m.type === 'transformerscript.save');
    expect(save).toBeDefined();
    expect(save).toMatchObject({
      id: 'ts-1',
      data: { name: 'Renamed', description: 'Drops OOC lines' },
    });
  });

  it('deletes a script after confirmation', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerScripts', [makeScript()]);
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalled());
    expect(sendSpy).toHaveBeenCalledWith({ type: 'transformerscript.delete', id: 'ts-1' });
  });

  it('does not delete when confirmation is declined', async () => {
    vi.mocked(confirmPopup).mockResolvedValueOnce(false);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerScripts', [makeScript()]);
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalled());
    expect(sendSpy).not.toHaveBeenCalledWith({ type: 'transformerscript.delete', id: 'ts-1' });
  });

  it('sends transformerscript.validate with a requestId and shows the matching result', () => {
    let validatedHandler: ((msg: ValidatedMessage) => void) | undefined;
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    vi.spyOn(bus, 'on').mockImplementation((type: string, handler: (msg: ValidatedMessage) => void) => {
      if (type === 'transformerscript.validated') validatedHandler = handler;
      return () => {};
    });
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Add Script'));
    fireEvent.input(screen.getByPlaceholderText(/for i = #messages/), {
      target: { value: 'return messages' },
    });
    fireEvent.click(screen.getByText('Validate'));

    const validate = sendSpy.mock.calls.map((c) => c[0]).find((m) => m.type === 'transformerscript.validate');
    expect(validate).toMatchObject({ type: 'transformerscript.validate', luaSource: 'return messages' });
    const requestId = (validate as { requestId?: string }).requestId;
    expect(typeof requestId).toBe('string');

    // A stale result for another request is ignored.
    validatedHandler?.({ type: 'transformerscript.validated', requestId: 'other', ok: false, error: 'stale' });
    expect(screen.queryByText('stale')).not.toBeInTheDocument();

    validatedHandler?.({ type: 'transformerscript.validated', requestId, ok: true });
    expect(screen.getByText('Script loads cleanly.')).toBeInTheDocument();
  });

  it('shows the server error when validation fails', () => {
    let validatedHandler: ((msg: ValidatedMessage) => void) | undefined;
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    vi.spyOn(bus, 'on').mockImplementation((type: string, handler: (msg: ValidatedMessage) => void) => {
      if (type === 'transformerscript.validated') validatedHandler = handler;
      return () => {};
    });
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Add Script'));
    fireEvent.input(screen.getByPlaceholderText(/for i = #messages/), { target: { value: 'not lua' } });
    fireEvent.click(screen.getByText('Validate'));

    const validate = sendSpy.mock.calls.map((c) => c[0]).find((m) => m.type === 'transformerscript.validate');
    const requestId = (validate as { requestId?: string }).requestId;
    validatedHandler?.({ type: 'transformerscript.validated', requestId, ok: false, error: 'syntax error near X' });
    expect(screen.getByText('syntax error near X')).toBeInTheDocument();
  });
});
