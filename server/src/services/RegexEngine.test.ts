import { describe, it, expect } from 'vitest';
import { parseRegexString, applyRules, filterRules, filterRulesByRole, compileRule } from './RegexEngine.js';
import type { RegexRule } from '@tamari/types';

describe('RegexEngine', () => {
  describe('parseRegexString', () => {
    it('rejects bare patterns without delimiters', () => {
      expect(parseRegexString('foo')).toBeNull();
    });

    it('parses delimited pattern without flags', () => {
      const result = parseRegexString('/foo/');
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe('foo');
      expect(result!.flags).toBe('g');
    });

    it('parses delimited pattern with flags', () => {
      const result = parseRegexString('/foo/gi');
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe('foo');
      expect(result!.flags).toBe('gi');
    });
  });

  describe('applyRules', () => {
    it('applies a single rule', async () => {
      const rules: RegexRule[] = [
        {
          id: '1',
          name: 'Remove extra stars',
          findRegex: '/\\*{2,}/g',
          replaceString: '*',
          disabled: false,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: false,
        },
      ];
      expect(await applyRules('Hello **world***', rules)).toBe('Hello *world*');
    });

    it('skips disabled rules', async () => {
      const rules: RegexRule[] = [
        {
          id: '1',
          name: 'Remove stars',
          findRegex: '/\\*/g',
          replaceString: '',
          disabled: true,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: false,
        },
      ];
      expect(await applyRules('Hello *world*', rules)).toBe('Hello *world*');
    });

    it('applies multiple rules in order', async () => {
      const rules: RegexRule[] = [
        {
          id: '1',
          name: 'A to B',
          findRegex: '/A/g',
          replaceString: 'B',
          disabled: false,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: false,
        },
        {
          id: '2',
          name: 'B to C',
          findRegex: '/B/g',
          replaceString: 'C',
          disabled: false,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: false,
        },
      ];
      expect(await applyRules('A', rules)).toBe('C');
    });

    it('supports capture groups', async () => {
      const rules: RegexRule[] = [
        {
          id: '1',
          name: 'Swap',
          findRegex: '/(\\w+) (\\w+)/g',
          replaceString: '$2 $1',
          disabled: false,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: false,
        },
      ];
      expect(await applyRules('hello world', rules)).toBe('world hello');
    });

    it('handles invalid regex gracefully', async () => {
      const rules: RegexRule[] = [
        {
          id: '1',
          name: 'Bad',
          findRegex: '/[/g',
          replaceString: 'x',
          disabled: false,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: false,
        },
      ];
      expect(await applyRules('hello', rules)).toBe('hello');
    });

    it('skips bare patterns without delimiters', async () => {
      const rules: RegexRule[] = [
        {
          id: '1',
          name: 'Bare',
          findRegex: 'foo',
          replaceString: 'bar',
          disabled: false,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: false,
        },
      ];
      expect(await applyRules('foo', rules)).toBe('foo');
    });
  });

  describe('applyRules with replaceLua (Layer 2)', () => {
    const luaRule = (replaceLua: string, findRegex = '/HP: (\\d+)/g'): RegexRule => ({
      id: 'lua-1',
      name: 'Lua rule',
      findRegex,
      replaceString: 'IGNORED',
      replaceLua,
      disabled: false,
      userInput: false,
      aiOutput: false,
      prompt: true,
      display: true,
    });

    it('replaces matches via the script replace() and captures', async () => {
      const rule = luaRule('function replace(match, captures) return "HP[" .. captures[1] .. "]" end');
      expect(await applyRules('HP: 12 and HP: 20', [rule])).toBe('HP[12] and HP[20]');
    });

    it('takes precedence over replaceString', async () => {
      const rule = luaRule('function replace(match, captures) return "lua" end', '/foo/g');
      expect(await applyRules('foo bar foo', [rule])).toBe('lua bar lua');
    });

    it('passes nil for unmatched optional capture groups', async () => {
      const rule = luaRule(
        'function replace(match, captures) return tostring(captures[2] == nil) end',
        '/(a)(b)?/g',
      );
      expect(await applyRules('a ab', [rule])).toBe('true false');
    });

    it('keeps the original match when replace() returns a non-string', async () => {
      const rule = luaRule('function replace(match, captures) return nil end', '/foo/g');
      expect(await applyRules('foo foo', [rule])).toBe('foo foo');
    });

    it('skips the rule (text unchanged) when the script defines no replace()', async () => {
      const rule = luaRule('local x = 1', '/foo/g');
      expect(await applyRules('foo', [rule])).toBe('foo');
    });

    it('skips the rule (text unchanged) when the script errors', async () => {
      const rule = luaRule('function replace(match, captures) error("boom") end', '/foo/g');
      expect(await applyRules('foo', [rule])).toBe('foo');
    });

    it('handles zero-width matches without looping', async () => {
      const rule = luaRule('function replace(match, captures) return "-" end', '/x*/g');
      expect(await applyRules('ab', [rule])).toBe('-a-b-');
    });

    it('chains plain and Lua rules in order', async () => {
      const plain: RegexRule = {
        id: 'plain-1',
        name: 'Plain',
        findRegex: '/world/g',
        replaceString: 'HP: 42',
        disabled: false,
        userInput: false,
        aiOutput: false,
        prompt: true,
        display: true,
      };
      const lua = luaRule('function replace(match, captures) return "HP[" .. captures[1] .. "]" end');
      expect(await applyRules('hello world', [plain, lua])).toBe('hello HP[42]');
    });

    it('honors non-global patterns (first match only)', async () => {
      // flags 'i' (no 'g') — parseRegexString defaults flagless patterns to 'g'
      const rule = luaRule('function replace(match, captures) return "X" end', '/foo/i');
      expect(await applyRules('foo FOO foo', [rule])).toBe('X FOO foo');
    });
  });

  describe('filterRules', () => {
    it('returns only rules matching placement', () => {
      const rules: RegexRule[] = [
        {
          id: '1',
          name: 'Display',
          findRegex: '/a/g',
          replaceString: 'b',
          disabled: false,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: true,
        },
        {
          id: '2',
          name: 'Prompt',
          findRegex: '/a/g',
          replaceString: 'b',
          disabled: false,
          userInput: false,
          aiOutput: true,
          prompt: true,
          display: false,
        },
        {
          id: '3',
          name: 'Both',
          findRegex: '/a/g',
          replaceString: 'b',
          disabled: false,
          userInput: true,
          aiOutput: true,
          prompt: true,
          display: true,
        },
        {
          id: '4',
          name: 'Disabled',
          findRegex: '/a/g',
          replaceString: 'b',
          disabled: true,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: true,
        },
      ];
      expect(filterRules(rules, 'display').map((r) => r.name)).toEqual(['Display', 'Both']);
      expect(filterRules(rules, 'prompt').map((r) => r.name)).toEqual(['Prompt', 'Both']);
    });
  });

  describe('filterRulesByRole', () => {
    it('returns all placement rules when no role flags are set', () => {
      const rules: RegexRule[] = [
        {
          id: '1',
          name: 'DisplayAll',
          findRegex: '/a/g',
          replaceString: 'b',
          disabled: false,
          userInput: false,
          aiOutput: false,
          prompt: false,
          display: true,
        },
      ];
      expect(filterRulesByRole(rules, 'display', 'user').map((r) => r.name)).toEqual(['DisplayAll']);
      expect(filterRulesByRole(rules, 'display', 'assistant').map((r) => r.name)).toEqual(['DisplayAll']);
    });

    it('filters display rules by user role', () => {
      const rules: RegexRule[] = [
        {
          id: '1',
          name: 'UserOnly',
          findRegex: '/a/g',
          replaceString: 'b',
          disabled: false,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: true,
        },
        {
          id: '2',
          name: 'AIOnly',
          findRegex: '/a/g',
          replaceString: 'b',
          disabled: false,
          userInput: false,
          aiOutput: true,
          prompt: false,
          display: true,
        },
        {
          id: '3',
          name: 'Both',
          findRegex: '/a/g',
          replaceString: 'b',
          disabled: false,
          userInput: true,
          aiOutput: true,
          prompt: false,
          display: true,
        },
      ];
      expect(filterRulesByRole(rules, 'display', 'user').map((r) => r.name)).toEqual(['UserOnly', 'Both']);
      expect(filterRulesByRole(rules, 'display', 'assistant').map((r) => r.name)).toEqual(['AIOnly', 'Both']);
    });
  });

  describe('compileRule', () => {
    it('compiles valid regex', () => {
      const rule: RegexRule = {
        id: '1',
        name: 'Test',
        findRegex: '/foo/i',
        replaceString: 'bar',
        disabled: false,
        userInput: true,
        aiOutput: false,
        prompt: false,
        display: false,
      };
      const regex = compileRule(rule);
      expect(regex).not.toBeNull();
      expect(regex!.test('FOO')).toBe(true);
    });

    it('returns null for invalid regex', () => {
      const rule: RegexRule = {
        id: '1',
        name: 'Bad',
        findRegex: '/[/g',
        replaceString: 'x',
        disabled: false,
        userInput: true,
        aiOutput: false,
        prompt: false,
        display: false,
      };
      expect(compileRule(rule)).toBeNull();
    });

    it('returns null for bare patterns', () => {
      const rule: RegexRule = {
        id: '1',
        name: 'Bare',
        findRegex: 'foo',
        replaceString: 'bar',
        disabled: false,
        userInput: true,
        aiOutput: false,
        prompt: false,
        display: false,
      };
      expect(compileRule(rule)).toBeNull();
    });
  });
});
