import { describe, it, expect } from 'vitest';
import { WorldInfoInjector } from './WorldInfoInjector.js';
import type { WorldInfoEntry, Message } from '@tamari/types';

const dummyTokenCounter = {
  count: (text: string) => Math.ceil(text.length / 4),
};

function makeEntry(partial: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    keys: ['magic'],
    content: 'There is magic in the air.',
    comment: '',
    order: 0,
    position: 'before_char',
    probability: 100,
    constant: false,
    selective: false,
    secondaryKeys: [],
    addMemo: false,
    disable: false,
    regex: false,
    recursive: false,
    ...partial,
  };
}

function makeMessage(content: string): Message {
  return {
    id: 1,
    parentId: null,
    role: 'user',
    extra: { parts: [{ type: 'text', text: content }] },
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('WorldInfoInjector', () => {
  const injector = new WorldInfoInjector();

  it('activates entries with keyword triggers', () => {
    const entries = [makeEntry({ keys: ['sword'] })];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('I draw my sword.')],
      budget: 1000,
      tokenCounter: dummyTokenCounter,
    });
    expect(result.before.length).toBe(1);
  });

  it('does not activate when keyword is missing', () => {
    const entries = [makeEntry({ keys: ['dragon'] })];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('I draw my sword.')],
      budget: 1000,
      tokenCounter: dummyTokenCounter,
    });
    expect(result.before.length).toBe(0);
  });

  it('activates constant entries regardless of text', () => {
    const entries = [makeEntry({ constant: true, keys: [] })];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('Hello world.')],
      budget: 1000,
      tokenCounter: dummyTokenCounter,
    });
    expect(result.before.length).toBe(1);
  });

  it('respects token budget', () => {
    const entries = [
      makeEntry({ keys: ['a'], content: 'A'.repeat(4) }),
      makeEntry({ keys: ['b'], content: 'B'.repeat(4) }),
    ];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('a and b')],
      budget: 1,
      tokenCounter: dummyTokenCounter,
    });
    expect(result.before.length).toBe(1);
  });

  describe('regex keys', () => {
    it('activates on regex match', () => {
      const entries = [makeEntry({ keys: ['\\b\\d{4}\\b'], regex: true })];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('The year is 1984.')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(1);
    });

    it('does not activate on regex mismatch', () => {
      const entries = [makeEntry({ keys: ['^hello$'], regex: true })];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('say hello there')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(0);
    });

    it('ignores invalid regex patterns safely', () => {
      const entries = [makeEntry({ keys: ['[invalid'], regex: true })];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('anything')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(0);
    });

    it('supports case-insensitive regex via flags', () => {
      const entries = [makeEntry({ keys: ['MAGIC'], regex: true })];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('there is magic here')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
        caseSensitive: false,
      });
      expect(result.before.length).toBe(1);
    });

    it('supports case-sensitive regex', () => {
      const entries = [makeEntry({ keys: ['MAGIC'], regex: true })];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('there is magic here')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
        caseSensitive: true,
      });
      expect(result.before.length).toBe(0);
    });

    it('handles selective mode with regex secondary keys', () => {
      const entries = [
        makeEntry({
          keys: ['\\bcastle\\b'],
          regex: true,
          selective: true,
          secondaryKeys: ['\\bknight\\b'],
        }),
      ];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('The castle is old but no warrior lives here.')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(0);
    });

    it('activates selective regex when both primary and secondary match', () => {
      const entries = [
        makeEntry({
          keys: ['\\bcastle\\b'],
          regex: true,
          selective: true,
          secondaryKeys: ['\\bknight\\b'],
        }),
      ];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('The castle is home to a brave knight.')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(1);
    });
  });

  describe('scanText override', () => {
    it('uses explicit scanText instead of chatHistory', () => {
      const entries = [makeEntry({ keys: ['override'] })];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('nothing here')],
        scanText: 'override present',
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(1);
    });

    it('prefers scanText even when chatHistory is empty', () => {
      const entries = [makeEntry({ keys: ['test'] })];
      const result = injector.scan({
        entries,
        chatHistory: [],
        scanText: 'test value',
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(1);
    });
  });

  describe('position filtering', () => {
    it('sorts entries into correct position buckets', () => {
      const entries = [
        makeEntry({ id: '1', keys: ['a'], position: 'top' }),
        makeEntry({ id: '2', keys: ['b'], position: 'bottom' }),
        makeEntry({ id: '3', keys: ['c'], position: 'before_char' }),
        makeEntry({ id: '4', keys: ['d'], position: 'after_char' }),
      ];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('a b c d')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.top.length).toBe(1);
      expect(result.bottom.length).toBe(1);
      expect(result.before.length).toBe(1);
      expect(result.after.length).toBe(1);
    });

    it('places atDepth entries in the atDepth bucket', () => {
      const entries = [makeEntry({ id: '1', keys: ['x'], position: 'atDepth', depth: 4, role: 'system' })];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('x')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.atDepth.length).toBe(1);
      expect(result.atDepth[0]!.entry.depth).toBe(4);
      expect(result.atDepth[0]!.entry.role).toBe('system');
      expect(result.before.length).toBe(0);
      expect(result.after.length).toBe(0);
    });
  });
});

