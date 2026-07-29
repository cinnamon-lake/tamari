import { describe, it, expect } from 'vitest';
import { fuzzySearch, filterCharactersByQuery } from './fuzzySearch.js';

describe('fuzzySearch', () => {
  const data = [
    { name: 'Alice', tags: ['wizard', 'fantasy'] },
    { name: 'Bob', tags: ['robot', 'sci-fi'] },
    { name: 'Charlie', tags: ['vampire', 'horror'] },
  ];

  it('returns all data when query is empty', () => {
    expect(fuzzySearch('', { data, keys: ['name', 'tags'] })).toEqual(data);
  });

  it('returns fuzzy matches by name', () => {
    const results = fuzzySearch('Alce', { data, keys: ['name', 'tags'] });
    expect(results.map((r) => r.name)).toContain('Alice');
  });

  it('returns fuzzy matches by tag', () => {
    const results = fuzzySearch('scfi', { data, keys: ['name', 'tags'] });
    expect(results.map((r) => r.name)).toContain('Bob');
  });
});

describe('filterCharactersByQuery', () => {
  const chars = [
    { id: '1', name: 'Alice', tags: ['wizard', 'fantasy'] },
    { id: '2', name: 'Bob', tags: ['robot', 'sci-fi'] },
    { id: '3', name: 'Charlie', tags: ['vampire', 'horror'] },
  ];

  it('returns all characters when query is empty', () => {
    expect(filterCharactersByQuery(chars, '', false)).toEqual(chars);
  });

  it('uses substring matching when fuzzy is false', () => {
    const results = filterCharactersByQuery(chars, 'ali', false);
    expect(results.map((c) => c.name)).toEqual(['Alice']);
  });

  it('uses fuzzy matching when fuzzy is true', () => {
    const results = filterCharactersByQuery(chars, 'Alce', true);
    expect(results.map((c) => c.name)).toContain('Alice');
  });

  it('matches tags with substring mode', () => {
    const results = filterCharactersByQuery(chars, 'scifi', false);
    expect(results).toHaveLength(0);
  });

  it('matches tags with fuzzy mode', () => {
    const results = filterCharactersByQuery(chars, 'scifi', true);
    expect(results.map((c) => c.name)).toContain('Bob');
  });
});
