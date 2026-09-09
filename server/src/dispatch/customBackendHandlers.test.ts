/**
 * custombackend.test WS handler: dry-runs custom/contextual backend scripts
 * against a recording delegate — the frontend's porting/debugging surface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness, type TestClient } from '../testing/TestHarness.js';

const ECHO_LUA =
  'function generate(prompt, ctx) return "echo:" .. prompt.messages[#prompt.messages].content[1].text end';

describe('custombackend.test handler', () => {
  let h: TestHarness;
  let client: TestClient;

  const lastTestResult = () => {
    const msg = [...client.messages].reverse().find((m) => m.type === 'custombackend.testResult');
    return msg?.type === 'custombackend.testResult' ? msg : undefined;
  };

  const lastError = () => [...client.messages].reverse().find((m) => m.type === 'error');

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('dry-runs an ad-hoc luaSource and echoes requestId', async () => {
    await h.send(client, {
      type: 'custombackend.test',
      luaSource: ECHO_LUA,
      input: 'hello',
      requestId: 'req-1',
    } as never);
    const result = lastTestResult();
    expect(result).toBeDefined();
    expect(result!.requestId).toBe('req-1');
    const outcome = result!.outcome;
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe('echo:hello');
    expect(outcome.delegations).toHaveLength(0);
  });

  it('records delegations and answers them with canned text', async () => {
    await h.send(client, {
      type: 'custombackend.test',
      luaSource: 'function generate(p, c) local r = backends.generate(p):await() return "writer said: " .. r.text end',
      input: 'hi',
      delegateResponse: 'CANNED',
    } as never);
    const outcome = lastTestResult()!.outcome;
    expect(outcome.text).toBe('writer said: CANNED');
    expect(outcome.delegations).toHaveLength(1);
    expect(outcome.delegations[0]!.promptPreview).toContain('user: hi');
  });

  it('resolves a stored registry script by customBackendId', async () => {
    const item = await h.deps.customBackends.create('cb-1', {
      name: 'Echo',
      description: '',
      luaSource: ECHO_LUA,
    });
    await h.send(client, { type: 'custombackend.test', customBackendId: item.id, input: 'stored' } as never);
    const outcome = lastTestResult()!.outcome;
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe('echo:stored');
  });

  it('resolves a character contextual backend and weaves character context', async () => {
    const character = await h.deps.characters.create('char-1', {
      name: 'Dealer',
      description: 'A blackjack table.',
      extensions: {
        contextualBackend: {
          enabled: true,
          luaSource: `function generate(prompt, ctx)
            local sys = prompt.messages[1]
            return "sys:" .. (sys and sys.content[1].text or "?") .. " char:" .. (ctx.characterId or "?")
          end`,
        },
      },
    });
    await h.send(client, { type: 'custombackend.test', characterId: character.id, input: 'hit' } as never);
    const outcome = lastTestResult()!.outcome;
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe(`sys:A blackjack table. char:${character.id}`);
  });

  it('explicit luaSource wins over characterId', async () => {
    const character = await h.deps.characters.create('char-2', {
      name: 'Dealer',
      extensions: { contextualBackend: { enabled: true, luaSource: 'function generate(p, c) return "stored" end' } },
    });
    await h.send(client, {
      type: 'custombackend.test',
      characterId: character.id,
      luaSource: 'function generate(p, c) return "adhoc" end',
      input: 'x',
    } as never);
    const outcome = lastTestResult()!.outcome;
    expect(outcome.text).toBe('adhoc');
  });

  it('errors when no script source is given', async () => {
    await h.send(client, { type: 'custombackend.test', input: 'x' } as never);
    const err = lastError();
    expect(err).toBeDefined();
    expect(err!.type === 'error' && err!.message).toContain('Pass luaSource, customBackendId, or characterId');
  });

  it('errors for a character without stored backend logic', async () => {
    const character = await h.deps.characters.create('char-3', { name: 'Plain' });
    await h.send(client, { type: 'custombackend.test', characterId: character.id, input: 'x' } as never);
    const err = lastError();
    expect(err!.type === 'error' && err!.message).toContain('no stored backend logic');
  });

  it('explicit files let the script require a module during the dry-run', async () => {
    await h.send(client, {
      type: 'custombackend.test',
      luaSource: "local u = require('lib/util') function generate(p, c) return u.reply() end",
      files: { 'lib/util.lua': "local M = {} function M.reply() return 'MODULE-OK' end return M" },
      input: 'hi',
      requestId: 'req-files',
    } as never);
    const result = lastTestResult();
    expect(result!.requestId).toBe('req-files');
    expect(result!.outcome.ok).toBe(true);
    expect(result!.outcome.text).toBe('MODULE-OK');
  });

  it('characterId path picks up the stored module map (even while disabled)', async () => {
    const character = await h.deps.characters.create('char-files', {
      name: 'VFS Char',
      extensions: {
        contextualBackend: {
          enabled: true,
          luaSource: "local u = require('lib/util') function generate(p, c) return u.reply() end",
          files: { 'lib/util.lua': "local M = {} function M.reply() return 'STORED-MODULE' end return M" },
        },
      },
    });
    await h.send(client, { type: 'custombackend.test', characterId: character.id, input: 'hi' } as never);
    expect(lastTestResult()!.outcome.text).toBe('STORED-MODULE');
  });

  it('explicit files override the character’s stored module map', async () => {
    const character = await h.deps.characters.create('char-override', {
      name: 'Override Char',
      extensions: {
        contextualBackend: {
          enabled: true,
          luaSource: "local u = require('lib/util') function generate(p, c) return u.reply() end",
          files: { 'lib/util.lua': "local M = {} function M.reply() return 'STORED' end return M" },
        },
      },
    });
    await h.send(client, {
      type: 'custombackend.test',
      characterId: character.id,
      files: { 'lib/util.lua': "local M = {} function M.reply() return 'EXPLICIT' end return M" },
      input: 'hi',
    } as never);
    expect(lastTestResult()!.outcome.text).toBe('EXPLICIT');
  });
});

describe('custombackend CRUD handlers', () => {
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

  it('custombackend.list replies only to the requesting client', async () => {
    await h.deps.customBackends.create('cb-1', { name: 'One', description: '', luaSource: ECHO_LUA });
    const other = h.connectClient();

    await h.send(client, { type: 'custombackend.list' } as never);

    const listed = client.messages.find((m) => m.type === 'custombackend.listed');
    expect(listed).toBeDefined();
    expect((listed as { items: unknown[] }).items).toHaveLength(1);
    // Request/response, not shared state — the other client gets nothing.
    expect(other.messages.find((m) => m.type === 'custombackend.listed')).toBeUndefined();
  });

  it('custombackend.get returns the item as custombackend.updated', async () => {
    const item = await h.deps.customBackends.create('cb-1', {
      name: 'One',
      description: '',
      luaSource: ECHO_LUA,
    });
    await h.send(client, { type: 'custombackend.get', id: item.id } as never);
    const reply = client.messages.find((m) => m.type === 'custombackend.updated');
    expect(reply).toMatchObject({ type: 'custombackend.updated' });
    expect((reply as { item: { id: string } }).item.id).toBe(item.id);
  });

  it('custombackend.get on a missing id replies NOT_FOUND', async () => {
    await h.send(client, { type: 'custombackend.get', id: 'no-such' } as never);
    expect(lastError()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
  });

  it('custombackend.create broadcasts created plus a reconverged list', async () => {
    await h.send(client, {
      type: 'custombackend.create',
      data: { name: 'New', description: 'd', luaSource: ECHO_LUA },
    } as never);

    const created = h.expectBroadcast('custombackend.created');
    expect(created.clientId).toBe(client.connection.id);
    expect(created.item.name).toBe('New');
    const listed = h.expectBroadcast('custombackend.listed');
    expect((listed.items as { id: string }[]).some((i) => i.id === created.item.id)).toBe(true);
  });

  it('custombackend.update broadcasts updated plus a reconverged list', async () => {
    const item = await h.deps.customBackends.create('cb-1', {
      name: 'Old',
      description: '',
      luaSource: ECHO_LUA,
    });
    await h.send(client, {
      type: 'custombackend.update',
      id: item.id,
      patch: { name: 'Renamed' },
    } as never);

    const updated = h.expectBroadcast('custombackend.updated');
    expect(updated.item.name).toBe('Renamed');
    expect(updated.clientId).toBe(client.connection.id);
    h.expectBroadcast('custombackend.listed');
  });

  it('custombackend.delete broadcasts deleted plus a reconverged list', async () => {
    const item = await h.deps.customBackends.create('cb-1', {
      name: 'Doomed',
      description: '',
      luaSource: ECHO_LUA,
    });
    await h.send(client, { type: 'custombackend.delete', id: item.id } as never);

    const deleted = h.expectBroadcast('custombackend.deleted');
    expect(deleted.id).toBe(item.id);
    const listed = h.expectBroadcast('custombackend.listed');
    expect((listed.items as { id: string }[]).some((i) => i.id === item.id)).toBe(false);
    expect(await h.deps.customBackends.getById(item.id)).toBeUndefined();
  });
});