describe('recursive activation', () => {
  const injector = new WorldInfoInjector();

  it('activates a secondary entry when a recursive entry triggers it', () => {
    const entries = [
      makeEntry({ id: '1', keys: ['magic'], content: 'There is magic in the air.', recursive: true }),
      makeEntry({ id: '2', keys: ['air'], content: 'The air smells of ozone.' }),
    ];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('I cast a magic spell.')],
      budget: 1000,
      tokenCounter: dummyTokenCounter,
    });
    // Round 0: "magic" triggers entry 1
    // Round 1: content of entry 1 ("There is magic in the air.") contains "air" → triggers entry 2
    expect(result.before.length).toBe(2);
    expect(result.before[0]!.entry.id).toBe('1');
    expect(result.before[1]!.entry.id).toBe('2');
  });

  it('does not recurse when the first entry is not recursive', () => {
    const entries = [
      makeEntry({ id: '1', keys: ['magic'], content: 'There is magic in the air.', recursive: false }),
      makeEntry({ id: '2', keys: ['air'], content: 'The air smells of ozone.' }),
    ];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('I cast a magic spell.')],
      budget: 1000,
      tokenCounter: dummyTokenCounter,
    });
    expect(result.before.length).toBe(1);
    expect(result.before[0]!.entry.id).toBe('1');
  });

  it('chains through multiple recursive rounds', () => {
    const entries = [
      makeEntry({ id: '1', keys: ['alpha'], content: 'beta', recursive: true }),
      makeEntry({ id: '2', keys: ['beta'], content: 'gamma', recursive: true }),
      makeEntry({ id: '3', keys: ['gamma'], content: 'delta' }),
    ];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('alpha')],
      budget: 1000,
      tokenCounter: dummyTokenCounter,
    });
    expect(result.before.length).toBe(3);
    expect(result.before[0]!.entry.id).toBe('1');
    expect(result.before[1]!.entry.id).toBe('2');
    expect(result.before[2]!.entry.id).toBe('3');
  });

  it('stops at maxRecursionDepth', () => {
    const entries = [
      makeEntry({ id: '1', keys: ['alpha'], content: 'beta', recursive: true }),
      makeEntry({ id: '2', keys: ['beta'], content: 'gamma', recursive: true }),
      makeEntry({ id: '3', keys: ['gamma'], content: 'delta', recursive: true }),
    ];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('alpha')],
      budget: 1000,
      tokenCounter: dummyTokenCounter,
      maxRecursionDepth: 1,
    });
    // Round 0: alpha → entry 1
    // Round 1: beta → entry 2
    // maxRecursionDepth = 1 means only 1 recursive round after round 0, so total 2 entries
    expect(result.before.length).toBe(2);
  });

  it('does not double-activate the same entry', () => {
    const entries = [makeEntry({ id: '1', keys: ['magic'], content: 'magic', recursive: true })];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('magic')],
      budget: 1000,
      tokenCounter: dummyTokenCounter,
    });
    expect(result.before.length).toBe(1);
  });

  it('applies budget across all recursive rounds', () => {
    const entries = [
      makeEntry({ id: '1', keys: ['a'], content: 'bbbb', recursive: true }),
      makeEntry({ id: '2', keys: ['b'], content: 'cccc' }),
    ];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('a')],
      budget: 1, // each entry is 1 token (4 chars / 4), so only first fits
      tokenCounter: dummyTokenCounter,
    });
    expect(result.before.length).toBe(1);
    expect(result.before[0]!.entry.id).toBe('1');
  });

  it('constant entries participate in recursion when recursive', () => {
    const entries = [
      makeEntry({ id: '1', constant: true, content: 'secret keyword', recursive: true }),
      makeEntry({ id: '2', keys: ['secret'], content: 'The secret is out.' }),
    ];
    const result = injector.scan({
      entries,
      chatHistory: [makeMessage('hello')],
      budget: 1000,
      tokenCounter: dummyTokenCounter,
    });
    expect(result.before.length).toBe(2);
  });
});

