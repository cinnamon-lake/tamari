import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { WorldInfoEditor } from './WorldInfoEditor.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { setActiveWorldInfoId, activeWorldInfoId } from '../stores/uiStore.js';
import * as popupStore from '../stores/popupStore.js';

describe('WorldInfoEditor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('worldInfo', []);
    setState('activeWorldInfo', null);
    setActiveWorldInfoId(null);
  });

  it('sends worldinfo.list on mount', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <WorldInfoEditor onClose={() => {}} />);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'worldinfo.list' }));
  });

  it('renders list of books', () => {
    setState('worldInfo', [
      { id: 'book-1', name: 'Lore A', entries: [{ id: 'e1', keys: ['magic'], content: '', comment: '', order: 0, position: 'before_char', probability: 100, constant: false, selective: false, secondaryKeys: [], addMemo: false, disable: false, regex: false, recursive: false }], createdAt: Date.now(), updatedAt: Date.now() },
      { id: 'book-2', name: 'Lore B', entries: [], createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    render(() => <WorldInfoEditor onClose={() => {}} />);
    expect(screen.getByText('Lore A')).toBeInTheDocument();
    expect(screen.getByText('Lore B')).toBeInTheDocument();
    expect(screen.getByText('1 entries')).toBeInTheDocument();
    expect(screen.getByText('0 entries')).toBeInTheDocument();
  });

  it('clicking book sets activeWorldInfoId and sends worldinfo.select', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('worldInfo', [{ id: 'book-1', name: 'Lore A', entries: [], createdAt: Date.now(), updatedAt: Date.now() }]);
    render(() => <WorldInfoEditor onClose={() => {}} />);
    screen.getByText('Lore A').click();
    // activeWorldInfoId signal should be updated
    expect(activeWorldInfoId()).toBe('book-1');
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'worldinfo.select',
      bookId: 'book-1',
    }));
  });

  it('creates new lorebook', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <WorldInfoEditor onClose={() => {}} />);
    screen.getByText('New Lorebook').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'worldinfo.create',
      data: expect.objectContaining({ name: 'New Lorebook' }),
    }));
  });

  it('calls onClose when overlay clicked', () => {
    const onClose = vi.fn();
    const { container } = render(() => <WorldInfoEditor onClose={onClose} />);
    const overlay = container.querySelector('.modal-overlay')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  describe('BookEditor', () => {
    beforeEach(() => {
      setState('activeWorldInfo', {
        id: 'book-1',
        name: 'Test Book',
        entries: [
          { id: 'e1', keys: ['fire'], content: 'Fire is hot', comment: '', order: 100, position: 'before_char', probability: 100, constant: false, selective: false, secondaryKeys: [], addMemo: false, disable: false, regex: false, recursive: false },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      setActiveWorldInfoId('book-1');
    });

    it('renders book name input', () => {
      render(() => <WorldInfoEditor onClose={() => {}} />);
      expect(screen.getByDisplayValue('Test Book')).toBeInTheDocument();
    });

    it('sends worldinfo.update on name blur', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <WorldInfoEditor onClose={() => {}} />);
      const input = screen.getByDisplayValue('Test Book');
      fireEvent.input(input, { target: { value: 'Updated Book' } });
      fireEvent.blur(input);
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'worldinfo.update',
        bookId: 'book-1',
        patch: { name: 'Updated Book' },
      }));
    });

    it('renders entry list', () => {
      render(() => <WorldInfoEditor onClose={() => {}} />);
      expect(screen.getByText('fire')).toBeInTheDocument();
    });

    it('clicking entry opens editor', () => {
      render(() => <WorldInfoEditor onClose={() => {}} />);
      screen.getByText('fire').click();
      expect(screen.getByText('Keys (comma separated)')).toBeInTheDocument();
    });

    it('sends worldinfo.entry.create when adding entry', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <WorldInfoEditor onClose={() => {}} />);
      screen.getByText('Add Entry').click();
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'worldinfo.entry.create',
        bookId: 'book-1',
      }));
    });

    it('sends worldinfo.test when running test', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <WorldInfoEditor onClose={() => {}} />);
      const textarea = document.querySelector('textarea[placeholder*="sample text"]') as HTMLTextAreaElement;
      fireEvent.input(textarea, { target: { value: 'test input' } });
      screen.getByText('Test').click();
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'worldinfo.test',
        text: 'test input',
      }));
    });

    it('deletes book when confirmed', async () => {
      vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <WorldInfoEditor onClose={() => {}} />);
      screen.getByText('Delete Lorebook').click();
      await new Promise((r) => setTimeout(r, 10));
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'worldinfo.delete',
        bookId: 'book-1',
      }));
    });
  });

  describe('EntryEditor', () => {
    beforeEach(() => {
      setState('activeWorldInfo', {
        id: 'book-1',
        name: 'Test Book',
        entries: [
          { id: 'e1', keys: ['fire'], content: 'Fire is hot', comment: '', order: 100, position: 'before_char', probability: 100, constant: false, selective: false, secondaryKeys: [], addMemo: false, disable: false, regex: false, recursive: false },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      setActiveWorldInfoId('book-1');
    });

    it('edits keys and saves on blur', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <WorldInfoEditor onClose={() => {}} />);
      screen.getByText('fire').click();

      const keysInput = screen.getByLabelText('Keys (comma separated)');
      fireEvent.input(keysInput, { target: { value: 'fire, flame' } });
      fireEvent.blur(keysInput);

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'worldinfo.entry.update',
        entryId: 'e1',
        patch: expect.objectContaining({ keys: ['fire', 'flame'] }),
      }));
    });

    it('saves position atDepth with depth and role', async () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <WorldInfoEditor onClose={() => {}} />);
      screen.getByText('fire').click();

      const select = document.querySelector('select') as HTMLSelectElement;
      select.value = 'atDepth';
      fireEvent.change(select, { target: { value: 'atDepth' } });

      await new Promise((r) => setTimeout(r, 700));

      // After changing position, save should include depth/role
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'worldinfo.entry.update',
        patch: expect.objectContaining({
          position: 'atDepth',
          depth: expect.any(Number),
          role: expect.any(String),
        }),
      }));
    });

    it('saves non-atDepth position without depth and role', async () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <WorldInfoEditor onClose={() => {}} />);
      screen.getByText('fire').click();

      const select = document.querySelector('select') as HTMLSelectElement;
      select.value = 'top';
      fireEvent.change(select, { target: { value: 'top' } });

      await new Promise((r) => setTimeout(r, 700));

      const call = sendSpy.mock.calls.find((c) => (c[0] as any).type === 'worldinfo.entry.update');
      expect(call).toBeDefined();
      const patch = (call![0] as any).patch;
      expect(patch.position).toBe('top');
      expect(patch.depth).toBeUndefined();
      expect(patch.role).toBeUndefined();
    });

    it('deletes entry', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <WorldInfoEditor onClose={() => {}} />);
      screen.getByText('fire').click();
      screen.getByText('Delete').click();
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'worldinfo.entry.delete',
        entryId: 'e1',
      }));
    });
  });
});
