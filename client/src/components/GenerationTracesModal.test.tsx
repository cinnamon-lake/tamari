import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@solidjs/testing-library';
import { GenerationTracesModal } from './GenerationTracesModal.js';
import { setState } from '../stores/serverStore.js';
import type { Generation } from '@tamari/types';

function makeGeneration(overrides?: Partial<Generation>): Generation {
  return {
    id: 'gen-1',
    chatId: 'chat-1',
    messageId: null,
    status: 'complete',
    backend: 'trivial',
    promptTokens: 10,
    completionTokens: 5,
    errorMessage: null,
    kind: 'send',
    parentId: null,
    meta: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function mockFetch(rows: Generation[], ok = true) {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ items: rows, total: rows.length }),
  })) as unknown as typeof fetch;
}

describe('GenerationTracesModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('activeChat', {
      id: 'chat-1',
      characterId: 'char-1',
      personaId: null,
      name: 'Test Chat',
      headMessageId: null,
      activeChildId: null,
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
      forkedFromChatId: null,
      forkedAtMessageId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not render when closed', () => {
    render(() => <GenerationTracesModal open={false} onClose={() => {}} />);
    expect(screen.queryByText('Generation traces')).not.toBeInTheDocument();
  });

  it('renders rows with kind, backend, status, and meta details', async () => {
    vi.stubGlobal('fetch', mockFetch([
      makeGeneration({ meta: { layer: 'trivial', depth: 0, rounds: 2, toolCalls: [{ name: 'get_weather' }] } }),
    ]));
    render(() => <GenerationTracesModal open={true} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('send')).toBeInTheDocument());
    expect(screen.getByText('trivial')).toBeInTheDocument();
    expect(screen.getByText('2 rounds')).toBeInTheDocument();
    expect(screen.getByText(/get_weather/)).toBeInTheDocument();
    expect(screen.getByText(/tokens 10 → 5/)).toBeInTheDocument();
  });

  it('indents sub-agent rows under their parent', async () => {
    vi.stubGlobal('fetch', mockFetch([
      makeGeneration({ id: 'gen-child', kind: 'subagent', parentId: 'gen-parent', meta: { depth: 1 } }),
      makeGeneration({ id: 'gen-parent', kind: 'send' }),
    ]));
    render(() => <GenerationTracesModal open={true} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('sub-agent')).toBeInTheDocument());
    const child = screen.getByText('sub-agent').closest('.generation-trace-child');
    expect(child).not.toBeNull();
    expect(child!.querySelector('.generation-trace-child-marker')).not.toBeNull();
  });

  it('renders the composed error chain for failed rows', async () => {
    vi.stubGlobal('fetch', mockFetch([
      makeGeneration({
        status: 'error',
        errorMessage: 'plain failure',
        meta: {
          traceError: {
            code: 'DELEGATE_ERROR',
            layer: 'delegate(default)',
            message: 'boom',
            cause: { code: 'LUA_ERROR', layer: 'inner-lua', message: 'inner boom' },
          },
        },
      }),
    ]));
    render(() => <GenerationTracesModal open={true} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('Error chain')).toBeInTheDocument());
    expect(screen.getByText('delegate(default) → inner-lua: LUA_ERROR: inner boom')).toBeInTheDocument();
  });

  it('shows the prompt expander only when meta.prompt is captured', async () => {
    vi.stubGlobal('fetch', mockFetch([
      makeGeneration({ id: 'gen-plain' }),
      makeGeneration({
        id: 'gen-with-prompt',
        meta: { prompt: { messages: [{ role: 'user', content: 'PROMPT-MARKER' }], tokenUsage: { prompt: 1, completion: 1 } } },
      }),
    ]));
    render(() => <GenerationTracesModal open={true} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('Prompt snapshot (debugPrompts)')).toBeInTheDocument());
    // Exactly one expander (the row without meta.prompt has none).
    expect(screen.getAllByText('Prompt snapshot (debugPrompts)')).toHaveLength(1);
    expect(screen.getByText('PROMPT-MARKER')).toBeInTheDocument();
  });

  it('renders the empty state', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    render(() => <GenerationTracesModal open={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('No generations recorded for this chat yet.')).toBeInTheDocument());
  });

  it('renders the error state when the fetch fails', async () => {
    vi.stubGlobal('fetch', mockFetch([], false));
    render(() => <GenerationTracesModal open={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Failed to load generation traces.')).toBeInTheDocument());
  });
});
