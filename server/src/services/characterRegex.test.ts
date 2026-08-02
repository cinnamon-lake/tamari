import { describe, it, expect } from 'vitest';
import { getCharacterRegexRules, mergeRegexRules, convertLegacyScopedScripts } from './characterRegex.js';
import type { Character, RegexRule } from '@tamari/types';

function makeCharacter(extensions: Record<string, unknown>): Character {
  return { id: 'c1', name: 'C', extensions } as unknown as Character;
}

function makeRule(overrides: Partial<RegexRule> = {}): RegexRule {
  return {
    id: 'r1',
    name: 'rule',
    findRegex: '/foo/g',
    replaceString: 'bar',
    disabled: false,
    userInput: false,
    aiOutput: false,
    prompt: true,
    display: true,
    ...overrides,
  };
}

describe('getCharacterRegexRules', () => {
  it('returns [] for missing/malformed extensions', () => {
    expect(getCharacterRegexRules(undefined)).toEqual([]);
    expect(getCharacterRegexRules(makeCharacter({}))).toEqual([]);
    expect(getCharacterRegexRules(makeCharacter({ regexScripts: 'nope' }))).toEqual([]);
    expect(getCharacterRegexRules(makeCharacter({ regexScripts: [null, 42, { noRegex: true }] }))).toEqual([]);
  });

  it('parses rules with defaults (universal prompt+display)', () => {
    const rules = getCharacterRegexRules(
      makeCharacter({ regexScripts: [{ findRegex: '/a/', replaceString: 'b' }] }),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ findRegex: '/a/', replaceString: 'b', prompt: true, display: true, disabled: false });
    expect(rules[0]?.id).toBeTruthy();
  });

  it('respects explicit flags', () => {
    const rules = getCharacterRegexRules(
      makeCharacter({ regexScripts: [{ id: 'x', name: 'n', findRegex: '/a/', replaceString: '', prompt: false, display: true, userInput: true, disabled: true }] }),
    );
    expect(rules[0]).toMatchObject({ id: 'x', prompt: false, display: true, userInput: true, disabled: true });
  });

  it('keeps rules with an empty findRegex (inert placeholders)', () => {
    const rules = getCharacterRegexRules(
      makeCharacter({ regexScripts: [{ id: 'p', name: 'placeholder', findRegex: '' }] }),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'p', findRegex: '' });
  });
});

describe('mergeRegexRules', () => {
  it('appends scoped rules after global ones', () => {
    const global = [makeRule({ id: 'g1', name: 'global' })];
    const character = makeCharacter({ regexScripts: [{ id: 's1', findRegex: '/b/', replaceString: 'c' }] });
    const merged = mergeRegexRules(global, character);
    expect(merged.map((r) => r.id)).toEqual(['g1', 's1']);
  });

  it('returns global rules untouched when no scoped rules exist', () => {
    const global = [makeRule()];
    expect(mergeRegexRules(global, makeCharacter({}))).toBe(global);
  });
});

describe('convertLegacyScopedScripts', () => {
  it('returns [] without regex_scripts', () => {
    expect(convertLegacyScopedScripts(undefined)).toEqual([]);
    expect(convertLegacyScopedScripts({})).toEqual([]);
    expect(convertLegacyScopedScripts({ regex_scripts: 'nope' })).toEqual([]);
  });

  it('maps a universal v1 script (both prompt and display, role from placement)', () => {
    const rules = convertLegacyScopedScripts({
      regex_scripts: [
        {
          scriptName: 'Shout',
          findRegex: '/hello/gi',
          replaceString: 'HELLO',
          placement: [1, 2],
          disabled: false,
          markdownOnly: false,
          promptOnly: false,
        },
      ],
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      name: 'Shout',
      findRegex: '/hello/gi',
      replaceString: 'HELLO',
      userInput: true,
      aiOutput: true,
      prompt: true,
      display: true,
      disabled: false,
    });
  });

  it('maps markdownOnly to display-only and promptOnly to prompt-only', () => {
    const [display] = convertLegacyScopedScripts({
      regex_scripts: [{ scriptName: 'd', findRegex: '/a/', replaceString: '', placement: [2], markdownOnly: true, promptOnly: false }],
    });
    expect(display).toMatchObject({ prompt: false, display: true, aiOutput: true, userInput: false });
    const [prompt] = convertLegacyScopedScripts({
      regex_scripts: [{ scriptName: 'p', findRegex: '/a/', replaceString: '', placement: [1], markdownOnly: false, promptOnly: true }],
    });
    expect(prompt).toMatchObject({ prompt: true, display: false, userInput: true, aiOutput: false });
  });
});
