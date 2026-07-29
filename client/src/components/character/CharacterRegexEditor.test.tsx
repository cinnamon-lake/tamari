import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { CharacterRegexEditor } from './CharacterRegexEditor.js';
import type { RegexRule } from '@tamari/types';

vi.mock('../../stores/popupStore.js', () => ({
  confirmPopup: vi.fn(async () => true),
  alertPopup: vi.fn(async () => undefined),
}));
import { confirmPopup, alertPopup } from '../../stores/popupStore.js';

function makeRule(overrides: Partial<RegexRule> = {}): RegexRule {
  return {
    id: 'r1',
    name: 'Shout',
    findRegex: '/hello/gi',
    replaceString: 'HELLO',
    disabled: false,
    userInput: false,
    aiOutput: false,
    prompt: true,
    display: true,
    ...overrides,
  };
}

describe('CharacterRegexEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders existing rules with placement summary', () => {
    render(() => <CharacterRegexEditor rules={[makeRule()]} onChange={() => {}} />);
    expect(screen.getByText('Shout')).toBeInTheDocument();
    expect(screen.getByText(/\/hello\/gi → HELLO/)).toBeInTheDocument();
    expect(screen.getByText(/Prompt • Display/)).toBeInTheDocument();
  });

  it('appends a valid new rule via the form', () => {
    const onChange = vi.fn();
    render(() => <CharacterRegexEditor rules={[]} onChange={onChange} />);

    screen.getByText('New Regex Rule').click();
    fireEvent.input(screen.getByPlaceholderText('e.g. Remove extra asterisks'), { target: { value: 'No stars' } });
    fireEvent.input(screen.getByPlaceholderText('e.g. /\\*{2,}/g'), { target: { value: '/\\*+/g' } });
    fireEvent.input(screen.getByPlaceholderText('e.g. *'), { target: { value: '' } });
    screen.getByText('Save Rule').click();

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as RegexRule[];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ name: 'No stars', findRegex: '/\\*+/g', prompt: true, display: true });
    expect(next[0]?.id).toBeTruthy();
  });

  it('rejects an undelimited pattern without calling onChange', async () => {
    const onChange = vi.fn();
    render(() => <CharacterRegexEditor rules={[]} onChange={onChange} />);

    screen.getByText('New Regex Rule').click();
    fireEvent.input(screen.getByPlaceholderText('e.g. Remove extra asterisks'), { target: { value: 'Bad' } });
    fireEvent.input(screen.getByPlaceholderText('e.g. /\\*{2,}/g'), { target: { value: 'no-delimiters' } });
    screen.getByText('Save Rule').click();

    await vi.waitFor(() => expect(alertPopup).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('deletes a rule after confirmation', async () => {
    const onChange = vi.fn();
    render(() => <CharacterRegexEditor rules={[makeRule()]} onChange={onChange} />);

    screen.getByTitle('Delete').click();
    await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('shows the Lua badge for replaceLua rules and edits the Lua source', () => {
    const onChange = vi.fn();
    render(() => (
      <CharacterRegexEditor
        rules={[makeRule({ replaceLua: 'function replace(match, captures) return "x" end' })]}
        onChange={onChange}
      />
    ));

    // List row badges the rule as Lua instead of showing replaceString.
    expect(screen.getByText(/\/hello\/gi → Lua/)).toBeInTheDocument();

    // Edit form opens in Lua mode with the source; preview is unavailable.
    screen.getByTitle('Edit').click();
    const luaArea = document.querySelector('textarea.font-mono') as HTMLTextAreaElement;
    expect(luaArea).toBeTruthy();
    expect(luaArea.value).toContain('function replace');
    const preview = document.querySelector('textarea.bg-secondary') as HTMLTextAreaElement;
    expect(preview?.value).toContain('Preview is unavailable for Lua');

    // Saving keeps the replaceLua source.
    fireEvent.input(luaArea, { target: { value: 'function replace(m, c) return "y" end' } });
    screen.getByText('Save Rule').click();
    const next = onChange.mock.calls[0]![0] as RegexRule[];
    expect(next[0]?.replaceLua).toBe('function replace(m, c) return "y" end');
  });

  it('switches a text rule to Lua mode and back', () => {
    render(() => <CharacterRegexEditor rules={[makeRule()]} onChange={() => {}} />);
    screen.getByTitle('Edit').click();

    // Text mode by default: the plain replacement textarea is shown.
    expect(screen.getByPlaceholderText('e.g. *')).toBeInTheDocument();

    // Switch to Lua: skeleton source is seeded.
    screen.getByText('Lua').click();
    const luaArea = document.querySelector('textarea.font-mono') as HTMLTextAreaElement;
    expect(luaArea?.value).toContain('function replace(match, captures)');

    // Switch back to Text: replaceLua is cleared, badge would disappear.
    screen.getByText('Text').click();
    expect(document.querySelector('textarea.font-mono')).toBeNull();
    expect(screen.getByPlaceholderText('e.g. *')).toBeInTheDocument();
  });
});
