/**
 * Re-embed the canonical game-lib + Guildhall sources into the
 * `game_cards_example` doc (server/src/services/templates/docs/gameCardsExample.ts).
 *
 * The doc ships display copies of docs/design/examples/game-lib/*.lua and
 * guildhall/main.lua inside a template literal; DocsTemplate.test.ts locks
 * them byte-identical to the canonical files. Run this after editing any of
 * those Lua sources — or after ADDING a lib module (missing blocks are
 * appended after the last embedded block). Run from server/:
 *
 *   npx tsx scripts/sync-game-cards-example.ts
 *
 * Idempotent: re-running with no source changes produces no diff.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_PATH = join(ROOT, 'server', 'src', 'services', 'templates', 'docs', 'gameCardsExample.ts');
const LIB_DIR = join(ROOT, 'docs', 'design', 'examples', 'game-lib');
const MAIN_PATH = join(ROOT, 'docs', 'design', 'examples', 'guildhall', 'main.lua');

// Escape for template-literal embedding: \ → \\, ` → \`, ${ → \${.
const escapeLua = (s: string): string => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const libModules = readdirSync(LIB_DIR)
  .filter((f) => f.endsWith('.lua'))
  .map((f) => f.replace(/\.lua$/, ''));

let src = readFileSync(DOC_PATH, 'utf8');
const before = src;

// Embedded blocks in the raw source: \`\`\`lua\n<escaped content>\`\`\`
const BLOCK_RE = /\\`\\`\\`lua\n([\s\S]*?)\\`\\`\\`/g;
const embeddedLibs = new Set<string>();
let embeddedMain = false;
let embedded = 0;
src = src.replace(BLOCK_RE, (whole: string, body: string) => {
  const firstLine = body.split('\n')[0] ?? '';
  const libMatch = firstLine.match(/^-- lib\/([\w-]+)\.lua/);
  if (libMatch && !libModules.includes(libMatch[1]!)) {
    console.log(`removed block for lib/${libMatch[1]}.lua (module deleted)`);
    return ''; // orphan block: the module is gone from the lib
  }
  let canonical: string | null = null;
  if (libMatch) {
    embeddedLibs.add(libMatch[1]!);
    canonical = readFileSync(join(LIB_DIR, `${libMatch[1]}.lua`), 'utf8');
  } else if (body.split('\n').length > 200) {
    embeddedMain = true;
    canonical = readFileSync(MAIN_PATH, 'utf8');
  } else {
    return whole; // a prose lua snippet, not an embedded source
  }
  embedded++;
  return '\\`\\`\\`lua\n' + escapeLua(canonical.replace(/\s+$/, '')) + '\n\\`\\`\\`';
});
// Removing a block can leave a doubled blank line behind.
src = src.replace(/\n{3,}(?=\\`\\`\\`lua)/g, '\n\n');

// New lib modules have no block yet — append them after the last embedded one.
const missing = libModules.filter((m) => !embeddedLibs.has(m));
if (missing.length > 0) {
  const blocks = missing.map(
    (m) =>
      '\\`\\`\\`lua\n' +
      escapeLua(readFileSync(join(LIB_DIR, `${m}.lua`), 'utf8').replace(/\s+$/, '')) +
      '\n\\`\\`\\`',
  );
  // Insert before the doc's final closing backtick of the template literal.
  const tail = '`;\n';
  if (!src.endsWith(tail)) throw new Error('unexpected doc tail — structure changed?');
  src = src.slice(0, -tail.length) + '\n' + blocks.join('\n\n') + '\n' + tail;
  for (const m of missing) {
    embedded++;
    console.log(`inserted NEW block for lib/${m}.lua`);
  }
}

const expected = libModules.length + 1; // lib modules + the Guildhall main
if (embedded !== expected || !embeddedMain) {
  console.error(`expected ${expected} embedded blocks (${libModules.length} lib + Guildhall main), found ${embedded}`);
  process.exit(1);
}
if (src === before) {
  console.log('already in sync — no changes');
} else {
  writeFileSync(DOC_PATH, src);
  console.log(`gameCardsExample.ts updated (${embedded} blocks)`);
}
