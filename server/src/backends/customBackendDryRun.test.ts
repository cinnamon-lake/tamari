/** Dry-run harness: canned branch history backing the Lua `chat` global. */
import { describe, expect, it } from 'vitest';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import { dryRunBackendScript } from './customBackendDryRun.js';

describe('customBackendDryRun history', () => {
  it('serves canned history to the chat global', async () => {
    const outcome = await dryRunBackendScript(new LuaRuntime(), {
      luaSource: `
        function generate(prompt, ctx)
          if not chat then return "no-chat" end
          local hits = chat.find("goblins"):await()
          return "count=" .. chat.count():await() .. " newest=" .. hits[1].content
        end
      `,
      input: 'what happened?',
      history: [
        { role: 'user', content: 'we met five goblins at the gate' },
        { role: 'assistant', content: 'the fight was brief' },
      ],
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.text).toBe('count=2 newest=we met five goblins at the gate');
  });

  it('leaves chat nil without canned history', async () => {
    const outcome = await dryRunBackendScript(new LuaRuntime(), {
      luaSource: 'function generate(prompt, ctx) if chat then return "present" end return "absent" end',
      input: 'hi',
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.text).toBe('absent');
  });
});
