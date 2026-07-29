import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { PromptListModal } from './PromptListModal.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import * as popupStore from '../stores/popupStore.js';
import type { PromptList } from '@tamari/types';

describe('PromptListModal', () => {
  const sampleList: PromptList = {
    id: 'list-1',
    name: 'Test List',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    prompts: [
      {
        identifier: 'main',
        name: 'Main Prompt',
        content: 'Write reply.',
        role: 'system',
        enabled: true,
      },
      {
        identifier: 'enhanceDefinitions',
        name: 'Enhance Definitions',
        content: 'Enhance.',
        role: 'system',
        enabled: false,
      },
    ],
    promptOrder: [
      { identifier: 'main', enabled: true },
      { identifier: 'enhanceDefinitions', enabled: false },
    ],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    setState('activePromptList', sampleList);
    setState('promptLists', [sampleList]);
  });

  it('renders the active prompt list and closes', () => {
    const onClose = vi.fn();
    render(() => <PromptListModal onClose={onClose} />);

    expect(screen.getByText('Prompt List')).toBeInTheDocument();
    expect(screen.getByText('Test List')).toBeInTheDocument();

    screen.getByText('Close').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('toggles a prompt enabled state and autosaves', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <PromptListModal onClose={() => {}} />);

    const checkbox = screen.getByLabelText<HTMLInputElement>('Enable Main Prompt');
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    await waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'promptList.update',
          promptListId: 'list-1',
          patch: expect.objectContaining({
            promptOrder: expect.arrayContaining([expect.objectContaining({ identifier: 'main', enabled: false })]),
          }),
        }),
      ),
    );
  });

  it('cancels a pending autosave when the active list is deleted', async () => {
    vi.useFakeTimers();
    try {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
      setState('promptLists', [sampleList, { ...sampleList, id: 'list-2', name: 'Other List' }]);
      render(() => <PromptListModal onClose={() => {}} />);

      // Local edit -> debounced save pending.
      fireEvent.click(screen.getByLabelText<HTMLInputElement>('Enable Main Prompt'));
      // Delete before the 500ms debounce fires.
      fireEvent.click(screen.getByText('Delete List'));
      await vi.advanceTimersByTimeAsync(1000);

      expect(sendSpy).toHaveBeenCalledWith({ type: 'promptList.delete', promptListId: 'list-1' });
      // The fix: no promptList.update may fire after the delete.
      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'promptList.update' }));
    } finally {
      vi.useRealTimers();
    }
  });
});
