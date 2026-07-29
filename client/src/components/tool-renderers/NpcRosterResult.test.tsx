import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { NpcRosterResult } from './NpcRosterResult.js';
import { setState } from '../../stores/serverStore.js';
import { bus } from '../../bus/WebSocketBus.js';

describe('NpcRosterResult', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('characters', []);
  });

  const validExtra = {
    renderType: 'npc_roster',
    npcs: {
      Marta: { description: 'Innkeeper', personality: 'Gruff', notes: 'Keeps a tab for the party' },
      Bram: { description: 'A gruff blacksmith', personality: '', notes: '' },
    },
  };

  it('renders one roster item per NPC with its fields', () => {
    render(() => <NpcRosterResult content="NPC registered: Marta" extra={validExtra} />);
    expect(document.querySelectorAll('.npc-roster-item')).toHaveLength(2);
    expect(screen.getByText('Marta')).toBeInTheDocument();
    expect(screen.getByText('Innkeeper')).toBeInTheDocument();
    expect(screen.getByText('Gruff')).toBeInTheDocument();
    expect(screen.getByText('Keeps a tab for the party')).toBeInTheDocument();
    expect(screen.getByText('Bram')).toBeInTheDocument();
    expect(screen.getByText('A gruff blacksmith')).toBeInTheDocument();
    // Empty fields are omitted: Bram has only the description field.
    const bramItem = screen.getByText('Bram').closest('.npc-roster-item')!;
    expect(bramItem.querySelectorAll('.npc-roster-field')).toHaveLength(1);
    expect(document.querySelectorAll('.npc-promote-btn')).toHaveLength(2);
  });

  it('sends character.create with the mapped payload on promote', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <NpcRosterResult content="NPC registered: Marta" extra={validExtra} />);

    fireEvent.click(screen.getByText('Marta').closest('.npc-roster-item')!.querySelector('.npc-promote-btn')!);

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'character.create',
      data: {
        name: 'Marta',
        description: 'Innkeeper',
        personality: 'Gruff',
        creatorNotes: 'Keeps a tab for the party',
        tags: ['npc'],
      },
    });
  });

  it('maps missing fields to empty strings in the promote payload', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <NpcRosterResult content="NPC registered: Bram" extra={validExtra} />);

    fireEvent.click(screen.getByText('Bram').closest('.npc-roster-item')!.querySelector('.npc-promote-btn')!);

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'character.create',
      data: { name: 'Bram', description: 'A gruff blacksmith', personality: '', creatorNotes: '', tags: ['npc'] },
    });
  });

  it('disables promote with a Promoted label when the name already exists', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('characters', [{ name: 'Marta' } as any]);
    render(() => <NpcRosterResult content="NPC registered: Marta" extra={validExtra} />);

    const martaBtn = screen.getByText('Marta').closest('.npc-roster-item')!.querySelector<HTMLButtonElement>('.npc-promote-btn')!;
    expect(martaBtn).toBeDisabled();
    expect(martaBtn).toHaveTextContent('Promoted');
    fireEvent.click(martaBtn);
    expect(sendSpy).not.toHaveBeenCalled();

    // Other entries stay promotable.
    const bramBtn = screen.getByText('Bram').closest('.npc-roster-item')!.querySelector<HTMLButtonElement>('.npc-promote-btn')!;
    expect(bramBtn).toBeEnabled();
  });

  it('disables promote when the disabled prop is set', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <NpcRosterResult content="NPC registered: Marta" extra={validExtra} disabled />);

    const buttons = document.querySelectorAll<HTMLButtonElement>('.npc-promote-btn');
    expect(buttons).toHaveLength(2);
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
    fireEvent.click(buttons[0]!);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('falls back to plain content when npcs is not an object', () => {
    render(() => <NpcRosterResult content="NPC registered: Marta" extra={{ renderType: 'npc_roster', npcs: 'nope' }} />);
    expect(document.querySelectorAll('.npc-roster-item')).toHaveLength(0);
    expect(screen.getByText('NPC registered: Marta')).toBeInTheDocument();
  });

  it('falls back to plain content when npcs is an array', () => {
    render(() => <NpcRosterResult content="NPC registered: Marta" extra={{ renderType: 'npc_roster', npcs: ['Marta'] }} />);
    expect(document.querySelectorAll('.npc-roster-item')).toHaveLength(0);
    expect(screen.getByText('NPC registered: Marta')).toBeInTheDocument();
  });

  it('falls back to plain content when an entry is malformed', () => {
    render(() => (
      <NpcRosterResult content="NPC registered: Marta" extra={{ renderType: 'npc_roster', npcs: { Marta: 'Innkeeper' } }} />
    ));
    expect(document.querySelectorAll('.npc-roster-item')).toHaveLength(0);
    expect(screen.getByText('NPC registered: Marta')).toBeInTheDocument();
  });

  it('falls back to plain content when a field has the wrong type', () => {
    render(() => (
      <NpcRosterResult content="NPC registered: Marta" extra={{ renderType: 'npc_roster', npcs: { Marta: { description: 42 } } }} />
    ));
    expect(document.querySelectorAll('.npc-roster-item')).toHaveLength(0);
    expect(screen.getByText('NPC registered: Marta')).toBeInTheDocument();
  });
});
