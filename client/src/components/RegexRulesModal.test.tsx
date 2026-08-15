import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { RegexRulesModal } from './RegexRulesModal.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import * as popupStore from '../stores/popupStore.js';

describe('RegexRulesModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('settings', {});
    // setState('settings', {}) merges — clear the key outright so prior tests don't leak.
    setState('settings', 'regexRules', []);
    setState('settings', 'appendOnlyPromptLayout', false);
  });

  it('renders and closes', () => {
    const onClose = vi.fn();
    render(() => <RegexRulesModal onClose={onClose} />);

    expect(screen.getByText('Regex Rules')).toBeInTheDocument();
    screen.getByTitle('Close').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('lists regex rules from settings', () => {
    setState('settings', 'regexRules', [
      { id: 'r1', name: 'Strip asterisks', findRegex: '/\\*{2,}/g', replaceString: '*', aiOutput: true },
    ]);
    render(() => <RegexRulesModal onClose={() => {}} />);

    expect(screen.getByText('Strip asterisks')).toBeInTheDocument();
  });

  it('renders regex replace type as a radio group', () => {
    render(() => <RegexRulesModal onClose={() => {}} />);

    screen.getByText('New Regex Rule').click();
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="regexReplaceType"]'));
    expect(radios.length).toBe(2);
    const [textRadio, luaRadio] = radios as [HTMLInputElement, HTMLInputElement];
    expect(textRadio.checked).toBe(true);

    fireEvent.click(luaRadio);
    expect(luaRadio.checked).toBe(true);
    expect(textRadio.checked).toBe(false);
  });

  it('saves a new rule and sends the update', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <RegexRulesModal onClose={() => {}} />);

    screen.getByText('New Regex Rule').click();
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Strip asterisks' } });
    fireEvent.input(screen.getByLabelText('Find Regex'), { target: { value: '/\\*{2,}/g' } });
    fireEvent.click(screen.getByText('Save Rule'));
    await new Promise((r) => setTimeout(r, 10));

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'settings.set',
      key: 'regexRules',
      value: [expect.objectContaining({ name: 'Strip asterisks', findRegex: '/\\*{2,}/g' })],
    });
  });

  it('rejects an invalid regex format', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    const alertSpy = vi.spyOn(popupStore, 'alertPopup').mockResolvedValue(undefined);
    render(() => <RegexRulesModal onClose={() => {}} />);

    screen.getByText('New Regex Rule').click();
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Bad rule' } });
    fireEvent.input(screen.getByLabelText('Find Regex'), { target: { value: 'not-a-regex' } });
    fireEvent.click(screen.getByText('Save Rule'));
    await new Promise((r) => setTimeout(r, 10));

    expect(alertSpy).toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'regexRules' }));
  });

  it('deletes a rule when confirmed', async () => {
    vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('settings', 'regexRules', [
      { id: 'r1', name: 'Strip asterisks', findRegex: '/\\*{2,}/g', replaceString: '*', aiOutput: true },
    ]);
    render(() => <RegexRulesModal onClose={() => {}} />);

    screen.getByTitle('Delete').click();
    await new Promise((r) => setTimeout(r, 10));

    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'regexRules', value: [] });
  });

  it('shows the append-only prompt note when the setting is on and prompt placement is checked', () => {
    setState('settings', 'appendOnlyPromptLayout', true);
    render(() => <RegexRulesModal onClose={() => {}} />);

    screen.getByText('New Regex Rule').click();
    expect(screen.queryByText(/locked off while append-only/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Prompt'));
    expect(screen.getByText(/locked off while append-only/i)).toBeInTheDocument();
  });
});
