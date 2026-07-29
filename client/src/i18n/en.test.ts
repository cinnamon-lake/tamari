import { describe, it, expect } from 'vitest';
import * as i18n from '@solid-primitives/i18n';
import { dict } from './locales/en/index.js';

interface Leaf {
  path: string;
  value: unknown;
}

/** Recursively collect every leaf value, recording its dot-path. */
function collectLeaves(obj: Record<string, unknown>, prefix: string, out: Leaf[]): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      collectLeaves(value as Record<string, unknown>, path, out);
    } else {
      out.push({ path, value });
    }
  }
}

const leaves: Leaf[] = [];
collectLeaves(dict, '', leaves);

describe('English source dictionary', () => {
  it('has a healthy number of strings', () => {
    // Sanity floor — the full UI is extracted, so this should be well into the
    // hundreds. Catches a fragment accidentally being emptied.
    expect(leaves.length).toBeGreaterThan(150);
  });

  it('has no empty-string leaf values', () => {
    const empties = leaves.filter((l) => l.value === '').map((l) => l.path);
    expect(empties, `empty values at: ${empties.join(', ')}`).toEqual([]);
  });

  it('every leaf is a string (templates) or a function (parameterized)', () => {
    const bad = leaves
      .filter((l) => typeof l.value !== 'string' && typeof l.value !== 'function')
      .map((l) => `${l.path}=${JSON.stringify(l.value)}`);
    expect(bad, `non-string/function leaves: ${bad.join(', ')}`).toEqual([]);
  });

  it('has no duplicate leaf paths (no key shadows another)', () => {
    const counts = new Map<string, number>();
    for (const l of leaves) counts.set(l.path, (counts.get(l.path) ?? 0) + 1);
    const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([p]) => p);
    expect(dups, `duplicate leaf paths: ${dups.join(', ')}`).toEqual([]);
  });

  it('every leaf path resolves in the flattened dictionary', () => {
    // The real invariant: every string we authored must be reachable via t().
    const flat = i18n.flatten(dict);
    const missing = leaves
      .filter((l) => typeof l.value === 'string' && flat[l.path] !== l.value)
      .map((l) => l.path);
    expect(missing, `unreachable leaves: ${missing.slice(0, 20).join(', ')}`).toEqual([]);
  });
});
