import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { getToolRenderer } from './index.js';
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
