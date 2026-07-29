import { describe, it, expect } from 'vitest';
import { normalizeV3Entries, v3EntryToWorldInfoEntry, normalizeRisuMacros } from './characters.js';
// WorldInfoEntry type is used implicitly via the functions under test

describe('character import helpers', () => {
  describe('normalizeV3Entries', () => {
    it('returns empty array for null/undefined', () => {
      expect(normalizeV3Entries(null)).toEqual([]);
      expect(normalizeV3Entries(undefined)).toEqual([]);
    });

    it('returns array entries as-is', () => {
      const entries = [
        { keys: ['a'], content: 'A' },
        { keys: ['b'], content: 'B' },
      ];
      expect(normalizeV3Entries(entries)).toEqual(entries);
    });

    it('filters non-object items from array', () => {
      const entries = [
        { keys: ['a'], content: 'A' },
        null,
        42,
        { keys: ['b'], content: 'B' },
      ];
      expect(normalizeV3Entries(entries)).toEqual([
        { keys: ['a'], content: 'A' },
        { keys: ['b'], content: 'B' },
      ]);
    });

    it('converts legacy object shape to array', () => {
      const entries = {
        '0': { keys: ['a'], content: 'A' },
        '1': { keys: ['b'], content: 'B' },
      };
      expect(normalizeV3Entries(entries)).toEqual([
        { keys: ['a'], content: 'A' },
        { keys: ['b'], content: 'B' },
      ]);
    });

    it('returns empty array for primitives', () => {
      expect(normalizeV3Entries('string')).toEqual([]);
      expect(normalizeV3Entries(42)).toEqual([]);
    });
  });

  describe('v3EntryToWorldInfoEntry', () => {
    it('maps basic v3 fields correctly', () => {
      const e = {
        keys: ['magic', 'spell'],
        content: 'Magic is real.',
        enabled: true,
        insertion_order: 5,
        constant: false,
        selective: true,
        name: 'Magic Lore',
        comment: 'World building',
        case_sensitive: false,
        use_regex: true,
        secondaryKeys: ['wizard'],
        position: 'after_char',
      };

      const result = v3EntryToWorldInfoEntry(e, 0);

      expect(result.id).toBe('0');
      expect(result.keys).toEqual(['magic', 'spell']);
      expect(result.content).toBe('Magic is real.');
      expect(result.disable).toBe(false);
      expect(result.order).toBe(5);
      expect(result.constant).toBe(false);
      expect(result.selective).toBe(true);
      expect(result.comment).toBe('World building');
      expect(result.regex).toBe(true);
      expect(result.secondaryKeys).toEqual(['wizard']);
      expect(result.position).toBe('after_char');
    });

    it('inverts enabled: false to disable: true', () => {
      const e = { keys: ['test'], content: 'Test', enabled: false };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.disable).toBe(true);
    });

    it('defaults missing fields', () => {
      const e = { keys: ['test'], content: 'Test' };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.order).toBe(100);
      expect(result.position).toBe('before_char');
      expect(result.constant).toBe(false);
      expect(result.selective).toBe(false);
      expect(result.disable).toBe(false);
      expect(result.regex).toBe(false);
      expect(result.secondaryKeys).toEqual([]);
    });

    it('uses provided id when available', () => {
      const e = { id: 'custom-id', keys: ['test'], content: 'Test' };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.id).toBe('custom-id');
    });

    it('handles atDepth position with depth and role', () => {
      const e = {
        keys: ['deep'],
        content: 'Deep lore.',
        position: 'atDepth',
        depth: 3,
        role: 'user',
      };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.position).toBe('atDepth');
      expect(result.depth).toBe(3);
      expect(result.role).toBe('user');
    });

    it('defaults atDepth depth and role when missing', () => {
      const e = {
        keys: ['deep'],
        content: 'Deep lore.',
        position: 'atDepth',
      };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.depth).toBe(0);
      expect(result.role).toBe('system');
    });

    it('defaults invalid position to before_char', () => {
      const e = {
        keys: ['test'],
        content: 'Test',
        position: 'invalid_position',
      };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.position).toBe('before_char');
    });

    it('filters non-string keys', () => {
      const e = {
        keys: ['valid', 123, null, 'also-valid'],
        content: 'Test',
      };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.keys).toEqual(['valid', 'also-valid']);
    });

    it('filters non-string secondaryKeys', () => {
      const e = {
        keys: ['test'],
        content: 'Test',
        secondaryKeys: ['elf', 42, 'dwarf'],
      };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.secondaryKeys).toEqual(['elf', 'dwarf']);
    });

    it('sets retrievalMode to constant for constant entries', () => {
      const e = { keys: ['test'], content: 'Test', constant: true };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.retrievalMode).toBe('constant');
    });

    it('sets retrievalMode to keyword for non-constant entries', () => {
      const e = { keys: ['test'], content: 'Test', constant: false };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.retrievalMode).toBe('keyword');
    });

    it('handles blank key for constant injection (empty string in keys array)', () => {
      const e = {
        keys: [''],
        content: 'Always injected.',
        constant: true,
        enabled: true,
      };
      const result = v3EntryToWorldInfoEntry(e, 0);
      expect(result.keys).toEqual(['']);
      expect(result.constant).toBe(true);
      expect(result.retrievalMode).toBe('constant');
    });
  });

  describe('normalizeRisuMacros', () => {
    it('converts {{#if}} to {% if %}', () => {
      expect(normalizeRisuMacros('{{#if {{user}}}}yes{{/if}}')).toBe('{% if {{user}} %}yes{% endif %}');
    });

    it('converts {{else}} to {% else %}', () => {
      expect(normalizeRisuMacros('{{#if {{user}}}}yes{{else}}no{{/if}}')).toBe(
        '{% if {{user}} %}yes{% else %}no{% endif %}',
      );
    });

    it('converts {{/if}} to {% endif %}', () => {
      expect(normalizeRisuMacros('{{/if}}')).toBe('{% endif %}');
    });

    it('converts {{? expr}} to expr', () => {
      expect(normalizeRisuMacros('{{? true&&false}}')).toBe('true&&false');
    });

    it('handles nested macros inside {{#if}}', () => {
      const input = '{{#if {{equal::{{getvar::place}}::shrine}}}}Hello{{/if}}';
      expect(normalizeRisuMacros(input)).toBe('{% if {{equal::{{getvar::place}}::shrine}} %}Hello{% endif %}');
    });

    it('leaves regular macros untouched', () => {
      expect(normalizeRisuMacros('Hello {{user}}, meet {{char}}')).toBe('Hello {{user}}, meet {{char}}');
    });

    it('handles empty string', () => {
      expect(normalizeRisuMacros('')).toBe('');
    });

    it('handles complex RisuAI greeting', () => {
      const input =
        '{{#if {{? {{equal::{{getvar::place}}::하쿠레이_신사}}&&{{equal::{{getvar::situ}}::아는_상황}}}}}}Hello{{/if}}';
      const expected =
        '{% if {{equal::{{getvar::place}}::하쿠레이_신사}}&&{{equal::{{getvar::situ}}::아는_상황}} %}Hello{% endif %}';
      expect(normalizeRisuMacros(input)).toBe(expected);
    });
  });
});
