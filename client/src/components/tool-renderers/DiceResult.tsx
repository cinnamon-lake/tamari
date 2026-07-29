import { Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { ToolResultProps } from './index.js';
import { useI18n } from '../../i18n/index.js';
import './DiceResult.css';

export const DiceResult: Component<ToolResultProps> = (props) => {
  const { t } = useI18n();
  const data = () =>
    (props.extra ?? {}) as {
      diceResult?: number;
      diceSides?: number;
      diceCount?: number;
      diceRolls?: number[];
    };

  const result = () => data().diceResult ?? 0;
  const sides = () => data().diceSides ?? 6;
  const count = () => data().diceCount ?? 1;
  const rolls = () => data().diceRolls ?? [];

  return (
    <div class="tool-result-block dice-result">
      <div class="tool-result-header">
        <i class="bi bi-dice-5" /> {t('tools.diceRoll')}
      </div>
      <div class="tool-result-content">
        <div class="dice-roll-display">
          <span class="dice-total">{result()}</span>
          <span class="dice-meta">
            {' '}
            ({count()}d{sides()})
          </span>
        </div>
        <Show when={rolls().length > 1}>
          <div class="dice-rolls">{rolls().join(', ')}</div>
        </Show>
      </div>
    </div>
  );
};
