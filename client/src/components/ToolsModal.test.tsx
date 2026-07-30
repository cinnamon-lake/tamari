import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { ToolsModal } from './ToolsModal.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import type { Toolset, ToolInfo, ToolTemplate } from '@tamari/types';

describe('ToolsModal', () => {
  const toolDef: ToolInfo = {
    id: 'tmpl-1',
    name: 'lua_encouragement',
    description: 'lua_encouragement',
    configSchema: {},
    tools: [{ name: 'encourage', description: 'Encourage', parameters: { type: 'object', properties: {} } }],
  };

  const toolset: Toolset = {
    id: 'ts-1',
    templateId: 'tmpl-1',
    name: 'Encouragement (e2e)',
    config: {},
    toolOverrides: {},
    enabled: false,
    agentVisible: false,
    createdAt: 0,
    updatedAt: 0,
  };

  const toolTemplate: ToolTemplate = {
    id: 'lua-1',
    name: 'My Lua',
    code: 'return {}',
    configSchema: {},
    createdAt: 0,
    updatedAt: 0,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    setState('tools', [toolDef]);
    setState('toolsets', [toolset]);
    setState('toolTemplates', [toolTemplate]);
  });

  it('renders toolsets and Lua templates', () => {
    render(() => <ToolsModal onClose={() => {}} />);
    expect(screen.getByText('Encouragement (e2e)')).toBeInTheDocument();
    expect(screen.getByText('My Lua')).toBeInTheDocument();
  });

  it('toggles a toolset enabled state', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <ToolsModal onClose={() => {}} />);

    const checkbox = document.querySelector('.toolset-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'toolset.update',
      toolsetId: 'ts-1',
      patch: { enabled: true },
    });
  });

  it('toggles a toolset sub-agent visibility', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <ToolsModal onClose={() => {}} />);

    const checkbox = document.querySelector('.toolset-agent-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'toolset.update',
      toolsetId: 'ts-1',
      patch: { agentVisible: true },
    });
  });

  it('sends toolset.create when adding a new toolset', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <ToolsModal onClose={() => {}} />);

    screen.getByText('New Toolset').click();
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'toolset.create',
      data: {
        templateId: 'tmpl-1',
        name: 'New Toolset',
        config: {},
        toolOverrides: {},
        enabled: true,
      },
    });
  });

  it('live-updates the open toolset form when another client changes it', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <ToolsModal onClose={() => {}} />);
    screen.getByTitle('Show config').click();
    const nameInput = document.querySelector('.toolset-body input.input') as HTMLInputElement;
    expect(nameInput.value).toBe('Encouragement (e2e)');
    // Simulate a remote client's edit landing in the store.
    setState('toolsets', 0, 'name', 'Remote rename');
    expect(nameInput.value).toBe('Remote rename');
  });

  it('protects in-flight local edits from remote updates', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <ToolsModal onClose={() => {}} />);
    screen.getByTitle('Show config').click();
    const nameInput = document.querySelector('.toolset-body input.input') as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: 'My local edit' } });
    setState('toolsets', 0, 'name', 'Remote rename');
    expect(nameInput.value).toBe('My local edit');
  });

  it('live-updates the open Lua editor when another client changes the template', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <ToolsModal onClose={() => {}} />);
    screen.getByLabelText('Edit Lua template').click();
    const codeArea = document.querySelector('.lua-tool-editor-code textarea') as HTMLTextAreaElement;
    expect(codeArea.value).toBe('return {}');
    setState('toolTemplates', 0, 'code', 'return { changed = true }');
    expect(codeArea.value).toBe('return { changed = true }');
  });
});
