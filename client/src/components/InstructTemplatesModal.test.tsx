import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { InstructTemplatesModal } from './InstructTemplatesModal.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import * as popupStore from '../stores/popupStore.js';

describe('InstructTemplatesModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('settings', {});
    // setState('settings', {}) merges — clear the key outright so prior tests don't leak.
    setState('settings', 'instructTemplates', []);
  });

  it('renders and closes', () => {
    const onClose = vi.fn();
    render(() => <InstructTemplatesModal onClose={onClose} />);

    expect(screen.getByText('Custom Instruct Templates')).toBeInTheDocument();
    screen.getByTitle('Close').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('lists custom templates from settings and hides built-in ids', () => {
    setState('settings', 'instructTemplates', [
      { id: 'my-tpl', name: 'My Template' },
      { id: 'chatml', name: 'ChatML override' },
    ]);
    render(() => <InstructTemplatesModal onClose={() => {}} />);

    expect(screen.getByText('My Template')).toBeInTheDocument();
    expect(screen.queryByText('ChatML override')).not.toBeInTheDocument();
  });

  it('creates a new template and sends the update', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <InstructTemplatesModal onClose={() => {}} />);

    screen.getByText('New Template').click();

    fireEvent.input(screen.getByLabelText(/ID \(unique key\)/), { target: { value: 'command-r' } });
    fireEvent.input(screen.getByLabelText('Display Name'), { target: { value: 'Command-R' } });
    fireEvent.click(screen.getByText('Save Template'));
    await new Promise((r) => setTimeout(r, 10));

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'settings.set',
      key: 'instructTemplates',
      value: [expect.objectContaining({ id: 'command-r', name: 'Command-R' })],
    });
  });

  it('rejects a reserved built-in id', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    const alertSpy = vi.spyOn(popupStore, 'alertPopup').mockResolvedValue(undefined);
    render(() => <InstructTemplatesModal onClose={() => {}} />);

    screen.getByText('New Template').click();
    fireEvent.input(screen.getByLabelText(/ID \(unique key\)/), { target: { value: 'chatml' } });
    fireEvent.input(screen.getByLabelText('Display Name'), { target: { value: 'Nope' } });
    fireEvent.click(screen.getByText('Save Template'));
    await new Promise((r) => setTimeout(r, 10));

    expect(alertSpy).toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'instructTemplates' }));
  });

  it('deletes a template when confirmed', async () => {
    vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('settings', 'instructTemplates', [{ id: 'my-tpl', name: 'My Template' }]);
    render(() => <InstructTemplatesModal onClose={() => {}} />);

    screen.getByTitle('Delete').click();
    await new Promise((r) => setTimeout(r, 10));

    expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'instructTemplates', value: [] });
  });
});
