import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
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

type CreatedMessage = {
  type: 'transformerscript.created';
  item: TransformerScript;
  clientId?: string;
};

function makeScript(overrides: Partial<TransformerScript> = {}): TransformerScript {
  return {
    id: 'ts-1',
    name: 'Strip OOC',
    description: 'Drops OOC lines',
    luaSource: 'function handle(messages, ctx) return messages end',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function sentSaves(sendSpy: { mock: { calls: unknown[][] } }): unknown[] {
  return sendSpy.mock.calls
    .map((c) => c[0])
    .filter((m): m is { type: string } => {
      return typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'transformerscript.save';
    });
}

/** Capture the modal's transformerscript.created subscription so tests can
    play the server's echo (the mocked bus sends nowhere). */
function captureCreated(): { handler: ((msg: CreatedMessage) => void) | undefined } {
  const captured: { handler: ((msg: CreatedMessage) => void) | undefined } = { handler: undefined };
  vi.spyOn(bus, 'on').mockImplementation((type: string, handler: (msg: CreatedMessage) => void) => {
    if (type === 'transformerscript.created') captured.handler = handler;
    return () => {};
  });
  return captured;
}

describe('TransformerScriptsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState('clientId', 'test-client');
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

  it('Add Script creates immediately via transformerscript.save without an id', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Add Script'));

    const saves = sentSaves(sendSpy);
    expect(saves).toHaveLength(1);
    const save = saves[0] as { id?: string; data: { name: string; description: string; luaSource: string } };
    expect(save.id).toBeUndefined();
    expect(save.data.name).toBe('New Script');
    expect(save.data.luaSource).toContain('function handle(messages, ctx)');
  });

  it('opens the edit form on our own created echo and ignores other clients', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    const created = captureCreated();
    render(() => <TransformerScriptsModal onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add Script'));

    // Another tab's creation must not hijack the form.
    created.handler?.({ type: 'transformerscript.created', item: makeScript({ id: 'other' }), clientId: 'other-tab' });
    expect(screen.queryByPlaceholderText('strip-ooc')).not.toBeInTheDocument();

    created.handler?.({ type: 'transformerscript.created', item: makeScript(), clientId: 'test-client' });
    expect(screen.getByDisplayValue('Strip OOC')).toBeInTheDocument();
  });

  it('auto-saves edits debounced with the id — no Save button', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerScripts', [makeScript()]);
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    fireEvent.input(screen.getByDisplayValue('Strip OOC'), { target: { value: 'Renamed' } });

    await waitFor(() => {
      const saves = sentSaves(sendSpy);
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({
        id: 'ts-1',
        data: { name: 'Renamed', description: 'Drops OOC lines' },
      });
    });
  });

  it('never auto-saves with a blank name', async () => {
    vi.useFakeTimers();
    try {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setState('transformerScripts', [makeScript()]);
      render(() => <TransformerScriptsModal onClose={() => {}} />);

      fireEvent.click(screen.getByText('Edit'));
      fireEvent.input(screen.getByDisplayValue('Strip OOC'), { target: { value: '' } });
      await vi.advanceTimersByTimeAsync(1000);

      expect(sentSaves(sendSpy)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a pending save when the edit form closes', async () => {
    vi.useFakeTimers();
    try {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setState('transformerScripts', [makeScript()]);
      render(() => <TransformerScriptsModal onClose={() => {}} />);

      fireEvent.click(screen.getByText('Edit'));
      fireEvent.input(screen.getByDisplayValue('Strip OOC'), { target: { value: 'Flushed' } });
      // Done before the debounce fires — the edit must still go out.
      fireEvent.click(screen.getByText('Done'));

      const saves = sentSaves(sendSpy);
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({ id: 'ts-1', data: { name: 'Flushed' } });
      // The pending timer was cancelled — no second save.
      await vi.advanceTimersByTimeAsync(1000);
      expect(sentSaves(sendSpy)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending save when the edited script is deleted', async () => {
    vi.useFakeTimers();
    try {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setState('transformerScripts', [makeScript()]);
      render(() => <TransformerScriptsModal onClose={() => {}} />);

      fireEvent.click(screen.getByText('Edit'));
      fireEvent.input(screen.getByDisplayValue('Strip OOC'), { target: { value: 'Doomed' } });
      fireEvent.click(screen.getByText('Delete'));
      await vi.advanceTimersByTimeAsync(1000);

      expect(sendSpy).toHaveBeenCalledWith({ type: 'transformerscript.delete', id: 'ts-1' });
      expect(sentSaves(sendSpy)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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
    setState('transformerScripts', [makeScript()]);
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    const sourceArea = screen.getByDisplayValue('function handle(messages, ctx) return messages end');
    fireEvent.input(sourceArea, { target: { value: 'function handle(m, c) return m end' } });
    fireEvent.click(screen.getByText('Validate'));

    const validate = sendSpy.mock.calls.map((c) => c[0]).find((m) => m.type === 'transformerscript.validate');
    expect(validate).toMatchObject({
      type: 'transformerscript.validate',
      luaSource: 'function handle(m, c) return m end',
    });
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
    setState('transformerScripts', [makeScript()]);
    render(() => <TransformerScriptsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    const sourceArea = screen.getByDisplayValue('function handle(messages, ctx) return messages end');
    fireEvent.input(sourceArea, { target: { value: 'not lua' } });
    fireEvent.click(screen.getByText('Validate'));

    const validate = sendSpy.mock.calls.map((c) => c[0]).find((m) => m.type === 'transformerscript.validate');
    const requestId = (validate as { requestId?: string }).requestId;
    validatedHandler?.({ type: 'transformerscript.validated', requestId, ok: false, error: 'syntax error near X' });
    expect(screen.getByText('syntax error near X')).toBeInTheDocument();
  });
});
