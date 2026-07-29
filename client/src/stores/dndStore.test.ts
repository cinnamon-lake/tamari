import { describe, it, expect, beforeEach } from 'vitest';
import {
  pendingAttachments,
  pendingDropFiles,
  appendPendingAttachments,
  clearPendingAttachments,
  appendPendingDropFiles,
  clearPendingDropFiles,
} from './dndStore.js';

describe('dndStore', () => {
  beforeEach(() => {
    clearPendingAttachments();
    clearPendingDropFiles();
  });

  it('starts empty', () => {
    expect(pendingAttachments()).toHaveLength(0);
    expect(pendingDropFiles()).toHaveLength(0);
  });

  it('appendPendingAttachments adds items', () => {
    appendPendingAttachments([
      { id: 'a1', mimeType: 'text/plain', meta: {}, url: '' },
    ]);
    expect(pendingAttachments()).toHaveLength(1);
    expect(pendingAttachments()[0]!.mimeType).toBe('text/plain');
  });

  it('appendPendingAttachments accumulates', () => {
    appendPendingAttachments([{ id: 'a1', mimeType: 'text/plain', meta: {}, url: '' }]);
    appendPendingAttachments([{ id: 'a2', mimeType: 'text/plain', meta: {}, url: '' }]);
    expect(pendingAttachments()).toHaveLength(2);
  });

  it('clearPendingAttachments empties the list', () => {
    appendPendingAttachments([{ id: 'a1', mimeType: 'text/plain', meta: {}, url: '' }]);
    clearPendingAttachments();
    expect(pendingAttachments()).toHaveLength(0);
  });

  it('appendPendingDropFiles adds files', () => {
    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    appendPendingDropFiles([file]);
    expect(pendingDropFiles()).toHaveLength(1);
    expect(pendingDropFiles()[0]!.name).toBe('test.txt');
  });

  it('appendPendingDropFiles accumulates', () => {
    const f1 = new File(['a'], 'a.txt', { type: 'text/plain' });
    const f2 = new File(['b'], 'b.txt', { type: 'text/plain' });
    appendPendingDropFiles([f1]);
    appendPendingDropFiles([f2]);
    expect(pendingDropFiles()).toHaveLength(2);
  });

  it('clearPendingDropFiles empties the list', () => {
    appendPendingDropFiles([new File(['a'], 'a.txt', { type: 'text/plain' })]);
    clearPendingDropFiles();
    expect(pendingDropFiles()).toHaveLength(0);
  });

  it('attachments and drop files are independent', () => {
    appendPendingAttachments([{ id: 'a1', mimeType: 'text/plain', meta: {}, url: '' }]);
    appendPendingDropFiles([new File(['a'], 'a.txt', { type: 'text/plain' })]);
    expect(pendingAttachments()).toHaveLength(1);
    expect(pendingDropFiles()).toHaveLength(1);
    clearPendingAttachments();
    expect(pendingAttachments()).toHaveLength(0);
    expect(pendingDropFiles()).toHaveLength(1);
  });
});
