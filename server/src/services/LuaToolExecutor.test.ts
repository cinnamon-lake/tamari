import { describe, it, expect, vi } from 'vitest';
import { LuaToolExecutor } from './LuaToolExecutor.js';
import type { ToolContextMessage } from './ToolTemplate.js';
import { LuaRuntime } from '../scripting/LuaRuntime.js';

describe('LuaToolExecutor', () => {
  const luaRuntime = new LuaRuntime();
  const executor = new LuaToolExecutor(luaRuntime);

  const simpleToolCode = `
Tool = {}
function Tool.getDefinition()
  return {
    stateKey = "greet",
    configSchema = {},
    tools = {
      {
        name = "greet",
        description = "Greets someone",
        parameters = {
          type = "object",
          properties = {
            name = { type = "string", description = "Name to greet" }
          }
        }
      }
    }
  }
end
function Tool.execute(args, context, toolName)
  return "Hello, " .. tostring(args.name or "World") .. "!"
end
return Tool
`;

  const statefulToolCode = `
Tool = {}
Tool.state = { count = 0 }
function Tool.getDefinition()
  return {
    stateKey = "counter",
    configSchema = {},
    tools = {
      {
        name = "counter",
        description = "Counts invocations",
        parameters = { type = "object", properties = {} }
      }
    }
  }
end
function Tool.execute(args, context, toolName)
  Tool.state.count = Tool.state.count + 1
  return { content = "Count: " .. Tool.state.count, extra = { count = Tool.state.count } }
end
function Tool.serialize()
  return json.encode(Tool.state)
end
function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end
return Tool
`;

  describe('getDefinition', () => {
    it('parses a valid Lua tool definition', async () => {
      const def = await executor.getDefinition(simpleToolCode);
      expect('error' in def).toBe(false);
      if ('error' in def) return;
      expect(def.stateKey).toBe('greet');
      expect(def.tools[0]!.name).toBe('greet');
      expect(def.tools[0]!.description).toBe('Greets someone');
      expect(def.tools[0]!.parameters).toBeDefined();
    });

    it('returns error for code without getDefinition', async () => {
      const def = await executor.getDefinition('return {}');
      expect('error' in def).toBe(true);
    });

    it('returns error for invalid Lua', async () => {
      const def = await executor.getDefinition('this is not lua');
      expect('error' in def).toBe(true);
    });

    it('passes through endsTurn from a Lua tool definition', async () => {
      const code = `
Tool = {}
function Tool.getDefinition()
  return {
    stateKey = "t",
    configSchema = {},
    tools = {
      { name = "stopper", description = "Ends the turn", endsTurn = true, parameters = { type = "object", properties = {} } },
      { name = "normal", description = "Keeps going", parameters = { type = "object", properties = {} } }
    }
  }
end
return Tool
`;
      const def = await executor.getDefinition(code);
      expect('error' in def).toBe(false);
      if ('error' in def) return;
      expect(def.tools[0]!.endsTurn).toBe(true);
      expect(def.tools[1]!.endsTurn).toBe(false);
    });
  });

  describe('execute', () => {
    it('executes a simple tool and returns string result', async () => {
      const result = await executor.execute(simpleToolCode, 'greet', { name: 'Alice' });
      expect(result.content).toBe('Hello, Alice!');
    });

    it('executes a tool returning a table', async () => {
      const result = await executor.execute(simpleToolCode, 'greet', { name: 'Bob' });
      expect(result.content).toBe('Hello, Bob!');
    });

    it('injects json global into Lua', async () => {
      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "json_test", configSchema = {}, tools = { { name = "json_test", description = "Tests json", parameters = {} } } }
end
function Tool.execute(args, context, toolName)
  local t = { x = 1 }
  return json.encode(t)
end
return Tool
`;
      const result = await executor.execute(code, 'json_test', {});
      expect(result.content).toBe('{"x":1}');
    });
  });

  describe('serialize / deserialize', () => {
    it('restores state from message history', async () => {
      const messages: ToolContextMessage[] = [
        {
          id: '1',
          role: 'assistant',
          content: '',
          extra: {
            parts: [
              { type: 'tool_result' as const, toolUseId: 'call-1', content: '', extra: { _toolState: { counter: '{"count":5}' } } },
            ],
          },
        },
      ];
      const result = await executor.execute(statefulToolCode, 'counter', {}, { messages });
      expect(result.content).toBe('Count: 6');
      expect(result.extra!._toolState).toEqual({ counter: '{"count":6}' });
    });

    it('starts fresh when no state snapshot exists', async () => {
      const result = await executor.execute(statefulToolCode, 'counter', {});
      expect(result.content).toBe('Count: 1');
      expect(result.extra!._toolState).toEqual({ counter: '{"count":1}' });
    });

    it('scans backwards through messages for latest state', async () => {
      const messages: ToolContextMessage[] = [
        {
          id: '1',
          role: 'assistant',
          content: '',
          extra: {
            parts: [
              { type: 'tool_result' as const, toolUseId: 'call-1', content: '', extra: { _toolState: { counter: '{"count":2}' } } },
            ],
          },
        },
        {
          id: '2',
          role: 'assistant',
          content: '',
          extra: {
            parts: [
              { type: 'tool_result' as const, toolUseId: 'call-1', content: '', extra: { _toolState: { counter: '{"count":7}' } } },
            ],
          },
        },
      ];
      const result = await executor.execute(statefulToolCode, 'counter', {}, { messages });
      expect(result.content).toBe('Count: 8');
    });

    it('ignores state from other tools', async () => {
      const messages: ToolContextMessage[] = [
        {
          id: '1',
          role: 'assistant',
          content: '',
          extra: {
            parts: [
              { type: 'tool_result' as const, toolUseId: 'call-1', content: '', extra: { _toolState: { other_tool: '{"foo":1}' } } },
            ],
          },
        },
      ];
      const result = await executor.execute(statefulToolCode, 'counter', {}, { messages });
      expect(result.content).toBe('Count: 1');
    });
  });

  describe('error handling', () => {
    it('returns error when execute throws', async () => {
      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "fail", configSchema = {}, tools = { { name = "fail", description = "Fails", parameters = {} } } }
end
function Tool.execute(args, context, toolName)
  error("boom")
end
return Tool
`;
      const result = await executor.execute(code, 'fail', {});
      expect(result.content).toContain('boom');
    });

    it('returns error when deserialize throws', async () => {
      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "bad", configSchema = {}, tools = { { name = "bad", description = "Bad", parameters = {} } } }
end
function Tool.execute(args, context, toolName)
  return "ok"
end
function Tool.deserialize(raw)
  error("bad state")
end
return Tool
`;
      const messages: ToolContextMessage[] = [
        {
          id: '1',
          role: 'assistant',
          content: '',
          extra: {
            parts: [
              { type: 'tool_result' as const, toolUseId: 'call-1', content: '', extra: { _toolState: { bad: 'anything' } } },
            ],
          },
        },
      ];
      const result = await executor.execute(code, 'bad', {}, { messages });
      expect(result.content).toContain('deserialize error');
    });
  });

  describe('sandbox flags', () => {
    const probeCode = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "probe", configSchema = {}, tools = { { name = "probe", description = "Probes stdlib", parameters = {} } } }
end
function Tool.execute(args, context, toolName)
  return "os:" .. type(os) .. " io:" .. type(io) .. " debug:" .. type(debug) ..
    " os.execute:" .. type(os and os.execute) .. " os.exit:" .. type(os and os.exit)
end
return Tool
`;

    it('strips io/os/debug by default', async () => {
      const result = await executor.execute(probeCode, 'probe', {});
      expect(result.content).toBe('os:nil io:nil debug:nil os.execute:nil os.exit:nil');
    });

    it('exposes enabled libraries but keeps os.execute/os.exit stripped under allowOs', async () => {
      const result = await executor.execute(probeCode, 'probe', {}, undefined, {
        allowIo: true,
        allowOs: true,
        allowDebug: true,
      });
      expect(result.content).toBe('os:table io:table debug:table os.execute:nil os.exit:nil');
    });

    it('io works on an in-memory filesystem within one execution', async () => {
      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "iotest", configSchema = {}, tools = { { name = "iotest", description = "io test", parameters = {} } } }
end
function Tool.execute(args, context, toolName)
  local f = io.open("note.txt", "w")
  f:write("abc")
  f:close()
  local r = io.open("note.txt", "r")
  local content = r:read("*a")
  r:close()
  return content
end
return Tool
`;
      const result = await executor.execute(code, 'iotest', {}, undefined, { allowIo: true });
      expect(result.content).toBe('abc');
    });

    it('os.time works under allowOs', async () => {
      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "ostime", configSchema = {}, tools = { { name = "ostime", description = "os.time test", parameters = {} } } }
end
function Tool.execute(args, context, toolName)
  return tostring(os.time() > 0)
end
return Tool
`;
      const result = await executor.execute(code, 'ostime', {}, undefined, { allowOs: true });
      expect(result.content).toBe('true');
    });
  });

  describe('net / files / base64 globals', () => {
    it('fetch is nil without allowNet', async () => {
      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "p", configSchema = {}, tools = { { name = "p", description = "p", parameters = {} } } }
end
function Tool.execute() return type(fetch) end
return Tool
`;
      const result = await executor.execute(code, 'p', {});
      expect(result.content).toBe('nil');
    });

    it('base64 round-trips binary data in Lua', async () => {
      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "b", configSchema = {}, tools = { { name = "b", description = "b", parameters = {} } } }
end
function Tool.execute()
  local encoded = base64.encode("hello")
  return encoded .. "|" .. base64.decode(encoded)
end
return Tool
`;
      const result = await executor.execute(code, 'b', {});
      expect(result.content).toBe('aGVsbG8=|hello');
    });

    it('fetches and creates an attachment, returning inline parts (full media flow)', async () => {
      const wavBytes = Buffer.from('RIFF-fake-wav-data');
      vi.stubGlobal('fetch', async () => ({
        status: 200,
        headers: { forEach: (cb: (v: string, k: string) => void) => cb('audio/wav', 'content-type') },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(wavBytes));
            controller.close();
          },
        }),
      }));

      const written: Array<{ name: string; data: Buffer }> = [];
      const media = {
        storage: {
          write: (_sub: string, name: string, data: Uint8Array) => {
            written.push({ name, data: Buffer.from(data) });
            return `files/attachments/${name}`;
          },
        },
        attachments: {
          create: async ({ id, messageId, mimeType, filePath }: { id: string; messageId: null; mimeType: string; filePath: string }) => ({
            id,
            messageId,
            mimeType,
            filePath,
            meta: {},
            url: `/api/attachments/${id}`,
          }),
        },
      };
      const mediaExecutor = new LuaToolExecutor(new LuaRuntime(), media as never);

      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "tts", configSchema = {}, tools = { { name = "tts", description = "tts", parameters = {} } } }
