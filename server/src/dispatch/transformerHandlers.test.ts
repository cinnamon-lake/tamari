/**
 * transformerchain.* / transformerscript.* WS handlers: CRUD over request
 * transformer chains and Lua scripts (full-list rebroadcast after every
 * mutation), plus the save-free `transformerscript.validate` load-check.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness, type TestClient } from '../testing/TestHarness.js';

const VALID_LUA = 'function handle(messages, ctx) return messages end';
const INVALID_LUA = 'this is not lua (((';
// Loads cleanly but defines no handle() entry point.
const NO_HANDLE_LUA = 'local x = 1';

describe('transformerchain handlers', () => {
  let h: TestHarness;
  let client: TestClient;

  const lastError = () => [...client.messages].reverse().find((m) => m.type === 'error');

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('transformerchain.list replies only to the requesting client', async () => {
    await h.deps.transformerChains.create('tc-1', { name: 'One', description: '', steps: [] });
    const other = h.connectClient();

    await h.send(client, { type: 'transformerchain.list' } as never);

    const listed = client.messages.find((m) => m.type === 'transformerchain.listed');
    expect(listed).toBeDefined();
    // Migration 020 seeds a "Default" chain, so the list holds it plus 'tc-1'.
    const items = (listed as { items: { id: string }[] }).items;
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.id === 'tc-1')).toBe(true);
    // Request/response, not shared state — the other client gets nothing.
    expect(other.messages.find((m) => m.type === 'transformerchain.listed')).toBeUndefined();
  });

  it('transformerchain.get returns the item as transformerchain.snapshot', async () => {
    const item = await h.deps.transformerChains.create('tc-1', { name: 'One', description: '', steps: [] });
    await h.send(client, { type: 'transformerchain.get', id: item.id } as never);
    const reply = client.messages.find((m) => m.type === 'transformerchain.snapshot');
    expect(reply).toMatchObject({ type: 'transformerchain.snapshot' });
    expect((reply as { item: { id: string } }).item.id).toBe(item.id);
  });

  it('transformerchain.get on a missing id replies NOT_FOUND', async () => {
    await h.send(client, { type: 'transformerchain.get', id: 'no-such' } as never);
    expect(lastError()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
  });

  it('transformerchain.save without id creates and broadcasts created plus a reconverged list', async () => {
    await h.send(client, {
      type: 'transformerchain.save',
      data: {
        name: 'New',
        description: 'd',
        steps: [{ kind: 'builtin', id: 'whitespace', enabled: true }],
      },
    } as never);

    const created = h.expectBroadcast('transformerchain.created');
    expect(created.clientId).toBe(client.connection.id);
    expect(created.item.name).toBe('New');
    expect(created.item.steps).toHaveLength(1);
    const listed = h.expectBroadcast('transformerchain.listed');
    expect((listed.items as { id: string }[]).some((i) => i.id === created.item.id)).toBe(true);
  });

  it('transformerchain.save with id updates and broadcasts updated plus a reconverged list', async () => {
    const item = await h.deps.transformerChains.create('tc-1', { name: 'Old', description: '', steps: [] });
    await h.send(client, {
      type: 'transformerchain.save',
      id: item.id,
      data: { name: 'Renamed', description: '', steps: [] },
    } as never);

    const updated = h.expectBroadcast('transformerchain.updated');
    expect(updated.item.name).toBe('Renamed');
    expect(updated.clientId).toBe(client.connection.id);
    h.expectBroadcast('transformerchain.listed');
  });

  it('transformerchain.delete broadcasts deleted plus a reconverged list', async () => {
    const item = await h.deps.transformerChains.create('tc-1', { name: 'Doomed', description: '', steps: [] });
    await h.send(client, { type: 'transformerchain.delete', id: item.id } as never);

    const deleted = h.expectBroadcast('transformerchain.deleted');
    expect(deleted.id).toBe(item.id);
    const listed = h.expectBroadcast('transformerchain.listed');
    expect((listed.items as { id: string }[]).some((i) => i.id === item.id)).toBe(false);
    expect(await h.deps.transformerChains.getById(item.id)).toBeUndefined();
  });
});

describe('transformerscript handlers', () => {
  let h: TestHarness;
  let client: TestClient;

  const lastError = () => [...client.messages].reverse().find((m) => m.type === 'error');

  const lastValidated = () => {
    const msg = [...client.messages].reverse().find((m) => m.type === 'transformerscript.validated');
    return msg?.type === 'transformerscript.validated' ? msg : undefined;
  };

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('transformerscript.list replies only to the requesting client', async () => {
    await h.deps.transformerScripts.create('ts-1', { name: 'One', description: '', luaSource: VALID_LUA });
    const other = h.connectClient();

    await h.send(client, { type: 'transformerscript.list' } as never);

    const listed = client.messages.find((m) => m.type === 'transformerscript.listed');
    expect(listed).toBeDefined();
    expect((listed as { items: unknown[] }).items).toHaveLength(1);
    expect(other.messages.find((m) => m.type === 'transformerscript.listed')).toBeUndefined();
  });

  it('transformerscript.get returns the item as transformerscript.snapshot', async () => {
    const item = await h.deps.transformerScripts.create('ts-1', {
      name: 'One',
      description: '',
      luaSource: VALID_LUA,
    });
    await h.send(client, { type: 'transformerscript.get', id: item.id } as never);
    const reply = client.messages.find((m) => m.type === 'transformerscript.snapshot');
    expect(reply).toMatchObject({ type: 'transformerscript.snapshot' });
    expect((reply as { item: { id: string } }).item.id).toBe(item.id);
  });

  it('transformerscript.get on a missing id replies NOT_FOUND', async () => {
    await h.send(client, { type: 'transformerscript.get', id: 'no-such' } as never);
    expect(lastError()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
  });

  it('transformerscript.save without id creates and broadcasts created plus a reconverged list', async () => {
    await h.send(client, {
      type: 'transformerscript.save',
      data: { name: 'New', description: 'd', luaSource: VALID_LUA },
    } as never);

    const created = h.expectBroadcast('transformerscript.created');
    expect(created.clientId).toBe(client.connection.id);
    expect(created.item.name).toBe('New');
    const listed = h.expectBroadcast('transformerscript.listed');
    expect((listed.items as { id: string }[]).some((i) => i.id === created.item.id)).toBe(true);
  });

  it('transformerscript.save with id updates and broadcasts updated plus a reconverged list', async () => {
    const item = await h.deps.transformerScripts.create('ts-1', {
      name: 'Old',
      description: '',
      luaSource: VALID_LUA,
    });
    await h.send(client, {
      type: 'transformerscript.save',
      id: item.id,
      data: { name: 'Renamed', description: '', luaSource: VALID_LUA },
    } as never);

    const updated = h.expectBroadcast('transformerscript.updated');
    expect(updated.item.name).toBe('Renamed');
    expect(updated.clientId).toBe(client.connection.id);
    h.expectBroadcast('transformerscript.listed');
  });

  it('transformerscript.delete broadcasts deleted plus a reconverged list', async () => {
    const item = await h.deps.transformerScripts.create('ts-1', {
      name: 'Doomed',
      description: '',
      luaSource: VALID_LUA,
    });
    await h.send(client, { type: 'transformerscript.delete', id: item.id } as never);

    const deleted = h.expectBroadcast('transformerscript.deleted');
    expect(deleted.id).toBe(item.id);
    const listed = h.expectBroadcast('transformerscript.listed');
    expect((listed.items as { id: string }[]).some((i) => i.id === item.id)).toBe(false);
    expect(await h.deps.transformerScripts.getById(item.id)).toBeUndefined();
  });

  it('transformerscript.validate reports ok for parseable source and echoes requestId', async () => {
    await h.send(client, { type: 'transformerscript.validate', luaSource: VALID_LUA, requestId: 'req-1' } as never);
    const result = lastValidated();
    expect(result).toBeDefined();
    expect(result!.requestId).toBe('req-1');
    expect(result!.ok).toBe(true);
    expect(result!.error).toBeUndefined();
  });

  it('transformerscript.validate reports the load error for broken source', async () => {
    await h.send(client, { type: 'transformerscript.validate', luaSource: INVALID_LUA, requestId: 'req-2' } as never);
    const result = lastValidated();
    expect(result).toBeDefined();
    expect(result!.requestId).toBe('req-2');
    expect(result!.ok).toBe(false);
    expect(result!.error).toBeTruthy();
  });

  it('transformerscript.validate rejects source without a handle() entry point', async () => {
    await h.send(client, { type: 'transformerscript.validate', luaSource: NO_HANDLE_LUA, requestId: 'req-3' } as never);
    const result = lastValidated();
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    expect(result!.error).toContain('handle(messages, ctx)');
  });
});
