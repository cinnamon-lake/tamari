import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { DiceResult } from './DiceResult.js';

describe('DiceResult', () => {
  it('renders the total and dice notation', () => {
    render(() => (
      <DiceResult content="" extra={{ diceResult: 11, diceSides: 6, diceCount: 3, diceRolls: [4, 5, 2] }} />
    ));
    expect(screen.getByText('Dice Roll')).toBeInTheDocument();
    expect(document.querySelector('.dice-total')!.textContent).toBe('11');
    expect(document.querySelector('.dice-meta')!.textContent).toContain('(3d6)');
  });

  it('lists individual rolls when more than one die was rolled', () => {
    render(() => (
      <DiceResult content="" extra={{ diceResult: 11, diceSides: 6, diceCount: 3, diceRolls: [4, 5, 2] }} />
    ));
    expect(document.querySelector('.dice-rolls')!.textContent).toBe('4, 5, 2');
  });

  it('hides the rolls list for a single roll', () => {
    render(() => <DiceResult content="" extra={{ diceResult: 4, diceSides: 20, diceCount: 1, diceRolls: [4] }} />);
    expect(document.querySelector('.dice-rolls')).not.toBeInTheDocument();
    expect(document.querySelector('.dice-meta')!.textContent).toContain('(1d20)');
  });

  it('falls back to defaults when extra is missing', () => {
    render(() => <DiceResult content="" />);
    expect(document.querySelector('.dice-total')!.textContent).toBe('0');
    expect(document.querySelector('.dice-meta')!.textContent).toContain('(1d6)');
    expect(document.querySelector('.dice-rolls')).not.toBeInTheDocument();
  });
});
