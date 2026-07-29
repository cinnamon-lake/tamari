import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import {
  CharacterBackendEditor,
  parseCharacterBackendLogic,
  type CharacterBackendLogic,
} from './CharacterBackendEditor.js';

describe('parseCharacterBackendLogic', () => {
  it('returns defaults when the extension is absent or malformed', () => {
    expect(parseCharacterBackendLogic(undefined)).toEqual({ enabled: false, luaSource: '' });
    expect(parseCharacterBackendLogic({})).toEqual({ enabled: false, luaSource: '' });
    expect(parseCharacterBackendLogic({ contextualBackend: 'nope' })).toEqual({ enabled: false, luaSource: '' });
  });

  it('parses a well-formed contextualBackend blob', () => {
    expect(
      parseCharacterBackendLogic({ contextualBackend: { enabled: true, luaSource: '-- lua' } }),
    ).toEqual({ enabled: true, luaSource: '-- lua' });
  });

  it('coerces non-boolean enabled and non-string luaSource to safe defaults', () => {
    expect(
      parseCharacterBackendLogic({ contextualBackend: { enabled: 1, luaSource: 42 } }),
    ).toEqual({ enabled: false, luaSource: '' });
  });
});

describe('CharacterBackendEditor', () => {
  const base: CharacterBackendLogic = { enabled: false, luaSource: '' };

  it('renders the enable checkbox and the Lua source textarea', () => {
    render(() => <CharacterBackendEditor value={base} onChange={() => {}} />);
    expect(screen.getByText('Enable backend logic')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByPlaceholderText(/function generate/)).toBeInTheDocument();
  });

  it('reflects an enabled script from the value prop', () => {
    render(() => (
      <CharacterBackendEditor value={{ enabled: true, luaSource: '-- hi' }} onChange={() => {}} />
    ));
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByDisplayValue('-- hi')).toBeInTheDocument();
  });

  it('emits onChange when the enabled checkbox is toggled', () => {
    const onChange = vi.fn();
    render(() => <CharacterBackendEditor value={base} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith({ enabled: true, luaSource: '' });
  });

  it('emits onChange when the Lua source is edited', () => {
    const onChange = vi.fn();
    render(() => (
      <CharacterBackendEditor value={{ enabled: true, luaSource: '' }} onChange={onChange} />
    ));
    fireEvent.input(screen.getByPlaceholderText(/function generate/), {
      target: { value: 'function generate(p, c) end' },
    });
    expect(onChange).toHaveBeenCalledWith({ enabled: true, luaSource: 'function generate(p, c) end' });
  });
});
