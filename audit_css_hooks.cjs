#!/usr/bin/env node
/**
 * §16 Hookable Elements — audits JSX/TSX so every rendered HTML element has a
 * stable styling hook (a `class`, `classList`, or `id`). Users write custom CSS
 * against these hooks, so an unclassed element forces them into fragile
 * positional selectors (`:nth-child`) that break whenever the DOM changes.
 *
 * Run: `npm run lint:css` (repo root) or `node audit_css_hooks.cjs`.
 * Exits non-zero on any violation so CI can enforce §16.
 *
 * Deliberately NOT checked — content / native controls a user would not target
 * as a styling hook:
 *   - inline text semantics: strong, em, b, i, code
 *   - native media (browser-rendered controls): audio, video
 *   - native <select> children: option
 * Native toggle inputs (`<input type="radio|checkbox">`) are styled via their
 * container/group, not individually, and are exempted in findViolations().
 *
 * Test files (`*.test.tsx` / `*.spec.tsx`) are skipped.
 * `//` and `/* *\/` comments are stripped before scanning (strings and regex
 * literals preserved), so documentary markup like `<main>` inside a comment is
 * not mistaken for JSX.
 */
const fs = require('fs');
const path = require('path');

const CHECK_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'header', 'footer', 'nav', 'article', 'aside', 'main',
  'ul', 'ol', 'li', 'form', 'label', 'table', 'tr', 'td', 'th',
  'a', 'button', 'textarea', 'select', 'blockquote',
  'pre', 'input', 'img', 'iframe', 'canvas',
]);

const IS_TEST_FILE = /\.(test|spec)\.(t|j)sx?$/;

// Blank out `//` and `/* */` comments so commented-out or documentary markup
// (e.g. `<main>` mentioned in prose) is never scanned as JSX. String literals
// ('...', "...", `...`) are preserved verbatim; newlines inside comments are
// kept so reported line numbers still match the source file.
function stripComments(content) {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLine = false;
  let inBlock = false;

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      } else {
        out += ' ';
      }
      i++;
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 2;
        inBlock = false;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i++;
      continue;
    }

    if (inSingle || inDouble || inTemplate) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (inSingle && ch === "'") inSingle = false;
      else if (inDouble && ch === '"') inDouble = false;
      else if (inTemplate && ch === '`') inTemplate = false;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLine = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      i += 2;
      continue;
    }

    // Regex literals: a `/` after an operator/opener (or keyword like `return`)
    // starts a regex, not division. Quotes inside regexes (e.g. `.replace(/"/g,
    // ...)`) must not toggle string state, or everything after the regex is
    // misread as one long string and comments stop being stripped.
    if (ch === '/') {
      const prev = out.replace(/\s+$/, '');
      const prevCh = prev[prev.length - 1];
      const prevWord = (prev.match(/([A-Za-z_$][\w$]*)$/) ?? [])[1];
      const regexPrevChars = '(,=:[!&|?{};+-*%^~<>';
      const regexPrevWords = new Set(['return', 'typeof', 'case', 'delete', 'void', 'throw', 'yield', 'await', 'in', 'of', 'instanceof', 'else', 'do']);
      const isRegex =
        prevCh === undefined || regexPrevChars.includes(prevCh) || (prevWord !== undefined && regexPrevWords.has(prevWord));
      if (isRegex) {
        // Consume the literal verbatim: /pattern/flags, honoring escapes and
        // character classes (`/` inside [...] does not close the regex).
        let inClass = false;
        out += ch;
        i++;
        while (i < content.length) {
          const rc = content[i];
          out += rc;
          i++;
          if (rc === '\\') {
            out += content[i] ?? '';
            i++;
            continue;
          }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) break;
          else if (rc === '\n') break; // unterminated — bail out, treat rest normally
        }
        // Flags
        while (i < content.length && /[a-z]/.test(content[i])) {
          out += content[i];
          i++;
        }
        continue;
      }
    }

    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '`') inTemplate = true;
    out += ch;
    i++;
  }

  return out;
}