describe('WorldInfoInjector — sticky, cooldown, delay', () => {
  const injector = new WorldInfoInjector();

  function makeAssistantMessage(content: string, wiActivations?: string[]): Message {
    return {
      id: 1,
      parentId: null,
      role: 'assistant',
      extra: { parts: [{ type: 'text', text: content }], _wiActivations: wiActivations },
      createdAt: 0,
      updatedAt: 0,
    };
  }

  describe('delay', () => {
    it('blocks activation until chat has enough messages', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], delay: 3 })];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('dragon')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(0);
      expect(result.activatedEntryIds).toEqual([]);
    });

    it('allows activation once chat reaches the required length', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], delay: 3 })];
      const result = injector.scan({
        entries,
        chatHistory: [makeMessage('a'), makeMessage('b'), makeMessage('dragon')],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(1);
      expect(result.activatedEntryIds).toContain('1');
    });
  });

  describe('cooldown', () => {
    it('blocks re-activation within cooldown period', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], cooldown: 3 })];
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('dragon'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Entry was activated 1 message ago (cooldown=3), should not fire
      expect(result.before.length).toBe(0);
      expect(result.activatedEntryIds).toEqual([]);
    });

    it('allows re-activation after cooldown expires', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], cooldown: 2 })];
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('a'),
          makeMessage('b'),
          makeMessage('dragon'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Entry was activated 3 messages ago (cooldown=2), should fire
      expect(result.before.length).toBe(1);
      expect(result.activatedEntryIds).toContain('1');
    });
  });

  describe('sticky', () => {
    it('keeps entry active without trigger while sticky lasts', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], sticky: 3 })];
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('no dragon here'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Entry was activated 1 message ago (sticky=3), should stay active
      expect(result.before.length).toBe(1);
      // Sticky carry-over is NOT recorded as activated this turn
      expect(result.activatedEntryIds).toEqual([]);
    });

    it('drops sticky entry after sticky period expires', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], sticky: 2 })];
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('a'),
          makeMessage('b'),
          makeMessage('no monsters here'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Entry was activated 3 messages ago (sticky=2), should not be active
      expect(result.before.length).toBe(0);
    });

    it('re-activates sticky entry when trigger returns after sticky ends', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], sticky: 1 })];
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('a'),
          makeMessage('dragon'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Sticky expired (activated 2 messages ago, sticky=1), but trigger is present
      expect(result.before.length).toBe(1);
      expect(result.activatedEntryIds).toContain('1');
    });

    it('respects budget for sticky entries', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], sticky: 3, content: 'A'.repeat(40) })];
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('no dragon here'),
        ],
        budget: 1, // 40 chars / 4 = 10 tokens, but budget is 1
        tokenCounter: dummyTokenCounter,
      });
      expect(result.before.length).toBe(0);
    });
  });

  describe('combined effects', () => {
    it('sticky entry is not affected by cooldown during sticky period', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], sticky: 3, cooldown: 5 })];
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('no dragon here'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Sticky should keep it active despite cooldown
      expect(result.before.length).toBe(1);
    });

    it('cooldown applies after sticky ends', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], sticky: 1, cooldown: 3 })];
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('a'),
          makeMessage('dragon'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Sticky expired (2 messages ago), cooldown=3 should block re-activation
      expect(result.before.length).toBe(0);
      expect(result.activatedEntryIds).toEqual([]);
    });

    it('delay is checked before sticky and cooldown', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], delay: 5, sticky: 10 })];
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('dragon'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Only 3 messages total, delay=5 should block everything
      expect(result.before.length).toBe(0);
    });
  });

  describe('branch awareness', () => {
    it('only considers activations on the current branch', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], sticky: 2 })];
      // Simulate a branch where the entry was NOT activated in the parent
      const result = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['other-entry']),
          makeMessage('no monsters here'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // No activation of entry 1 on this branch, so sticky should not apply
      expect(result.before.length).toBe(0);
    });

    it('forked branch starts with parent state but diverges', () => {
      const entries = [makeEntry({ id: '1', keys: ['dragon'], sticky: 3 })];
      // Parent branch: entry activated, then 2 more messages
      const parentResult = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('a'),
          makeMessage('b'),
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Parent: activated 2 messages ago, sticky=3 → still active
      expect(parentResult.before.length).toBe(1);

      // Fork at message 'a': new branch has no activation of entry 1
      const forkResult = injector.scan({
        entries,
        chatHistory: [
          makeMessage('x'),
          makeAssistantMessage('y', ['1']),
          makeMessage('a'),
          // fork diverges here — no 'b' in this branch, and no new activation
        ],
        budget: 1000,
        tokenCounter: dummyTokenCounter,
      });
      // Fork: same distance (2 messages from activation), sticky=3 → still active
      // because the activation IS in the fork's history up to the fork point
      expect(forkResult.before.length).toBe(1);
    });
  });
});
