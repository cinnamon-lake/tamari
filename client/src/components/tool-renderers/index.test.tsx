import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import type { Message } from '@tamari/types';
import { getToolRenderer, getRenderableToolParts, mountToolWidgets } from './index.js';
import { DiceResult } from './DiceResult.js';
import { ChoicesResult } from './ChoicesResult.js';
import { NpcRosterResult } from './NpcRosterResult.js';
import { SceneResult } from './SceneResult.js';
import { MapResult } from './MapResult.js';

describe('tool-renderers', () => {
  describe('getToolRenderer', () => {
    it('returns DiceResult for dice type', () => {
      expect(getToolRenderer('dice')).toBe(DiceResult);
    });

    it('returns ChoicesResult for choices type', () => {
      expect(getToolRenderer('choices')).toBe(ChoicesResult);
    });

    it('returns NpcRosterResult for npc_roster type', () => {
      expect(getToolRenderer('npc_roster')).toBe(NpcRosterResult);
    });

    it('returns SceneResult for scene type', () => {
      expect(getToolRenderer('scene')).toBe(SceneResult);
    });

    it('returns MapResult for map type', () => {
      expect(getToolRenderer('map')).toBe(MapResult);
    });

    it('returns default renderer for unknown type', () => {
      const Renderer = getToolRenderer('unknown');
      render(() => <Renderer content="Hello" />);
      expect(screen.getByText('Result')).toBeInTheDocument();
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });

    it('returns default renderer when type is undefined', () => {
      const Renderer = getToolRenderer(undefined);
      render(() => <Renderer content="Fallback" isError />);
      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.getByText('Fallback')).toBeInTheDocument();
    });
  });

  describe('DiceResult', () => {
    it('renders default dice values', () => {
      render(() => <DiceResult content="You rolled" />);
      expect(screen.getByText('0')).toBeInTheDocument();
      expect(screen.getByText('(1d6)')).toBeInTheDocument();
    });

    it('renders provided dice result', () => {
      render(() => (
        <DiceResult
          content="Rolled 15"
          extra={{ diceResult: 15, diceSides: 20, diceCount: 1, diceRolls: [15] }}
        />
      ));
      expect(screen.getByText('15')).toBeInTheDocument();
      expect(screen.getByText('(1d20)')).toBeInTheDocument();
    });

    it('renders multiple rolls', () => {
      render(() => (
        <DiceResult
          content="Rolled"
          extra={{ diceResult: 12, diceSides: 6, diceCount: 3, diceRolls: [4, 3, 5] }}
        />
      ));
      expect(screen.getByText('12')).toBeInTheDocument();
      expect(screen.getByText('4, 3, 5')).toBeInTheDocument();
    });

    it('hides rolls list for single roll', () => {
      render(() => (
        <DiceResult
          content="Rolled"
          extra={{ diceResult: 5, diceSides: 6, diceCount: 1, diceRolls: [5] }}
        />
      ));
      expect(screen.queryByText('5, 5')).not.toBeInTheDocument();
    });
  });
});

describe('getRenderableToolParts', () => {
  function makeMessage(parts: unknown): Message {
    return {
      id: 1,
      parentId: null,
      role: 'assistant',
      extra: { parts: parts as Message["extra"]["parts"] },
      createdAt: 0,
      updatedAt: 0,
    };
  }

  it('finds tool_result parts with a renderType', () => {
    const parts = getRenderableToolParts(
      makeMessage([
        { type: 'text', text: 'narration' },
        {
          type: 'tool_result',
          content: 'Presented 2 choices',
          extra: { renderType: 'choices', choices: ['A', 'B'] },
        },
      ]),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      content: 'Presented 2 choices',
      isError: false,
      extra: { renderType: 'choices', choices: ['A', 'B'] },
      index: 1,
    });
  });

  it('ignores parts without a renderType and non-tool_result parts', () => {
    const parts = getRenderableToolParts(
      makeMessage([
        { type: 'tool_result', content: 'plain result' },
        { type: 'tool_result', content: 'no string', extra: { renderType: 42 } },
        { type: 'tool_use', name: 'roll_dice', extra: { renderType: 'dice' } },
      ]),
    );
    expect(parts).toHaveLength(0);
  });

  it('keeps unregistered renderTypes for the default fallback renderer', () => {
    const parts = getRenderableToolParts(
      makeMessage([
        { type: 'tool_result', content: 'future widget', extra: { renderType: 'hologram' } },
      ]),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]!.extra.renderType).toBe('hologram');
    expect(parts[0]!.index).toBe(0);
  });

  it('returns an empty array when parts are missing or not an array', () => {
    expect(getRenderableToolParts(makeMessage(undefined))).toEqual([]);
    expect(getRenderableToolParts(makeMessage('nope'))).toEqual([]);
  });

  it('preserves the isError flag', () => {
    const parts = getRenderableToolParts(
      makeMessage([
        { type: 'tool_result', content: 'boom', isError: true, extra: { renderType: 'choices' } },
      ]),
    );
    expect(parts[0]!.isError).toBe(true);
  });
});


