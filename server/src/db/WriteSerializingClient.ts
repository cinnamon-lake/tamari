/**
 * Write-serializing Client wrapper.
 *
 * The local-file @libsql/client driver runs every transaction on its own
 * connection with BEGIN IMMEDIATE and no busy timeout, so two overlapping
 * write windows fail fast: the loser gets SQLITE_BUSY "database is locked"
 * on the shared main connection — and because libsql does not reset a
 * statement that errored, that connection stays poisoned: every later
 * transaction detached onto it dies at COMMIT with "cannot commit
 * transaction - SQL statements in progress". Overlapping writers became
 * routine once nested generations (test sessions) arrived: the outer
 * target's fire-and-forget round-end persist races the inner session's
 * appends and ~1/s streaming flushes.
 *
 * This wrapper gives the whole app a single JS-level write lock: write
 * statements, batches, and the full BEGIN→COMMIT/ROLLBACK span of every
 * transaction are serialized; WAL readers pass through untouched. Without
 * it SQLite's single-writer rule is enforced by collisions; with it, by a
 * queue.
 */

import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from '@libsql/client';
import { getLogger } from '../lib/logger.js';

const log = getLogger('db');

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/** First keywords of statements that never take the write lock. Every WITH
 * in this codebase is a recursive SELECT (CTE writes would be misrouted,
 * but none exist — revisit if one appears). */
const READ_STARTERS = new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN']);

/** Does this statement only read? (Conservative: unknown → write.) */
export function isReadStatement(stmt: InStatement): boolean {
  const sql = typeof stmt === 'string' ? stmt : stmt.sql;
  const first = firstKeyword(sql);
  return READ_STARTERS.has(first);
}

function firstKeyword(sql: string): string {
  let s = sql;
  for (;;) {
    s = s.trimStart();
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      if (nl === -1) return '';
      s = s.slice(nl + 1);
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end === -1) return '';
      s = s.slice(end + 2);
    } else {
      break;
    }
  }
  const word = /^[A-Za-z]+/.exec(s);
  return word ? word[0].toUpperCase() : '';
}

function statementLabel(stmt: InStatement): string {
  const sql = (typeof stmt === 'string' ? stmt : stmt.sql).replace(/\s+/g, ' ').trim();
  return sql.length > 60 ? `${sql.slice(0, 60)}...` : sql;
}

/** Promise-chain mutex. A timed-out acquirer unblocks the queue (so one
 * stuck holder cannot wedge every future writer) and throws loudly. */
class WriteLock {
  private tail: Promise<void> = Promise.resolve();

  constructor(private timeoutMs: number) {}

  async acquire(label: string): Promise<() => void> {
    const prev = this.tail;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = prev.then(() => held);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
    });
    try {
      const outcome = await Promise.race([prev.then(() => release), timeout]);
      if (outcome === 'timeout') {
        release(); // don't chain successors behind the stuck holder
        throw new Error(
          `db write lock not acquired within ${this.timeoutMs}ms (${label}); ` +
            'a transaction was probably opened without commit/rollback',
        );
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Releases the write lock exactly once, on whichever of commit / rollback
 * / close happens first. Statements inside the transaction bypass the lock
 * — the transaction itself already holds it for its whole lifetime. */
class ReleasingTransaction implements Transaction {
  private released = false;

  constructor(
    private readonly inner: Transaction,
    private readonly release: () => void,
  ) {}

  get closed(): boolean {
    return this.inner.closed;
  }

  private once(): void {
    if (!this.released) {
      this.released = true;
      this.release();
    }
  }

  async execute(stmt: InStatement): Promise<ResultSet> {
    return this.inner.execute(stmt);
  }

  async batch(stmts: Array<InStatement>): Promise<Array<ResultSet>> {
    return this.inner.batch(stmts);
  }

  async executeMultiple(sql: string): Promise<void> {
    return this.inner.executeMultiple(sql);
  }

  async rollback(): Promise<void> {
    try {
      await this.inner.rollback();
    } finally {
      this.once();
    }
  }

  async commit(): Promise<void> {
    try {
      await this.inner.commit();
    } finally {
      this.once();
    }
  }

  close(): void {
    try {
      this.inner.close();
    } finally {
      this.once();
    }
  }
}

export class WriteSerializingClient implements Client {
  private readonly lock: WriteLock;

  constructor(
    private readonly inner: Client,
    lockTimeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  ) {
    this.lock = new WriteLock(lockTimeoutMs);
  }

  get closed(): boolean {
    return this.inner.closed;
  }

  get protocol(): Client['protocol'] {
    return this.inner.protocol;
  }

  async execute(stmt: InStatement): Promise<ResultSet>;
  async execute(sql: string, args?: InArgs): Promise<ResultSet>;
  async execute(stmtOrSql: InStatement | string, maybeArgs?: InArgs): Promise<ResultSet> {
    const stmt: InStatement =
      typeof stmtOrSql === 'string'
        ? maybeArgs !== undefined
          ? { sql: stmtOrSql, args: maybeArgs }
          : { sql: stmtOrSql }
        : stmtOrSql;
    if (isReadStatement(stmt)) return this.inner.execute(stmt);
    const release = await this.lock.acquire(statementLabel(stmt));
    try {
      return await this.inner.execute(stmt);
    } finally {
      release();
    }
  }

  async batch(
    stmts: Array<InStatement | [string, InArgs?]>,
    mode?: TransactionMode,
  ): Promise<Array<ResultSet>> {
    const release = await this.lock.acquire(`batch[${stmts.length}]`);
    try {
      return await this.inner.batch(stmts, mode);
    } finally {
      release();
    }
  }

  async migrate(stmts: Array<InStatement>): Promise<Array<ResultSet>> {
    const release = await this.lock.acquire(`migrate[${stmts.length}]`);
    try {
      return await this.inner.migrate(stmts);
    } finally {
      release();
    }
  }

  async transaction(mode?: TransactionMode): Promise<Transaction> {
    const release = await this.lock.acquire(`transaction(${mode ?? 'write'})`);
    let released = false;
    const once = () => {
      if (!released) {
        released = true;
        release();
      }
    };
    try {
      const tx = await this.inner.transaction(mode ?? 'write');
      return new ReleasingTransaction(tx, once);
    } catch (err) {
      once();
      log.error({ err, mode }, 'transaction BEGIN failed under write lock');
      throw err;
    }
  }

  async executeMultiple(sql: string): Promise<void> {
    const release = await this.lock.acquire('executeMultiple');
    try {
      await this.inner.executeMultiple(sql);
    } finally {
      release();
    }
  }

  async sync(): Promise<import('@libsql/client').Replicated> {
    return this.inner.sync();
  }

  close(): void {
    this.inner.close();
  }

  reconnect(): void {
    this.inner.reconnect();
  }
}
