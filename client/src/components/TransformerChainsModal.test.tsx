import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { TransformerChainsModal } from './TransformerChainsModal.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import type { TransformerChain, TransformerScript } from '@tamari/types';

vi.mock('../stores/popupStore.js', () => ({
  confirmPopup: vi.fn(async () => true),
  alertPopup: vi.fn(async () => undefined),
}));
import { confirmPopup } from '../stores/popupStore.js';

function makeChain(overrides: Partial<TransformerChain> = {}): TransformerChain {
  return {
    id: 'tc-1',
    name: 'Default',
    description: '',
    steps: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeScript(overrides: Partial<TransformerScript> = {}): TransformerScript {
  return {
    id: 'ts-1',
    name: 'Strip OOC',
    description: '',
    luaSource: 'function handle(messages, ctx) return messages end',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

type CreatedMessage = {
  type: 'transformerchain.created';
  item: TransformerChain;
  clientId?: string;
};

function sentSaves(sendSpy: { mock: { calls: unknown[][] } }): unknown[] {
  return sendSpy.mock.calls
    .map((c) => c[0])
    .filter((m): m is { type: string } => {
      return typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'transformerchain.save';
    });
}

/** Capture the modal's transformerchain.created subscription so tests can
    play the server's echo (the mocked bus sends nowhere). */
function captureCreated(): { handler: ((msg: CreatedMessage) => void) | undefined } {
  const captured: { handler: ((msg: CreatedMessage) => void) | undefined } = { handler: undefined };
  vi.spyOn(bus, 'on').mockImplementation((type: string, handler: (msg: CreatedMessage) => void) => {
    if (type === 'transformerchain.created') captured.handler = handler;
    return () => {};
  });
  return captured;
}

describe('TransformerChainsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState('clientId', 'test-client');
    setState('transformerChains', []);
    setState('transformerScripts', []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the title and requests both lists on mount', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <TransformerChainsModal onClose={() => {}} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Transformer Chains' })).toBeInTheDocument();
    expect(sendSpy).toHaveBeenCalledWith({ type: 'transformerchain.list' });
    expect(sendSpy).toHaveBeenCalledWith({ type: 'transformerscript.list' });
  });

  it('shows the empty state when no chains exist', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <TransformerChainsModal onClose={() => {}} />);
    expect(screen.getByText('No transformer chains yet.')).toBeInTheDocument();
  });

  it('lists existing chains from the store', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [makeChain({ name: 'My Chain', description: 'Two steps' })]);
    render(() => <TransformerChainsModal onClose={() => {}} />);
    expect(screen.getByText('My Chain')).toBeInTheDocument();
    expect(screen.getByText('Two steps')).toBeInTheDocument();
  });

  it('Add Chain creates immediately via transformerchain.save without an id', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <TransformerChainsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Add Chain'));

    const saves = sentSaves(sendSpy);
    expect(saves).toHaveLength(1);
    expect((saves[0] as { id?: string }).id).toBeUndefined();
    expect((saves[0] as { data: unknown }).data).toEqual({ name: 'New Chain', description: '', steps: [] });
  });

  it('opens the edit form on our own created echo and ignores other clients', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    const created = captureCreated();
    render(() => <TransformerChainsModal onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add Chain'));

    // Another tab's creation must not hijack the form.
    created.handler?.({ type: 'transformerchain.created', item: makeChain({ id: 'other' }), clientId: 'other-tab' });
    expect(screen.queryByPlaceholderText('my-chain')).not.toBeInTheDocument();

    created.handler?.({ type: 'transformerchain.created', item: makeChain(), clientId: 'test-client' });
    expect(screen.getByDisplayValue('Default')).toBeInTheDocument();
  });

  it('never auto-saves with a blank name', async () => {
    vi.useFakeTimers();
    try {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setState('transformerChains', [makeChain()]);
      render(() => <TransformerChainsModal onClose={() => {}} />);

      fireEvent.click(screen.getByText('Edit'));
      fireEvent.input(screen.getByDisplayValue('Default'), { target: { value: '' } });
      await vi.advanceTimersByTimeAsync(1000);

      expect(sentSaves(sendSpy)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends a builtin step with default params and auto-saves param edits', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [makeChain()]);
    render(() => <TransformerChainsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    // Default picker value is `whitespace`.
    fireEvent.click(screen.getByText('Add transform'));
    // The label appears in both the step row and the add-builtin picker option.
    expect(screen.getAllByText('Whitespace normalization').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Mode')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'full' } });

    await waitFor(() => {
      const saves = sentSaves(sendSpy);
      expect(saves.length).toBeGreaterThan(0);
      expect((saves.at(-1) as { data: { steps: unknown[] } }).data.steps).toEqual([
        { kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'full' } },
      ]);
    });
  });

  it('appends a Lua script step from the scripts list and auto-saves', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [makeChain()]);
    setState('transformerScripts', [makeScript()]);
    render(() => <TransformerChainsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Add script'));
    // Step row shows the script's name, not its id.
    expect(screen.getAllByText('Strip OOC').length).toBeGreaterThan(0);

    await waitFor(() => {
      const saves = sentSaves(sendSpy);
      expect(saves.length).toBeGreaterThan(0);
      expect((saves.at(-1) as { data: { steps: unknown[] } }).data.steps).toEqual([
        { kind: 'lua', scriptId: 'ts-1', enabled: true },
      ]);
    });
  });

  it('disables the Add script button when no scripts exist', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [makeChain()]);
    render(() => <TransformerChainsModal onClose={() => {}} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Add script')).toBeDisabled();
    expect(screen.getByText(/No transformer scripts yet\. Create one/)).toBeInTheDocument();
  });

  it('auto-saves a step enabled toggle with the id', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [
      makeChain({
        steps: [
          { kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'trim' } },
          { kind: 'builtin', id: 'strip-reasoning', enabled: true },
        ],
      }),
    ]);
    render(() => <TransformerChainsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    const enabledBoxes = screen.getAllByLabelText('Enabled');
    expect(enabledBoxes).toHaveLength(2);
    fireEvent.click(enabledBoxes[1] as HTMLInputElement);

    await waitFor(() => {
      const saves = sentSaves(sendSpy);
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({
        id: 'tc-1',
        data: {
          name: 'Default',
          steps: [
            { kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'trim' } },
            { kind: 'builtin', id: 'strip-reasoning', enabled: false },
          ],
        },
      });
    });
  });

  it('reorders steps with the move buttons and auto-saves', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [
      makeChain({
        steps: [
          { kind: 'builtin', id: 'squash-system', enabled: true },
          { kind: 'builtin', id: 'strip-reasoning', enabled: true },
        ],
      }),
    ]);
    render(() => <TransformerChainsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    // First step's up button is disabled; move it down instead.
    const upButtons = screen.getAllByLabelText('Move up');
    const downButtons = screen.getAllByLabelText('Move down');
    expect(upButtons[0]).toBeDisabled();
    expect(downButtons[1]).toBeDisabled();
    fireEvent.click(downButtons[0] as HTMLButtonElement);

    await waitFor(() => {
      const saves = sentSaves(sendSpy);
      expect((saves.at(-1) as { data: { steps: Array<{ id?: string }> } }).data.steps.map((s) => s.id)).toEqual([
        'strip-reasoning',
        'squash-system',
      ]);
    });
  });

  it('removes a step and auto-saves', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [
      makeChain({
        steps: [
          { kind: 'builtin', id: 'squash-system', enabled: true },
          { kind: 'builtin', id: 'strip-reasoning', enabled: true },
        ],
      }),
    ]);
    render(() => <TransformerChainsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getAllByLabelText('Remove step')[0] as HTMLButtonElement);

    await waitFor(() => {
      const saves = sentSaves(sendSpy);
      expect((saves.at(-1) as { data: { steps: unknown[] } }).data.steps).toEqual([
        { kind: 'builtin', id: 'strip-reasoning', enabled: true },
      ]);
    });
  });

  it('edits history-squash params and clears a prefix back to the default', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [makeChain({ steps: [{ kind: 'builtin', id: 'history-squash', enabled: true }] })]);
    render(() => <TransformerChainsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('Target role'), { target: { value: 'assistant' } });
    fireEvent.input(screen.getByLabelText(/User prefix/), { target: { value: 'U: ' } });
    fireEvent.input(screen.getByLabelText(/Separator/), { target: { value: ' | ' } });

    await waitFor(() => {
      const saves = sentSaves(sendSpy);
      expect((saves.at(-1) as { data: { steps: unknown[] } }).data.steps).toEqual([
        {
          kind: 'builtin',
          id: 'history-squash',
          enabled: true,
          params: { role: 'assistant', userPrefix: 'U: ', separator: ' | ' },
        },
      ]);
    });

    // Re-open the editor — simulate the server's .updated echo by replacing
    // the store entry with the saved shape (the mocked bus sends nowhere).
    sendSpy.mockClear();
    setState('transformerChains', [
      makeChain({
        steps: [
          {
            kind: 'builtin',
            id: 'history-squash',
            enabled: true,
            params: { role: 'assistant', userPrefix: 'U: ', separator: ' | ' },
          },
        ],
      }),
    ]);
    fireEvent.click(screen.getByText('Done'));
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.input(screen.getByLabelText(/User prefix/), { target: { value: '' } });

    await waitFor(() => {
      const saves = sentSaves(sendSpy);
      // Empty prefix deletes the key so the server-side dynamic default applies.
      expect((saves.at(-1) as { data: { steps: unknown[] } }).data.steps).toEqual([
        { kind: 'builtin', id: 'history-squash', enabled: true, params: { role: 'assistant', separator: ' | ' } },
      ]);
    });
  });

  it('cancels a pending save when the edited chain is deleted', async () => {
    vi.useFakeTimers();
    try {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setState('transformerChains', [makeChain()]);
      render(() => <TransformerChainsModal onClose={() => {}} />);

      fireEvent.click(screen.getByText('Edit'));
      fireEvent.input(screen.getByDisplayValue('Default'), { target: { value: 'Doomed' } });
      fireEvent.click(screen.getByText('Delete'));
      await vi.advanceTimersByTimeAsync(1000);

      expect(sendSpy).toHaveBeenCalledWith({ type: 'transformerchain.delete', id: 'tc-1' });
      expect(sentSaves(sendSpy)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes a chain after confirmation', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [makeChain()]);
    render(() => <TransformerChainsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalled());
    expect(sendSpy).toHaveBeenCalledWith({ type: 'transformerchain.delete', id: 'tc-1' });
  });

  it('does not delete when confirmation is declined', async () => {
    vi.mocked(confirmPopup).mockResolvedValueOnce(false);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('transformerChains', [makeChain()]);
    render(() => <TransformerChainsModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalled());
    expect(sendSpy).not.toHaveBeenCalledWith({ type: 'transformerchain.delete', id: 'tc-1' });
  });
});
