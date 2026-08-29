import { describe, it, expect } from 'vitest';
import { readSseEvents, type SseStreamItem } from './sseReader.js';

function streamFromChunks(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<SseStreamItem[]> {
  const items: SseStreamItem[] = [];
  for await (const item of readSseEvents(body, signal)) {
    items.push(item);
  }
  return items;
}

describe('readSseEvents', () => {
  it('parses multiple data events in a single chunk', async () => {
    const items = await collect(streamFromChunks(['data: {"a":1}\ndata: {"b":2}\n']));
    expect(items).toEqual([
      { type: 'event', data: '{"a":1}', line: 'data: {"a":1}', eventType: '' },
      { type: 'event', data: '{"b":2}', line: 'data: {"b":2}', eventType: '' },
    ]);
  });

  it('reassembles a line split across chunks', async () => {
    const items = await collect(streamFromChunks(['data: {"tex', 't":"hello"}\ndata: {"n":2}\n']));
    expect(items.map((i) => (i.type === 'event' ? i.data : i.type))).toEqual(['{"text":"hello"}', '{"n":2}']);
  });

  it('handles a multi-byte UTF-8 character split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"héllo"}\n');
    const splitAt = bytes.indexOf(0xc3); // first byte of 'é'
    const items = await collect(streamFromChunks([bytes.subarray(0, splitAt + 1), bytes.subarray(splitAt + 1)]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'event', data: '{"text":"héllo"}' });
  });

  it('yields a done item for the [DONE] sentinel', async () => {
    const items = await collect(streamFromChunks(['data: {"a":1}\ndata: [DONE]\n']));
    expect(items.map((i) => i.type)).toEqual(['event', 'done']);
  });

  it('trims whitespace around lines and payloads', async () => {
    const items = await collect(streamFromChunks(['  data:   {"a":1}  \r\n']));
    expect(items).toEqual([{ type: 'event', data: '{"a":1}', line: 'data:   {"a":1}', eventType: '' }]);
  });

  it('tracks event: lines within a chunk and resets per chunk', async () => {
    const items = await collect(streamFromChunks(['event: message_start\ndata: {"a":1}\n', 'data: {"b":2}\n']));
    expect(items.map((i) => (i.type === 'event' ? i.eventType : i.type))).toEqual(['message_start', '']);
  });

  it('ignores blank lines, comments, and other non-data lines', async () => {
    const items = await collect(streamFromChunks(['\n: keep-alive\r\nevent: ping\n\ndata: {"a":1}\n\n']));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'event', data: '{"a":1}', eventType: 'ping' });
  });

  it('discards a trailing partial line at end of stream', async () => {
    const items = await collect(streamFromChunks(['data: {"a":1}\ndata: {"trunc']));
    expect(items.map((i) => (i.type === 'event' ? i.data : i.type))).toEqual(['{"a":1}']);
  });

  it('yields an aborted item when the signal fires before the next chunk', async () => {
    const controller = new AbortController();
    controller.abort();
    // A stream that never delivers: the aborted check runs before the read.
    const body = new ReadableStream<Uint8Array>({ pull() {} });
    const items = await collect(body, controller.signal);
    expect(items).toEqual([{ type: 'aborted' }]);
  });

  it('releases the reader lock when done', async () => {
    const body = streamFromChunks(['data: {"a":1}\n']);
    await collect(body);
    expect(body.locked).toBe(false);
  });
});
