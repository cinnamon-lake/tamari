import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import {
  CharacterBackendEditor,
  parseCharacterBackendLogic,
  validateVfsPath,
  type CharacterBackendLogic,
} from './CharacterBackendEditor.js';

describe('parseCharacterBackendLogic', () => {
  it('returns defaults when the extension is absent or malformed', () => {
    expect(parseCharacterBackendLogic(undefined)).toEqual({ enabled: false, luaSource: '', files: {} });
    expect(parseCharacterBackendLogic({})).toEqual({ enabled: false, luaSource: '', files: {} });
    expect(parseCharacterBackendLogic({ contextualBackend: 'nope' })).toEqual({ enabled: false, luaSource: '', files: {} });
  });

  it('parses a well-formed contextualBackend blob', () => {
    expect(
      parseCharacterBackendLogic({ contextualBackend: { enabled: true, luaSource: '-- lua' } }),
    ).toEqual({ enabled: true, luaSource: '-- lua', files: {} });
  });

  it('coerces non-boolean enabled and non-string luaSource to safe defaults', () => {
    expect(
      parseCharacterBackendLogic({ contextualBackend: { enabled: 1, luaSource: 42 } }),
    ).toEqual({ enabled: false, luaSource: '', files: {} });
  });

  it('parses the files map and drops garbage entries tolerantly', () => {
    expect(
      parseCharacterBackendLogic({
        contextualBackend: {
          enabled: true,
          luaSource: '',
          files: {
            'lib/utils.lua': 'return {}',
            '../evil.lua': 'x',
            '/abs.lua': 'x',
            'bad name.lua': 'x',
            'lib/nested/ok.lua': 42 as unknown as string,
          },
        },
      }),
    ).toEqual({
      enabled: true,
      luaSource: '',
      files: { 'lib/utils.lua': 'return {}' },
    });
  });

  it('treats non-object files as absent', () => {
    expect(
      parseCharacterBackendLogic({ contextualBackend: { enabled: true, luaSource: '', files: 'nope' } }),
    ).toEqual({ enabled: true, luaSource: '', files: {} });
  });
});

describe('validateVfsPath', () => {
  it('normalizes and validates module paths', () => {
    expect(validateVfsPath('lib/utils')).toBe('lib/utils.lua');
    expect(validateVfsPath('lib/utils.lua')).toBe('lib/utils.lua');
    expect(validateVfsPath('./lib/utils.lua')).toBe('lib/utils.lua');
    expect(validateVfsPath('lib/deep/util.lua')).toBe('lib/deep/util.lua');
    expect(validateVfsPath('../x.lua')).toBeNull();
    expect(validateVfsPath('/abs.lua')).toBeNull();
    expect(validateVfsPath('bad name.lua')).toBeNull();
    expect(validateVfsPath('lib//x.lua')).toBeNull();
    expect(validateVfsPath('')).toBeNull();
  });
});

describe('CharacterBackendEditor', () => {
  const base: CharacterBackendLogic = { enabled: false, luaSource: '', files: {} };

  it('renders the enable checkbox and the Lua source textarea', () => {
    render(() => <CharacterBackendEditor value={base} onChange={() => {}} />);
    expect(screen.getByText('Enable backend logic')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByPlaceholderText(/function generate/)).toBeInTheDocument();
  });

  it('reflects an enabled script from the value prop', () => {
    render(() => (
      <CharacterBackendEditor value={{ enabled: true, luaSource: '-- hi', files: {} }} onChange={() => {}} />
    ));
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByDisplayValue('-- hi')).toBeInTheDocument();
  });

  it('emits onChange when the enabled checkbox is toggled', () => {
    const onChange = vi.fn();
    render(() => <CharacterBackendEditor value={base} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith({ enabled: true, luaSource: '', files: {} });
  });

  it('emits onChange when the Lua source is edited', () => {
    const onChange = vi.fn();
    render(() => (
      <CharacterBackendEditor value={{ enabled: true, luaSource: '', files: {} }} onChange={onChange} />
    ));
    fireEvent.input(screen.getByPlaceholderText(/function generate/), {
      target: { value: 'function generate(p, c) end' },
    });
    expect(onChange).toHaveBeenCalledWith({ enabled: true, luaSource: 'function generate(p, c) end', files: {} });
  });

  it('main.lua has no delete control', () => {
    render(() => (
      <CharacterBackendEditor
        value={{ enabled: true, luaSource: '', files: { 'lib/a.lua': 'return 1' } }}
        onChange={() => {}}
      />
    ));
    const mainTab = screen.getByText('main.lua');
    expect(mainTab.closest('.backend-file-tab')!.querySelector('.backend-file-tab-delete')).toBeNull();
    // The module tab has one.
    const moduleTab = screen.getByText('lib/a.lua').closest('.backend-file-tab')!;
    expect(moduleTab.querySelector('.backend-file-tab-delete')).not.toBeNull();
  });

  it('switching tabs routes edits to the module instead of luaSource', () => {
    const onChange = vi.fn();
    render(() => (
      <CharacterBackendEditor
        value={{ enabled: true, luaSource: '-- main', files: { 'lib/a.lua': '-- module' } }}
        onChange={onChange}
      />
    ));
    expect(screen.getByDisplayValue('-- main')).toBeInTheDocument();

    fireEvent.click(screen.getByText('lib/a.lua'));
    expect(screen.getByDisplayValue('-- module')).toBeInTheDocument();

    fireEvent.input(screen.getByPlaceholderText(/function generate/), {
      target: { value: '-- module edited' },
    });
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      luaSource: '-- main',
      files: { 'lib/a.lua': '-- module edited' },
    });
  });

  it('adds a module file (appending .lua when omitted)', () => {
    const onChange = vi.fn();
    render(() => <CharacterBackendEditor value={base} onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Add module file'));
    const input = screen.getByPlaceholderText('lib/utils.lua');
    fireEvent.input(input, { target: { value: 'lib/util' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ enabled: false, luaSource: '', files: { 'lib/util.lua': '' } });
  });

  it('adds a module file when the suffix is given', () => {
    const onChange = vi.fn();
    render(() => <CharacterBackendEditor value={base} onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Add module file'));
    const input = screen.getByPlaceholderText('lib/utils.lua');
    fireEvent.input(input, { target: { value: 'lib/util.lua' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ enabled: false, luaSource: '', files: { 'lib/util.lua': '' } });
  });

  it('rejects an invalid module path and keeps the input open', () => {
    const onChange = vi.fn();
    render(() => <CharacterBackendEditor value={base} onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Add module file'));
    const input = screen.getByPlaceholderText('lib/utils.lua');
    fireEvent.input(input, { target: { value: 'bad name.lua' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid path/)).toBeInTheDocument();
    expect(screen.queryByText('bad name.lua', { selector: '.backend-file-tab-name' })).toBeNull();
  });

  it('deletes a module file and falls back to main', () => {
    const onChange = vi.fn();
    render(() => (
      <CharacterBackendEditor
        value={{ enabled: true, luaSource: '-- main', files: { 'lib/a.lua': '-- module' } }}
        onChange={onChange}
      />
    ));
    fireEvent.click(screen.getByText('lib/a.lua'));
    fireEvent.click(screen.getByTitle('Delete module'));
    expect(onChange).toHaveBeenCalledWith({ enabled: true, luaSource: '-- main', files: {} });
    expect(screen.getByDisplayValue('-- main')).toBeInTheDocument();
  });
});
