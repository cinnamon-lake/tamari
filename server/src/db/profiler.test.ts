import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProfiledClient, normalizeSql, createProfilerConfig } from './profiler.js';
import type { Client, ResultSet, Transaction } from '@libsql/client';

function mockResultSet(rowCount = 0): ResultSet {
  return {
    columns: [],
    columnTypes: [],
    rows: Array(rowCount).fill({ length: 0 }),
    rowsAffected: 0,
    lastInsertRowid: undefined,
    toJSON: () => ({}),
  };
}

function createMockClient(): Client {
  return {
    execute: vi.fn(async () => mockResultSet(0)),
    batch: vi.fn(async () => []),
    migrate: vi.fn(async () => []),
    transaction: vi.fn(async () => createMockTransaction()),
    executeMultiple: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
    close: vi.fn(),
    reconnect: vi.fn(),
    get closed() {
      return false;
    },
    get protocol() {
      return 'file';
    },
  };
}

function createMockTransaction(): Transaction {
  return {
    execute: vi.fn(async () => mockResultSet(0)),
    batch: vi.fn(async () => []),
    executeMultiple: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    close: vi.fn(),
    get closed() {
      return false;
    },
  };
}

describe('normalizeSql', () => {
  it('collapses whitespace', () => {
    expect(normalizeSql('SELECT  *   FROM foo')).toBe('SELECT * FROM foo');
  });

  it('replaces string literals with ?', () => {
    expect(normalizeSql("SELECT * FROM users WHERE name = 'Alice'")).toBe(
      "SELECT * FROM users WHERE name = '?'",
    );
  });

  it('replaces numeric literals with ?', () => {
    expect(normalizeSql('SELECT * FROM users WHERE id = 42')).toBe(
      'SELECT * FROM users WHERE id = ?',
    );
  });

  it('collapses IN clause placeholders', () => {
    expect(normalizeSql('SELECT * FROM foo WHERE id IN (?, ?, ?)')).toBe(
      'SELECT * FROM foo WHERE id IN (?)',
    );
  });
});

describe('ProfiledClient', () => {
  let inner: ReturnType<typeof createMockClient>;
  let profiled: ProfiledClient;

  beforeEach(() => {
    inner = createMockClient();
    profiled = new ProfiledClient(inner, { slowMs: 0, topN: 10 });
  });

  it('proxies execute with string SQL', async () => {
    const rs = await profiled.execute('SELECT 1');
    expect(inner.execute).toHaveBeenCalledWith('SELECT 1');
    expect(rs.rows).toHaveLength(0);
  });

  it('proxies execute with statement object', async () => {
    const stmt = { sql: 'SELECT ?', args: [1] };
    const rs = await profiled.execute(stmt);
    expect(inner.execute).toHaveBeenCalledWith(stmt);
    expect(rs.rows).toHaveLength(0);
  });

  it('proxies execute with sql and args', async () => {
    const rs = await profiled.execute('SELECT ?', [1]);
    expect(inner.execute).toHaveBeenCalledWith('SELECT ?', [1]);
    expect(rs.rows).toHaveLength(0);
  });

  it('proxies batch', async () => {
    const stmts = ['SELECT 1', { sql: 'SELECT ?', args: [2] }];
    await profiled.batch(stmts, 'write');
    expect(inner.batch).toHaveBeenCalledWith(stmts, 'write');
  });

  it('proxies migrate', async () => {
    const stmts = ['CREATE TABLE t (a INT)'];
    await profiled.migrate(stmts);
    expect(inner.migrate).toHaveBeenCalledWith(stmts);
  });

  it('proxies executeMultiple', async () => {
    await profiled.executeMultiple('SELECT 1; SELECT 2;');
    expect(inner.executeMultiple).toHaveBeenCalledWith('SELECT 1; SELECT 2;');
  });

  it('proxies sync', async () => {
    await profiled.sync();
    expect(inner.sync).toHaveBeenCalled();
  });

  it('proxies close', () => {
    profiled.close();
    expect(inner.close).toHaveBeenCalled();
    expect(profiled.closed).toBe(true);
  });

  it('proxies reconnect', () => {
    profiled.reconnect();
    expect(inner.reconnect).toHaveBeenCalled();
  });

  it('returns inner protocol', () => {
    expect(profiled.protocol).toBe('file');
  });

  it('wraps transaction and profiles its execute', async () => {
    const txMock = createMockTransaction();
    inner.transaction = vi.fn(async () => txMock);

    const tx = await profiled.transaction('write');
    expect(inner.transaction).toHaveBeenCalledWith('write');

    await tx.execute({ sql: 'INSERT INTO foo VALUES (?)', args: [1] });
    expect(txMock.execute).toHaveBeenCalledWith({ sql: 'INSERT INTO foo VALUES (?)', args: [1] });
  });

  it('profiles transaction commit and rollback', async () => {
    const txMock = createMockTransaction();
    inner.transaction = vi.fn(async () => txMock);

    const tx = await profiled.transaction();
    await tx.commit();
    expect(txMock.commit).toHaveBeenCalled();

    await tx.rollback();
    expect(txMock.rollback).toHaveBeenCalled();
  });

  it('report runs without error even with no queries', () => {
    expect(() => profiled.report()).not.toThrow();
  });

  it('report runs without error after queries', async () => {
    await profiled.execute('SELECT 1');
    await profiled.execute('SELECT 2');
    expect(() => profiled.report()).not.toThrow();
  });
});

describe('createProfilerConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses defaults', () => {
    delete process.env.SQL_SLOW_MS;
    delete process.env.SQL_PROFILE_TOP;
    const cfg = createProfilerConfig();
    expect(cfg.slowMs).toBe(5);
    expect(cfg.topN).toBe(20);
  });

  it('reads env vars', () => {
    process.env.SQL_SLOW_MS = '10';
    process.env.SQL_PROFILE_TOP = '50';
    const cfg = createProfilerConfig();
    expect(cfg.slowMs).toBe(10);
    expect(cfg.topN).toBe(50);
  });
});
