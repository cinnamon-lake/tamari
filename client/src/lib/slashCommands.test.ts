import { describe, it, expect } from 'vitest';
import { parseCommand, buildClientMessage, parseMacroAtCursor, SLASH_COMMANDS, MACROS } from './slashCommands.js';

describe('parseCommand', () => {
  it('parses /send with trailing text', () => {
    expect(parseCommand('/send hello world')).toEqual({
      command: 'send',
      args: ['hello', 'world'],
      raw: '/send hello world',
    });
  });

  it('parses /cut with count', () => {
    expect(parseCommand('/cut 5')).toEqual({
      command: 'cut',
      args: ['5'],
      raw: '/cut 5',
    });
  });

  it('parses /swipe with direction', () => {
    expect(parseCommand('/swipe left')).toEqual({
      command: 'swipe',
      args: ['left'],
      raw: '/swipe left',
    });
  });

  it('returns null for non-command text', () => {
    expect(parseCommand('hello world')).toBeNull();
  });

  it('returns empty command for bare slash', () => {
    expect(parseCommand('/')).toEqual({ command: '', args: [], raw: '/' });
  });

  it('returns empty command for whitespace after slash', () => {
    expect(parseCommand('/ ')).toEqual({ command: '', args: [], raw: '/' });
  });

  it('parses command with no args', () => {
    expect(parseCommand('/reset')).toEqual({
      command: 'reset',
      args: [],
      raw: '/reset',
    });
  });

  it('requires leading slash without whitespace', () => {
    // Leading whitespace means it does not start with /
    expect(parseCommand('  /sys hello  ')).toBeNull();
  });

  it('trims raw field', () => {
    const result = parseCommand('/sys hello  ');
    expect(result).not.toBeNull();
    expect(result!.raw).toBe('/sys hello');
  });
});

describe('buildClientMessage', () => {
  const chatId = 'chat-1';

  it('builds chat.reset for /reset', () => {
    const parsed = parseCommand('/reset')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'chat.reset',
      chatId,
    });
  });

  it('builds action.sendAndGenerate for /send', () => {
    const parsed = parseCommand('/send hello world')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.sendAndGenerate',
      chatId,
      content: 'hello world',
    });
  });

  it('builds action.system for /sys', () => {
    const parsed = parseCommand('/sys be nice')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.system',
      chatId,
      content: 'be nice',
    });
  });

  it('builds action.cut with default count 1', () => {
    const parsed = parseCommand('/cut')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.cut',
      chatId,
      count: 1,
    });
  });

  it('builds action.cut with specified count', () => {
    const parsed = parseCommand('/cut 5')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.cut',
      chatId,
      count: 5,
    });
  });

  it('builds action.cut with NaN fallback', () => {
    const parsed = parseCommand('/cut abc')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.cut',
      chatId,
      count: 1,
    });
  });

  it('builds action.continue for /continue', () => {
    const parsed = parseCommand('/continue')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.continue',
      chatId,
    });
  });

  it('builds action.impersonate for /impersonate', () => {
    const parsed = parseCommand('/impersonate')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.impersonate',
      chatId,
    });
  });

  it('builds action.regenerate for /regenerate', () => {
    const parsed = parseCommand('/regenerate')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.regenerate',
      chatId,
    });
  });

  it('builds action.regenerate for /regen alias', () => {
    const parsed = parseCommand('/regen')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.regenerate',
      chatId,
    });
  });

  it('builds action.swipe for valid direction', () => {
    const parsed = parseCommand('/swipe left')!;
    expect(buildClientMessage(chatId, parsed)).toEqual({
      type: 'action.swipe',
      chatId,
      direction: 'left',
    });
  });

  it('returns null for invalid swipe direction', () => {
    const parsed = parseCommand('/swipe up')!;
    expect(buildClientMessage(chatId, parsed)).toBeNull();
  });

  it('returns null for client-side-only commands', () => {
    const clientOnly = ['name', 'bg', 'theme', 'persona', 'char', 'lock', 'unlock'];
    for (const cmd of clientOnly) {
      const parsed = parseCommand(`/${cmd} value`)!;
      expect(buildClientMessage(chatId, parsed)).toBeNull();
    }
  });

  it('returns null for unknown command', () => {
    const parsed = parseCommand('/unknown')!;
    expect(buildClientMessage(chatId, parsed)).toBeNull();
  });
});

describe('parseMacroAtCursor', () => {
  it('detects macro prefix at cursor', () => {
    // 'Hello {{us' is 10 chars; position 10 = after 's'
    expect(parseMacroAtCursor('Hello {{us', 10)).toEqual({ prefix: 'us', start: 6 });
  });

  it('detects macro prefix mid-text', () => {
    expect(parseMacroAtCursor('Say {{char', 10)).toEqual({ prefix: 'char', start: 4 });
  });

  it('returns null when not inside macro', () => {
    expect(parseMacroAtCursor('no macro here', 5)).toBeNull();
  });

  it('returns null after closing braces', () => {
    expect(parseMacroAtCursor('{{user}}', 8)).toBeNull();
  });

  it('returns null at position 0', () => {
    expect(parseMacroAtCursor('{{user', 0)).toBeNull();
  });
});

describe('SLASH_COMMANDS', () => {
  it('has no duplicate names', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    const unique = [...new Set(names)];
    expect(unique).toHaveLength(names.length);
  });

  it('every command has a description', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.description).toBeTruthy();
    }
  });
});

describe('MACROS', () => {
  it('has no duplicate names', () => {
    const names = MACROS.map((m) => m.name);
    const unique = [...new Set(names)];
    expect(unique).toHaveLength(names.length);
  });
});
