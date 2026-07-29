import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { BackendDryRunPanel } from './BackendDryRunPanel.js';
import { bus } from '../bus/WebSocketBus.js';
import type { CustomBackendTestOutcome } from '@tamari/types';

// jsdom may lack crypto.randomUUID (used for request ids).
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  let n = 0;
  Object.assign(globalThis, {
    crypto: { ...(globalThis.crypto ?? {}), randomUUID: () => `test-uuid-${++n}` },
  });
}

const LUA = 'function generate(prompt, ctx) return prompt end';

type TestResultMessage = {
  type: 'custombackend.testResult';
  requestId?: string;
  outcome: CustomBackendTestOutcome;
};

function makeOutcome(overrides: Partial<CustomBackendTestOutcome> = {}): CustomBackendTestOutcome {
  return {
    ok: true,
    text: 'generated text',
    usage: { promptTokens: 12, completionTokens: 3 },
    delegations: [],
    ...overrides,
  };
}

describe('BackendDryRunPanel', () => {
  let resultHandler: ((msg: TestResultMessage) => void) | undefined;

  beforeEach(() => {
    resultHandler = undefined;
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    vi.spyOn(bus, 'on').mockImplementation(((type: string, handler: (msg: TestResultMessage) => void) => {
      if (type === 'custombackend.testResult') resultHandler = handler;
      return () => {};
    }) as unknown as typeof bus.on);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sendSpy = () => vi.mocked(bus.send);
  const sentTestMessage = () =>
    sendSpy().mock.calls.map((c) => c[0]).find((m) => m.type === 'custombackend.test') as
      | { requestId?: string; input: string; luaSource?: string; characterId?: string; state?: string }
      | undefined;

  const fillAndRun = () => {
    fireEvent.input(screen.getByPlaceholderText('A sample user message...'), {
      target: { value: 'hello there' },
    });
    fireEvent.click(screen.getByText('Run'));
  };

  it('sends custombackend.test with the current luaSource and a requestId on Run', () => {
    render(() => <BackendDryRunPanel luaSource={LUA} />);
    fillAndRun();
    const msg = sentTestMessage();
    expect(msg).toBeDefined();
    expect(msg).toMatchObject({ type: 'custombackend.test', luaSource: LUA, input: 'hello there' });
    expect(typeof msg?.requestId).toBe('string');
    expect(msg?.state).toBeUndefined();
    expect(msg?.characterId).toBeUndefined();
  });

  it('includes characterId when provided', () => {
    render(() => <BackendDryRunPanel luaSource={LUA} characterId="char-9" />);
    fillAndRun();
    expect(sentTestMessage()).toMatchObject({ characterId: 'char-9' });
  });

  it('keeps Run disabled while a test is in flight and re-enables on the matching result', () => {
    render(() => <BackendDryRunPanel luaSource={LUA} />);
    fillAndRun();
    expect(screen.getByText('Running…')).toBeDisabled();
    resultHandler?.({
      type: 'custombackend.testResult',
      requestId: sentTestMessage()?.requestId,
      outcome: makeOutcome(),
    });
    expect(screen.getByText('Run')).not.toBeDisabled();
  });

  it('ignores results with a non-matching requestId', () => {
    render(() => <BackendDryRunPanel luaSource={LUA} />);
    fillAndRun();
    resultHandler?.({
      type: 'custombackend.testResult',
      requestId: 'someone-elses-request',
      outcome: makeOutcome({ text: 'stray result' }),
    });
    expect(screen.queryByText('stray result')).not.toBeInTheDocument();
    expect(screen.getByText('Running…')).toBeDisabled();
  });

  it('renders text, usage, delegations and stateOut from the outcome', () => {
    render(() => <BackendDryRunPanel luaSource={LUA} />);
    fillAndRun();
    resultHandler?.({
      type: 'custombackend.testResult',
      requestId: sentTestMessage()?.requestId,
      outcome: makeOutcome({
        stateOut: '{"turn":2}',
        delegations: [{ configId: null, promptPreview: 'preview of prompt', response: 'delegate said hi' }],
      }),
    });
    expect(screen.getByText('generated text')).toBeInTheDocument();
    expect(screen.getByText('Tokens: 12 prompt / 3 completion')).toBeInTheDocument();
    expect(screen.getByText('{"turn":2}')).toBeInTheDocument();
    expect(screen.getByText('Delegations (1)')).toBeInTheDocument();
    expect(screen.getByText(/preview of prompt/)).toBeInTheDocument();
    expect(screen.getByText('delegate said hi')).toBeInTheDocument();
  });

  it('renders the error in red styling when the run fails', () => {
    render(() => <BackendDryRunPanel luaSource={LUA} />);
    fillAndRun();
    resultHandler?.({
      type: 'custombackend.testResult',
      requestId: sentTestMessage()?.requestId,
      outcome: makeOutcome({ ok: false, text: undefined, error: 'lua exploded' }),
    });
    const err = screen.getByText('lua exploded');
    expect(err).toBeInTheDocument();
    expect(err.className).toContain('text-danger');
  });

  it('"Use as state" feeds stateOut back into the state field for the next run', () => {
    render(() => <BackendDryRunPanel luaSource={LUA} />);
    fillAndRun();
    resultHandler?.({
      type: 'custombackend.testResult',
      requestId: sentTestMessage()?.requestId,
      outcome: makeOutcome({ stateOut: '{"turn":2}' }),
    });
    fireEvent.click(screen.getByText('Use as state for next run'));
    expect(screen.getByDisplayValue('{"turn":2}')).toBeInTheDocument();

    sendSpy().mockClear();
    fillAndRun();
    expect(sentTestMessage()).toMatchObject({ state: '{"turn":2}' });
  });
});