function findViolations(content) {
  const lines = stripComments(content).split(/\r?\n/);
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    let searchFrom = 0;

    while (true) {
      const line = lines[i];
      const substr = line.slice(searchFrom);
      const match = /<([a-z][a-z0-9]*)/.exec(substr);
      if (!match) break;

      const tagName = match[1];
      const tagStartIdx = searchFrom + match.index;

      if (!CHECK_TAGS.has(tagName)) {
        searchFrom = tagStartIdx + 1;
        continue;
      }

      // Gather full tag text (may span multiple lines)
      let j = i;
      let foundEnd = false;
      let endPos = -1;

      // State machine
      let inSingle = false;
      let inDouble = false;
      let braceDepth = 0;
      let bracketDepth = 0;
      let parenDepth = 0;

      while (j < lines.length) {
        const text = lines[j];
        let startPos = 0;
        if (j === i) {
          startPos = tagStartIdx + 1; // skip '<'
        }

        for (let pos = startPos; pos < text.length; pos++) {
          const ch = text[pos];
          if (inSingle) {
            if (ch === "'") inSingle = false;
            continue;
          }
          if (inDouble) {
            if (ch === '"') inDouble = false;
            continue;
          }
          if (ch === "'") {
            inSingle = true;
            continue;
          }
          if (ch === '"') {
            inDouble = true;
            continue;
          }
          if (ch === '{') {
            braceDepth++;
            continue;
          }
          if (ch === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
            continue;
          }
          if (ch === '[') {
            bracketDepth++;
            continue;
          }
          if (ch === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
            continue;
          }
          if (ch === '(') {
            parenDepth++;
            continue;
          }
          if (ch === ')') {
            parenDepth = Math.max(0, parenDepth - 1);
            continue;
          }

          if (ch === '>' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
            endPos = pos;
            foundEnd = true;
            break;
          }
        }

        if (foundEnd) break;
        j++;
        if (j - i > 50) break; // safety
      }

      if (!foundEnd) {
        searchFrom = tagStartIdx + 1;
        continue;
      }

      // Build tag text
      const parts = [];
      for (let k = i; k <= j; k++) {
        if (k === i && k === j) {
          parts.push(lines[k].slice(tagStartIdx, endPos + 1));
        } else if (k === i) {
          parts.push(lines[k].slice(tagStartIdx));
        } else if (k === j) {
          parts.push(lines[k].slice(0, endPos + 1));
        } else {
          parts.push(lines[k]);
        }
      }
      const tagText = parts.join('\n');

      const hasHook = /\b(class|classList|id)=/.test(tagText);
      // Native toggle controls (radio/checkbox) are styled via their
      // container/group, not as individual chrome — exempt them.
      const isNativeToggle =
        tagName === 'input' && /\btype\s*=\s*["']?(?:radio|checkbox)\b/.test(tagText);
      if (!hasHook && !isNativeToggle) {
        let snippet = tagText.replace(/\n/g, ' ');
        if (snippet.length > 120) snippet = snippet.slice(0, 117) + '...';
        violations.push({ lineNo: i + 1, tagName, snippet });
      }

      if (j === i) {
        // Tag was on a single line; keep searching after it
        searchFrom = endPos + 1;
      } else {
        // Tag spanned multiple lines; move to the line where it ended
        // But we need to continue scanning that line after the tag
        i = j;
        searchFrom = endPos + 1;
        // Note: the outer for loop will increment i, so we need to handle this
        // Actually, let's break out of the inner while and let the outer loop handle it
        // by setting i appropriately. But that's complex. Instead, just move i to j
        // and we'll handle the rest in the next iteration of the while loop.
        // Wait, the outer for loop will increment i at the end of this iteration.
        // So we need to set i = j - 1 so that after the for loop increments, i = j.
        i = j - 1;
        break; // break inner while, outer for will increment i to j
      }
    }
  }

  return violations;
}

function walk(dir, ext, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, ext, files);
    } else if (ext.some(e => entry.name.endsWith(e)) && !IS_TEST_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function main() {
  const files = [];
  if (fs.existsSync('client/src')) {
    files.push(...walk('client/src', ['.tsx', '.jsx']));
  }
  if (fs.existsSync('server/src')) {
    files.push(...walk('server/src', ['.tsx', '.jsx']));
  }

  let totalViolations = 0;
  const fileResults = [];

  for (const f of files.sort()) {
    let content;
    try {
      content = fs.readFileSync(f, 'utf-8');
    } catch (e) {
      continue;
    }
    const violations = findViolations(content);
    if (violations.length) {
      fileResults.push({ file: f, violations });
      totalViolations += violations.length;
    }
  }

  if (totalViolations === 0) {
    console.log('No §16 violations found.');
  } else {
    console.log(`Found ${totalViolations} §16 violation(s) across ${fileResults.length} file(s):\n`);
    for (const { file, violations } of fileResults) {
      console.log(`\n=== ${file} (${violations.length}) ===`);
      for (const v of violations) {
        console.log(`  line ${String(v.lineNo).padStart(4, ' ')}  <${v.tagName}>  ${v.snippet}`);
      }
    }
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TOTAL: ${totalViolations} §16 violations in ${fileResults.length} files`);
    process.exitCode = 1; // fail CI on hookable-element violations (§16)
  }

  // §22 advisory — scoped element selectors for reusable atoms. Permitted as a
  // single canonical definition per atom (e.g. `.modal input`); per-component
  // re-implementations are banned (§22). Reported for review, not CI-failing,
  // until the remaining input-atom selectors consolidate onto `.text-input`.
  const scoped = scanCssScopedAtoms();
  if (scoped.length) {
    console.log(`\n§22 advisory — ${scoped.length} scoped element selector(s) for atoms (review for per-component proliferation):`);
    for (const s of scoped) {
      console.log(`  ${s.file}:${s.lineNo}  ${s.selector}`);
    }
  }
}

// §22 — find `.ancestor-tag` selectors that style a reusable atom by reaching
// through a container. Excludes uncontrolled-HTML surfaces + native-widget state.
const ATOM_TAGS = /\b(input|button|textarea|select)\b/;
const UNCONTROLLED_HTML = /(message-content|reasoning-content|app-error|message-attachment)/;
const NATIVE_STATE = /:has\(|\[open\]|:checked|:disabled|:focus-within/;

function scanCssScopedAtoms() {
  if (!fs.existsSync('client/src')) return [];
  const cssFiles = walk('client/src', ['.css']);
  const findings = [];
  for (const f of cssFiles.sort()) {
    let content;
    try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\.[\w-]+.*\s+[a-z]/.test(line) && ATOM_TAGS.test(line)) {
        if (UNCONTROLLED_HTML.test(line) || NATIVE_STATE.test(line)) continue;
        findings.push({ file: f, lineNo: i + 1, selector: line.trim() });
      }
    }
  }
  return findings;
}

main();
