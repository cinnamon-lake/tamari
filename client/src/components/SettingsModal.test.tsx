import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { SettingsModal } from './SettingsModal.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('settings', {});
  });

  it('renders and closes', () => {
    const onClose = vi.fn();
    render(() => <SettingsModal onClose={onClose} />);

    expect(screen.getByText('Settings')).toBeInTheDocument();
    screen.getByText('Close').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('toggles a boolean setting and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Show message token counts');
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'messageTokenCountEnabled', value: true });
  });

  it('toggles stream fade-in setting and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Fade in streamed text');
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'streamFadeIn', value: false });
  });

  it('changes toast position setting and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const select = screen.getByLabelText<HTMLSelectElement>('Toast position');
    expect(select.value).toBe('top-right');

    fireEvent.change(select, { target: { value: 'bottom-left' } });
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'toastPosition', value: 'bottom-left' });
  });

  it('changes toast position to a center option and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const select = screen.getByLabelText<HTMLSelectElement>('Toast position');
    expect(Array.from(select.options).map((o) => o.value)).toContain('bottom-center');

    fireEvent.change(select, { target: { value: 'bottom-center' } });
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'toastPosition', value: 'bottom-center' });
  });

  it('toggles hide chat avatars setting and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Hide chat avatars');
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'hideChatAvatars', value: true });
  });

  it('toggles hide chat names setting and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Hide chat names');
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'hideChatNames', value: true });
  });

  it('toggles unfocused-only message sound and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Only play sound when unfocused');
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'messageSoundUnfocusedOnly', value: false });
  });

  it('toggles swipe numbers on all messages and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Show swipe numbers on all messages');
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'swipeNumbersOnAllMessages', value: true });
  });

  it('toggles show message IDs and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Show message IDs');
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'showMessageIds', value: true });
  });

  it('toggles auto-load last chat and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Load last chat on startup');
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'autoLoadLastChat', value: true });
  });

  it('toggles encode tags and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Show raw message text (encode tags)');
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'encodeTags', value: true });
  });

  it('toggles allow external images and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>(/Allow external images/i);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'allowExternalMedia', value: true });
  });

  it('toggles fuzzy character search and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>(/Fuzzy character search/i);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'fuzzySearch', value: true });
  });

  it('toggles recently-used character bar and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>(/Show recently-used character bar/i);
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'showHotswapBar', value: false });
  });

  it('toggles memory enabled and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>(/Enable rolling memory/i);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'settings.set',
      key: 'memory',
      value: expect.objectContaining({ enabled: true }),
    });
    // The summarization prompt moved to the prompt list — no longer in memory settings.
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'settings.set',
      key: 'memory',
      value: expect.not.objectContaining({ systemPrompt: expect.anything() }),
    });
  });

  it('changes memory backend config and sends the update', () => {
    setState('backendConfigs', [{ id: 'bc1', name: 'Cheap' }]);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const select = screen.getByLabelText<HTMLInputElement>(/Summarization backend/i);
    fireEvent.change(select, { target: { value: 'bc1' } });
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'settings.set',
      key: 'memory',
      value: expect.objectContaining({ backendConfigId: 'bc1' }),
    });
  });

  it('changes memory update interval and sends the update', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    const input = screen.getByLabelText<HTMLInputElement>(/Update interval/i);
    fireEvent.change(input, { target: { value: '10' } });
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'settings.set',
      key: 'memory',
      value: expect.objectContaining({ updateInterval: 10 }),
    });
  });

  it('adds and removes custom stopping strings', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <SettingsModal onClose={() => {}} />);

    screen.getByText('Add stop string').click();
    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'customStoppingStrings', value: [''] });

    const inputs = document.querySelectorAll('[id^="stop-str-"] input');
    expect(inputs.length).toBe(1);

    const removeBtn = document.querySelector('[id^="stop-str-"] button[title="Remove"]') as HTMLButtonElement;
    removeBtn.click();
    expect(sendSpy).toHaveBeenLastCalledWith({ type: 'settings.set', key: 'customStoppingStrings', value: [] });
  });

  it('disables memory sub-fields while memory is disabled', () => {
    render(() => <SettingsModal onClose={() => {}} />);

    expect(screen.getByLabelText<HTMLInputElement>(/Update interval/i).disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>(/Summarization backend/i).disabled).toBe(true);
  });

  it('enables memory sub-fields when memory is enabled', () => {
    setState('settings', 'memory', 'enabled', true);
    render(() => <SettingsModal onClose={() => {}} />);

    expect(screen.getByLabelText<HTMLInputElement>(/Update interval/i).disabled).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>(/Summarization backend/i).disabled).toBe(false);
  });

  it('disables unfocused-only sound toggle while message sound is off', () => {
    render(() => <SettingsModal onClose={() => {}} />);
    expect(screen.getByLabelText<HTMLInputElement>(/Only play sound when unfocused/i).disabled).toBe(true);
  });

  it('disables smooth streaming delay while smooth streaming is off', () => {
    render(() => <SettingsModal onClose={() => {}} />);
    expect(screen.getByLabelText<HTMLInputElement>(/Delay between tokens/i).disabled).toBe(true);
  });

  it('disables avatar style while chat avatars are hidden', () => {
    setState('settings', 'hideChatAvatars', true);
    render(() => <SettingsModal onClose={() => {}} />);
    expect(screen.getByLabelText<HTMLSelectElement>(/Avatar Style/i).disabled).toBe(true);
  });

  it('locks the full post-processing/macro set when append-only layout is on', () => {
    setState('settings', 'appendOnlyPromptLayout', true);
    render(() => <SettingsModal onClose={() => {}} />);

    expect(screen.getByLabelText<HTMLInputElement>(/Auto-fix generated markdown/i).disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>(/Resolve macros in custom stopping strings/i).disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>(/Remove XML tags/i).disabled).toBe(true);
  });

  it('renders sections in the expected order with no duplicate headings', () => {
    render(() => <SettingsModal onClose={() => {}} />);

    const headings = Array.from(document.querySelectorAll('.section-heading')).map((h) => h.textContent);
    expect(headings).toEqual([
      'Language',
      'Display',
      'Chat behavior',
      'Input & Interaction',
      'Generation',
      'Post-processing',
      'Sound & Streaming',
      'Notifications',
      'Memory',
      'Security & content',
      'Theme',
      'Developer',
    ]);
    expect(new Set(headings).size).toBe(headings.length);
  });
});
