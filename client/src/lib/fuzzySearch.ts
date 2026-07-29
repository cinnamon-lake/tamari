import Fuse from 'fuse.js';

export interface FuzzySearchOptions<T> {
  data: T[];
  keys: Array<keyof T | string>;
  threshold?: number;
}

/**
 * Perform a Fuse.js fuzzy search over a dataset.
 * Returns the original items sorted by match quality.
 */
export function fuzzySearch<T>(query: string, options: FuzzySearchOptions<T>): T[] {
  if (!query.trim()) return options.data;

  const fuse = new Fuse(options.data, {
    keys: options.keys as string[],
    threshold: options.threshold ?? 0.4,
    includeScore: false,
  });

  return fuse.search(query).map((result) => result.item);
}

/**
 * Filter characters by name and tags using either substring or fuzzy matching.
 */
export function filterCharactersByQuery<T extends { name: string; tags: string[] }>(
  items: T[],
  query: string,
  fuzzy: boolean,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return items;

  if (fuzzy) {
    return fuzzySearch(trimmed, {
      data: items,
      keys: ['name', 'tags'],
      threshold: 0.4,
    });
  }

  const lower = trimmed.toLowerCase();
  return items.filter(
    (c) => c.name.toLowerCase().includes(lower) || c.tags.some((t) => t.toLowerCase().includes(lower)),
  );
}
