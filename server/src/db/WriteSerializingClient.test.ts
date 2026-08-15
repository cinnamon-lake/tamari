import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteSerializingClient, isReadStatement } from './WriteSerializingClient.js';

let inner: Client;
let client: WriteSerializingClient;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'write-serializer-test-'));
  inner = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  client = new WriteSerializingClient(inner, 500);
  await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  await client.execute("INSERT INTO t (v) VALUES ('seed')");
});

afterAll(() => {
  inner.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('isReadStatement', () => {
  it('classifies reads and writes', () => {
    expect(isReadStatement('SELECT 1')).toBe(true);
    expect(isReadStatement({ sql: 'select * from t where id = ?', args: [1] })).toBe(true);
    expect(isReadStatement('  WITH RECURSIVE c(n) AS (SELECT 1) SELECT * FROM c')).toBe(true);
    expect(isReadStatement('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isReadStatement({ sql: 'UPDATE t SET v = ?', args: ['x'] })).toBe(false);
    expect(isReadStatement('PRAGMA journal_mode = WAL')).toBe(false);
    // Leading comments must not hide the verb.
    expect(isReadStatement('-- comment\nSELECT 1')).toBe(true);
    expect(isReadStatement('/* c */ DELETE FROM t')).toBe(false);
  });
});

describe('WriteSerializingClient', () => {
  it('runs two overlapping write transactions without SQLITE_BUSY', async () => {
    const runTx = async (v: string) => {
      const tx = await client.transaction('write');
      try {
        await tx.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: [v] });
        await tx.commit();
      } catch (err) {
        await tx.rollback().catch(() => undefined);
        throw err;
      }
    };
    await Promise.all([runTx('a'), runTx('b')]);
    const rs = await client.execute("SELECT COUNT(*) AS c FROM t WHERE v IN ('a', 'b')");
    expect(Number(rs.rows[0]!.c)).toBe(2);
  });

  it('serializes a plain write execute against an open transaction', async () => {
    const tx = await client.transaction('write');
    await tx.execute({ sql: "INSERT INTO t (v) VALUES ('tx')", args: [] });
    // Concurrent plain write on the main connection: must queue behind the
    // transaction instead of failing with "database is locked".
    const plain = client.execute({ sql: "INSERT INTO t (v) VALUES ('plain')", args: [] });
    await tx.commit();
    await plain;
    const rs = await client.execute("SELECT COUNT(*) AS c FROM t WHERE v IN ('tx', 'plain')");
    expect(Number(rs.rows[0]!.c)).toBe(2);
  });

  it('lets reads run while a transaction is open (no deadlock)', async () => {
    const tx = await client.transaction('write');
    await tx.execute({ sql: "INSERT INTO t (v) VALUES ('locked')", args: [] });
    // Read must resolve without waiting for the write lock.
    await client.execute('SELECT COUNT(*) AS c FROM t');
    await tx.commit();
  });

  it('releases the lock after rollback', async () => {
    const tx = await client.transaction('write');
    await tx.execute({ sql: "INSERT INTO t (v) VALUES ('gone')", args: [] });
    await tx.rollback();
    await client.execute({ sql: "INSERT INTO t (v) VALUES ('after-rollback')", args: [] });
    const rs = await client.execute("SELECT COUNT(*) AS c FROM t WHERE v = 'gone'");
    expect(Number(rs.rows[0]!.c)).toBe(0);
  });

  it('releases the lock when a transaction is closed without commit', async () => {
    const tx = await client.transaction('write');
    await tx.execute({ sql: "INSERT INTO t (v) VALUES ('closed')", args: [] });
    tx.close();
    await client.execute({ sql: "INSERT INTO t (v) VALUES ('after-close')", args: [] });
  });

  it('throws a clear error instead of hanging forever on a leaked transaction', async () => {
    const tx = await client.transaction('write');
    await tx.execute({ sql: "INSERT INTO t (v) VALUES ('leaked')", args: [] });
    // Never committed/rolled back — the lock must time out with a message
    // pointing at the cause, not wedge every future writer.
    await expect(client.execute({ sql: "INSERT INTO t (v) VALUES ('next')", args: [] })).rejects.toThrow(
      /write lock not acquired.*transaction was probably opened/,
    );
    // The queue must not stay wedged behind the leaked holder.
    tx.close();
    await client.execute({ sql: "INSERT INTO t (v) VALUES ('recovered')", args: [] });
  });

  it('keeps ordering: queued writes apply in acquisition order', async () => {
    await client.execute('DELETE FROM t WHERE v LIKE \'ord-%\'');
    const writes = Array.from({ length: 10 }, (_, i) =>
      client.execute({ sql: `INSERT INTO t (v) VALUES ('ord-${i}')`, args: [] }),
    );
    await Promise.all(writes);
    const rs = await client.execute("SELECT v FROM t WHERE v LIKE 'ord-%' ORDER BY v");
    expect(rs.rows.map((r) => r.v)).toEqual(
      Array.from({ length: 10 }, (_, i) => `ord-${i}`),
    );
  });
});