end
function Tool.execute(args, context, toolName)
  local res = fetch("http://127.0.0.1:9876/audio/speech", { method = "POST", body = "{}" }):await()
  local att = attachments.create(res.bodyBase64, "audio/wav"):await()
  return { content = {
    { type = "text", text = "Speech: {{attachment::" .. att.id .. "}}" },
    { type = "audio", source = att.url, mimeType = att.mimeType },
  } }
end
return Tool
`;
      const result = await mediaExecutor.execute(code, 'tts', {}, undefined, { allowNet: true, allowFiles: true });
      const parts = result.content as Array<{ type: string; text?: string; source?: string }>;
      expect(parts[0]?.type).toBe('text');
      expect(parts[0]?.text).toContain('{{attachment::');
      expect(parts[1]?.type).toBe('audio');
      expect(parts[1]?.source).toMatch(/^\/api\/attachments\//);
      expect(written).toHaveLength(1);
      expect(written[0]?.name).toMatch(/\.wav$/);
      expect(written[0]?.data.equals(wavBytes)).toBe(true);
      vi.unstubAllGlobals();
    });

    it('attachments global is absent without allowFiles', async () => {
      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "p2", configSchema = {}, tools = { { name = "p2", description = "p", parameters = {} } } }
end
function Tool.execute() return type(attachments) end
return Tool
`;
      const result = await executor.execute(code, 'p2', {}, undefined, { allowFiles: true });
      // No media deps on this executor — global is not injected even with the flag.
      expect(result.content).toBe('nil');
    });
  });

  describe('st API (allowSt)', () => {
    const stTemplateCode = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "stt", configSchema = {}, tools = { { name = "stt", description = "st test", parameters = {} } } }
end
function Tool.execute(args, context, toolName)
  st.setvar("hp", 42):await()
  local v = st.getvar("hp"):await()
  st.toast("hello")
  local c = st.create_character({ name = "Lua Made" }):await()
  return "hp:" .. tostring(v) .. " char:" .. c.name .. " send:" .. type(st.send) .. " edit:" .. type(st.edit)
end
return Tool
`;

    function makeStExecutor() {
      const settingsStore = new Map<string, unknown>();
      const charStore = new Map<string, { id: string; name: string }>();
      const bus = { sendTo: vi.fn(), broadcast: vi.fn() };
      const ex = new LuaToolExecutor(new LuaRuntime());
      ex.setStDeps({
        generationService: { tryLockChat: () => true, unlockChat: () => {} } as never,
        chats: {} as never,
        personas: {} as never,
        backendConfigs: {} as never,
        worldInfo: {} as never,
        chatMembers: {} as never,
        extensionData: {} as never,
        chatBroadcast: {} as never,
        chatMetaBroadcast: {} as never,
        settings: {
          setValue: async (k: string, v: unknown) => settingsStore.set(k, v),
          get: async (k: string) => settingsStore.get(k),
        } as never,
        characters: {
          getByName: async (name: string) => [...charStore.values()].find((c) => c.name === name),
          create: async (id: string, data: { name: string }) => {
            const c = { id, name: data.name };
            charStore.set(id, c);
            return c;
          },
          listSummaries: async () => ({ items: [...charStore.values()], total: charStore.size }),
        } as never,
        bus: bus as never,
      });
      return { ex, settingsStore, charStore, bus };
    }

    it('exposes the curated subset in a chat context', async () => {
      const { ex, settingsStore, charStore, bus } = makeStExecutor();
      const result = await ex.execute(stTemplateCode, 'stt', {}, { chatId: 'chat1', clientId: 'client1' }, { allowSt: true });
      expect(result.content).toBe('hp:42 char:Lua Made send:nil edit:nil');
      expect(settingsStore.get('lua.var.chat1.hp')).toBe(42);
      expect(charStore.size).toBe(1);
      expect(bus.sendTo).toHaveBeenCalledWith('client1', expect.objectContaining({ type: 'script.toast' }));
    });

    it('works with the QR-style st.await helper (not just promise:await())', async () => {
      const { ex } = makeStExecutor();
      const code = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "sta", configSchema = {}, tools = { { name = "sta", description = "t", parameters = {} } } }
end
function Tool.execute()
  st.setvar("k", "v")
  local v = st.await(st.getvar("k"))
  return "got:" .. tostring(v)
end
return Tool
`;
      const result = await ex.execute(code, 'sta', {}, { chatId: 'chat1', clientId: 'client1' }, { allowSt: true });
      expect(result.content).toBe('got:v');
    });

    it('st is nil without the allowSt flag', async () => {
      const { ex } = makeStExecutor();
      const result = await ex.execute(stTemplateCode, 'stt', {}, { chatId: 'chat1', clientId: 'client1' }, {});
      expect(String(result.content)).toContain('Lua execution error');
    });

    it('st is nil without a chat context', async () => {
      const { ex } = makeStExecutor();
      const result = await ex.execute(stTemplateCode, 'stt', {}, undefined, { allowSt: true });
      expect(String(result.content)).toContain('Lua execution error');
    });

    it('st is nil when deps were never wired', async () => {
      const result = await executor.execute(stTemplateCode, 'stt', {}, { chatId: 'chat1' }, { allowSt: true });
      expect(String(result.content)).toContain('Lua execution error');
    });
  });
});