describe('mountToolWidgets', () => {
  function makeMessage(parts: unknown): Message {
    return {
      id: 7,
      parentId: null,
      role: 'assistant',
      extra: { parts: parts as Message["extra"]["parts"] },
      createdAt: 0,
      updatedAt: 0,
    };
  }

  function makeContainer(...partIndices: number[]): HTMLElement {
    const container = document.createElement('div');
    for (const index of partIndices) {
      const slot = document.createElement('div');
      slot.className = 'tool-widget-slot';
      slot.dataset.partIndex = String(index);
      container.appendChild(slot);
    }
    document.body.appendChild(container);
    return container;
  }

  it('mounts the registered widget into the slot for its part index', () => {
    const container = makeContainer(1);
    const message = makeMessage([
      { type: 'text', text: 'pick one' },
      {
        type: 'tool_result',
        content: 'Presented 2 choices',
        extra: { renderType: 'choices', choicesPrompt: 'Which way?', choices: ['Left', 'Right'] },
      },
    ]);
    const dispose = mountToolWidgets(container, message, {});
    const slot = container.querySelector('.tool-widget-slot')!;
    expect(slot.querySelector('.choices-result')).not.toBeNull();
    expect(slot.querySelector('.choices-prompt')!.textContent).toBe('Which way?');
    expect(slot.querySelectorAll('.choice-btn')).toHaveLength(2);
    dispose();
    container.remove();
  });

  it('falls back to the default renderer for unregistered renderTypes', () => {
    const container = makeContainer(0);
    const message = makeMessage([
      { type: 'tool_result', content: 'future widget', extra: { renderType: 'hologram' } },
    ]);
    const dispose = mountToolWidgets(container, message, {});
    const slot = container.querySelector('.tool-widget-slot')!;
    expect(slot.querySelector('.tool-result-block')).not.toBeNull();
    expect(slot.textContent).toContain('future widget');
    dispose();
    container.remove();
  });

  it('passes disabled through to the widget', () => {
    const container = makeContainer(0);
    const message = makeMessage([
      {
        type: 'tool_result',
        content: 'Presented 1 choice',
        extra: { renderType: 'choices', choices: ['Only'] },
      },
    ]);
    const dispose = mountToolWidgets(container, message, { disabled: true });
    const btn = container.querySelector<HTMLButtonElement>('.choice-btn')!;
    expect(btn.disabled).toBe(true);
    dispose();
    container.remove();
  });

  it('mounts each slot from its own data-part-index', () => {
    const container = makeContainer(0, 2);
    const message = makeMessage([
      {
        type: 'tool_result',
        content: 'Rolled 7',
        extra: { renderType: 'dice', diceResult: 7, diceSides: 6, diceCount: 1, diceRolls: [7] },
      },
      { type: 'text', text: 'between' },
      {
        type: 'tool_result',
        content: 'Presented 1 choice',
        extra: { renderType: 'choices', choices: ['Go'] },
      },
    ]);
    const dispose = mountToolWidgets(container, message, {});
    const slots = container.querySelectorAll('.tool-widget-slot');
    expect(slots[0]!.querySelector('.dice-result')).not.toBeNull();
    expect(slots[1]!.querySelector('.choices-result')).not.toBeNull();
    dispose();
    container.remove();
  });

  it('dispose removes all mounted content', () => {
    const container = makeContainer(0);
    const message = makeMessage([
      {
        type: 'tool_result',
        content: 'Presented 1 choice',
        extra: { renderType: 'choices', choices: ['Go'] },
      },
    ]);
    const dispose = mountToolWidgets(container, message, {});
    const slot = container.querySelector('.tool-widget-slot')!;
    expect(slot.querySelector('.choices-result')).not.toBeNull();
    dispose();
    expect(slot.querySelector('.choices-result')).toBeNull();
    expect(slot.innerHTML).toBe('');
    container.remove();
  });
});
