import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile, serializeEnvVar, loadEnvFile, appendEnvVar } from './envFile.js';

describe('parseEnvFile', () => {
  it('parses plain entries, skips comments and blank lines', () => {
    const parsed = parseEnvFile('# comment\n\nTAMARI_SECRET=hunter2\nPORT=8000\n');
    expect(parsed).toEqual({ TAMARI_SECRET: 'hunter2', PORT: '8000' });
  });

  it('unquotes double-quoted values', () => {
    expect(parseEnvFile('A="hello world"\n').A).toBe('hello world');
    expect(parseEnvFile('B="with \\"quotes\\" and # hash"\n').B).toBe('with "quotes" and # hash');
  });

  it('skips malformed lines instead of guessing', () => {
    expect(parseEnvFile('=novalue\n1BAD=start\nNO_EQUALS\n"unclosed\n')).toEqual({});
  });
});

describe('serializeEnvVar', () => {
  it('writes safe values raw and quotes everything else', () => {
    expect(serializeEnvVar('K', 'abc123_-/@.:+xyz')).toBe('K=abc123_-/@.:+xyz');
    expect(serializeEnvVar('K', 'has spaces')).toBe('K="has spaces"');
    expect(serializeEnvVar('K', 'hash # inside')).toBe('K="hash # inside"');
  });

  it('round-trips through parseEnvFile', () => {
    for (const value of ['simple', 'with space', 'quote " inside', 'hash # inside', 'trailing\\']) {
      const line = serializeEnvVar('KEY', value);
      expect(parseEnvFile(line + '\n').KEY).toBe(value);
    }
  });
});

describe('loadEnvFile / appendEnvVar', () => {
  let dir: string;
  let envPath: string;
  const ORIGINAL = process.env.TAMARI_TEST_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tamari-envfile-'));
    envPath = join(dir, '.env');
    delete process.env.TAMARI_TEST_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL === undefined) delete process.env.TAMARI_TEST_KEY;
    else process.env.TAMARI_TEST_KEY = ORIGINAL;
  });

  it('missing file loads nothing', () => {
    expect(loadEnvFile(envPath)).toEqual([]);
  });

  it('loads entries into process.env without overriding existing vars', () => {
    writeFileSync(envPath, 'TAMARI_TEST_KEY=from-file\n');
    process.env.TAMARI_TEST_KEY = 'from-env';
    expect(loadEnvFile(envPath)).toEqual([]);
    expect(process.env.TAMARI_TEST_KEY).toBe('from-env');

    delete process.env.TAMARI_TEST_KEY;
    expect(loadEnvFile(envPath)).toEqual(['TAMARI_TEST_KEY']);
    expect(process.env.TAMARI_TEST_KEY).toBe('from-file');
  });

  it('appendEnvVar creates the file with restrictive permissions', () => {
    appendEnvVar(envPath, 'TAMARI_TEST_KEY', 'chosen password');
    expect(readFileSync(envPath, 'utf8')).toContain('TAMARI_TEST_KEY="chosen password"');
    expect(loadEnvFile(envPath)).toEqual(['TAMARI_TEST_KEY']);
    expect(process.env.TAMARI_TEST_KEY).toBe('chosen password');
  });

  it('appendEnvVar appends to an existing file without mangling it', () => {
    writeFileSync(envPath, 'PORT=9000'); // no trailing newline on purpose
    appendEnvVar(envPath, 'TAMARI_TEST_KEY', 'pw');
    const content = readFileSync(envPath, 'utf8');
    expect(content).toBe('PORT=9000\nTAMARI_TEST_KEY=pw\n');
  });

  it('a second run finds the persisted secret and does not need a prompt', () => {
    appendEnvVar(envPath, 'TAMARI_TEST_KEY', 'pw');
    expect(existsSync(envPath)).toBe(true);
    // Simulate restart: fresh process.env, file present.
    delete process.env.TAMARI_TEST_KEY;
    expect(loadEnvFile(envPath)).toEqual(['TAMARI_TEST_KEY']);
  });
});
