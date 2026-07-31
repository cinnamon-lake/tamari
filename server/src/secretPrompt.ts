/**
 * First-run TAMARI_SECRET bootstrap.
 *
 * The secret is both the login password and the key for the API-key vault —
 * a random per-restart fallback (the old behavior) silently invalidated
 * sessions and made stored provider keys undecryptable. Instead, on first
 * interactive run we ask the user to choose a password and persist it to
 * `.env` in the working directory. Non-interactive runs (CI, docker, systemd)
 * keep the env-var contract; the random fallback there is warned about loudly
 * by the caller.
 */

import { join } from 'node:path';
import { appendEnvVar } from './envFile.js';

// The interactive dance uses console.log/console.error, NOT the pino logger:
// pino-pretty's worker transport flushes asynchronously and would interleave
// with (or lose the race against) the synchronous prompt writes below.

/**
 * Chars over-consumed by one read, saved for the next: a single `data` chunk
 * can hold several lines (pasted input, scripted ptys), and node's stream
 * hands the whole chunk to whichever listener is attached — without this,
 * input typed/pasted ahead would be silently swallowed by the wrong prompt.
 */
let pending = '';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

/** Read one line with no echo (raw-mode TTY). Ctrl-C aborts startup. */
function readPassword(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      process.stdout.write('\n');
      resolve(buf);
    };
    /** Consume chars into buf; returns the remainder after the first newline. */
    const feed = (text: string): string => {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === CTRL_C) {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          finish();
          // Swallow the \n of a \r\n pair so it can't answer the NEXT prompt.
          let rest = text.slice(i + 1);
          if (ch === '\r' && rest.startsWith('\n')) rest = rest.slice(1);
          return rest;
        }
        if (ch === BACKSPACE || ch === '\b') {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
      return '';
    };
    const onData = (chunk: string) => {
      pending += feed(chunk);
    };
    stdin.on('data', onData);
    // Drain anything a previous read over-consumed before waiting for more.
    if (pending) pending = feed(pending);
  });
}

/**
 * Ask the user to choose a password, confirm it, and write it as
 * TAMARI_SECRET to `<cwd>/.env`. Loops until the entries match and are
 * non-empty.
 */
export async function promptAndPersistSecret(): Promise<string> {
  console.log('First run: no TAMARI_SECRET found.');
  console.log('This password logs you into tamari and encrypts API keys stored in');
  console.log('the vault. Losing it means re-entering every stored provider key.');
  for (;;) {
    const first = (await readPassword('Please choose a password: ')).trim();
    if (!first) {
      console.error('Password must not be empty.');
      continue;
    }
    const second = (await readPassword('Repeat to confirm: ')).trim();
    if (first !== second) {
      console.error('Passwords did not match — try again.');
      continue;
    }
    const envPath = join(process.cwd(), '.env');
    appendEnvVar(envPath, 'TAMARI_SECRET', first);
    process.env.TAMARI_SECRET = first;
    console.log(`Password saved to ${envPath} — it will be picked up on every restart.`);
    return first;
  }
}

/** True when an interactive prompt is possible (real terminal on stdin). */
export function canPromptInteractively(): boolean {
  return process.stdin.isTTY === true;
}
