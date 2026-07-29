import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadAttachments } from './uploadAttachments.js';
import * as apiFetchModule from './apiFetch.js';

describe('uploadAttachments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function makeFile(name: string, type: string, content: string): File {
    const file = new File([content], name, { type });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode(content).buffer),
      configurable: true,
      writable: true,
    });
    return file;
  }

  it('uploads a single file and returns attachment ref', async () => {
    const attachment = { id: 'att-1', url: '/api/attachments/att-1', mimeType: 'image/png', meta: { name: 'test.png' } };
    vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(attachment),
    } as unknown as Response);

    const file = makeFile('test.png', 'image/png', 'fake-image-data');
    const result = await uploadAttachments([file]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(attachment);
    expect(apiFetchModule.apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetchModule.apiFetch).toHaveBeenCalledWith('/api/attachments', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  it('uploads multiple files', async () => {
    const attachments = [
      { id: 'att-1', url: '/api/attachments/att-1', mimeType: 'image/png', meta: { name: 'a.png' } },
      { id: 'att-2', url: '/api/attachments/att-2', mimeType: 'text/plain', meta: { name: 'b.txt' } },
    ];
    let callCount = 0;
    vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue({
      ok: true,
      json: vi.fn().mockImplementation(() => attachments[callCount++]),
    } as unknown as Response);

    const files = [makeFile('a.png', 'image/png', 'data1'), makeFile('b.txt', 'text/plain', 'data2')];
    const result = await uploadAttachments(files);

    expect(apiFetchModule.apiFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('handles upload failure gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue({
      ok: false,
      status: 413,
      json: vi.fn().mockResolvedValue({ error: 'File too large' }),
    } as unknown as Response);

    const file = makeFile('big.png', 'image/png', 'x'.repeat(1000));
    const result = await uploadAttachments([file]);

    expect(result).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles network error gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(apiFetchModule, 'apiFetch').mockRejectedValue(new Error('Network error'));

    const file = makeFile('test.png', 'image/png', 'data');
    const result = await uploadAttachments([file]);

    expect(result).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('includes correct base64 data in request body', async () => {
    const apiFetchSpy = vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: 'att-1' }),
    } as unknown as Response);

    const file = makeFile('test.txt', 'text/plain', 'hello');
    await uploadAttachments([file]);

    expect(apiFetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(apiFetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.mimeType).toBe('text/plain');
    expect(body.data).toBe(btoa('hello'));
    expect(body.meta).toEqual({ name: 'test.txt', size: 5 });
  });
});
