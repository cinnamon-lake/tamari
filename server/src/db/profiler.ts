/**
 * SQL query profiler for @libsql/client.
 *
 * Wraps a Client to measure every execute()/batch()/transaction() call,
 * logs slow queries immediately, and can print an aggregate report.
 *
 * Enable via environment variable:
 *   SQL_PROFILE=1          — wrap the DB client with the profiler
 *   SQL_SLOW_MS=5          — threshold (ms) for "slow" query logging (default 5)
 *   SQL_PROFILE_TOP=20     — number of queries to show in the final report (default 20)
 */

import type {
  Client,
  InStatement,
  InArgs,
  ResultSet,
  Transaction,
  TransactionMode,
} from '@libsql/client';

import { getLogger } from '../lib/logger.js';

const log = getLogger('db:profiler');

export interface ProfilerConfig {
  slowMs: number;
  topN: number;
}

interface QueryEntry {
  sql: string;
  normalized: string;
  durationMs: number;
  rowCount: number;
  timestamp: number;
}

interface Aggregate {
  normalized: string;
  count: number;
  totalMs: number;
  maxMs: number;
  avgMs: number;
}

export function normalizeSql(sql: string): string {
  // Collapse whitespace
  let s = sql.replace(/\s+/g, ' ').trim();
  // Strip string literals
  s = s.replace(/'[^']*'/g, "'?'");
  // Strip numeric literals (but keep ? placeholders)
  s = s.replace(/\b-?\d+\.?\d*\b/g, '?');
  // Collapse IN clause placeholders
  s = s.replace(/\(\s*\?(,\s*\?)*\s*\)/g, '(?)');
  return s;
}

function extractSql(stmt: InStatement): string {
  if (typeof stmt === 'string') return stmt;
  return stmt.sql;
}

export class ProfiledClient implements Client {
  private entries: QueryEntry[] = [];
  private _closed = false;

  constructor(
    private readonly inner: Client,
    private readonly config: ProfilerConfig,
  ) {}

  get closed(): boolean {
    return this._closed || this.inner.closed;
  }

  get protocol(): string {
    return this.inner.protocol;
  }

  private record(sql: string, durationMs: number, rowCount: number): void {
    const normalized = normalizeSql(sql);
    const entry: QueryEntry = {
      sql: sql.length > 400 ? sql.slice(0, 400) + '...' : sql,
      normalized,
      durationMs,
      rowCount,
      timestamp: Date.now(),
    };
    this.entries.push(entry);

    if (durationMs >= this.config.slowMs) {
      log.warn(
        { durationMs, rows: rowCount, sql: entry.sql },
        `slow query (${durationMs.toFixed(1)}ms)`,
      );
    }
  }

  async execute(stmt: InStatement): Promise<ResultSet>;
  async execute(sql: string, args?: InArgs): Promise<ResultSet>;
  async execute(
    stmtOrSql: InStatement | string,
    maybeArgs?: InArgs,
  ): Promise<ResultSet> {
    const sql = typeof stmtOrSql === 'string' ? stmtOrSql : extractSql(stmtOrSql);
    const start = performance.now();
    try {
      const rs =
        typeof stmtOrSql === 'string'
          ? maybeArgs !== undefined
            ? await this.inner.execute(stmtOrSql, maybeArgs)
            : await this.inner.execute(stmtOrSql)
          : await this.inner.execute(stmtOrSql);
      this.record(sql, performance.now() - start, rs.rows.length);
      return rs;
    } catch (err) {
      this.record(sql, performance.now() - start, 0);
      throw err;
    }
  }

  async batch(
    stmts: Array<InStatement | [string, InArgs?]>,
    mode?: TransactionMode,
  ): Promise<Array<ResultSet>> {
    const start = performance.now();
    try {
      const rss = await this.inner.batch(stmts, mode);
      const duration = performance.now() - start;
      const totalRows = rss.reduce((sum, rs) => sum + rs.rows.length, 0);
      const sql = `BATCH[${stmts.length}]`;
      this.record(sql, duration, totalRows);
      return rss;
    } catch (err) {
      const duration = performance.now() - start;
      this.record(`BATCH[${stmts.length}]`, duration, 0);
      throw err;
    }
  }

  async migrate(stmts: Array<InStatement>): Promise<Array<ResultSet>> {
    const start = performance.now();
    try {
      const rss = await this.inner.migrate(stmts);
      const duration = performance.now() - start;
      const totalRows = rss.reduce((sum, rs) => sum + rs.rows.length, 0);
      this.record(`MIGRATE[${stmts.length}]`, duration, totalRows);
      return rss;
    } catch (err) {
      const duration = performance.now() - start;
      this.record(`MIGRATE[${stmts.length}]`, duration, 0);
      throw err;
    }
  }

  async transaction(mode?: TransactionMode): Promise<Transaction> {
    const tx = await this.inner.transaction(mode);
    return new ProfiledTransaction(tx, (sql, dur, rows) =>
      this.record(sql, dur, rows),
    );
  }

  async executeMultiple(sql: string): Promise<void> {
    const start = performance.now();
    try {
      await this.inner.executeMultiple(sql);
      this.record(`EXECUTE_MULTIPLE`, performance.now() - start, 0);
    } catch (err) {
      this.record(`EXECUTE_MULTIPLE`, performance.now() - start, 0);
      throw err;
    }
  }

  async sync(): Promise<import('@libsql/core/api').Replicated> {
    return this.inner.sync();
  }

  close(): void {
    this._closed = true;
    this.inner.close();
  }

  reconnect(): void {
    this.inner.reconnect();
  }

  report(): void {
    if (this.entries.length === 0) {
      log.info('no queries recorded');
      return;
    }

    const totalMs = this.entries.reduce((s, e) => s + e.durationMs, 0);
    const avgMs = totalMs / this.entries.length;
    const maxEntry = this.entries.reduce((a, b) => (a.durationMs > b.durationMs ? a : b));

    // Aggregate by normalized SQL
    const map = new Map<string, Aggregate>();
    for (const e of this.entries) {
      const a = map.get(e.normalized) ?? {
        normalized: e.normalized,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        avgMs: 0,
      };
      a.count++;
      a.totalMs += e.durationMs;
      if (e.durationMs > a.maxMs) a.maxMs = e.durationMs;
      map.set(e.normalized, a);
    }
    for (const a of map.values()) {
      a.avgMs = a.totalMs / a.count;
    }

    const sortedByTime = [...map.values()].sort((a, b) => b.totalMs - a.totalMs);
    const sortedByMax = [...map.values()].sort((a, b) => b.maxMs - a.maxMs);
    const topN = this.config.topN;

    log.info(
      `SQL Profile Report — ${this.entries.length} queries, total ${totalMs.toFixed(1)}ms, avg ${avgMs.toFixed(2)}ms, max ${maxEntry.durationMs.toFixed(1)}ms`,
    );

    log.info('--- Top queries by TOTAL time ---');
    for (let i = 0; i < Math.min(topN, sortedByTime.length); i++) {
      const a = sortedByTime[i]!;
      log.info(
        `  #${i + 1}  count=${a.count}  total=${a.totalMs.toFixed(1)}ms  avg=${a.avgMs.toFixed(2)}ms  max=${a.maxMs.toFixed(1)}ms  ${a.normalized.slice(0, 200)}`,
      );
    }

    log.info('--- Top queries by MAX time ---');
    for (let i = 0; i < Math.min(topN, sortedByMax.length); i++) {
      const a = sortedByMax[i]!;
      log.info(
        `  #${i + 1}  count=${a.count}  total=${a.totalMs.toFixed(1)}ms  avg=${a.avgMs.toFixed(2)}ms  max=${a.maxMs.toFixed(1)}ms  ${a.normalized.slice(0, 200)}`,
      );
    }
  }
}

class ProfiledTransaction implements Transaction {
  constructor(
    private readonly inner: Transaction,
    private readonly record: (sql: string, durationMs: number, rowCount: number) => void,
  ) {}

  get closed(): boolean {
    return this.inner.closed;
  }

  async execute(stmt: InStatement): Promise<ResultSet> {
    const sql = extractSql(stmt);
    const start = performance.now();
    try {
      const rs = await this.inner.execute(stmt);
      this.record(sql, performance.now() - start, rs.rows.length);
      return rs;
    } catch (err) {
      this.record(sql, performance.now() - start, 0);
      throw err;
    }
  }

  async batch(stmts: Array<InStatement>): Promise<Array<ResultSet>> {
    const start = performance.now();
    try {
      const rss = await this.inner.batch(stmts);
      const duration = performance.now() - start;
      const totalRows = rss.reduce((sum, rs) => sum + rs.rows.length, 0);
      this.record(`TX_BATCH[${stmts.length}]`, duration, totalRows);
      return rss;
    } catch (err) {
      const duration = performance.now() - start;
      this.record(`TX_BATCH[${stmts.length}]`, duration, 0);
      throw err;
    }
  }

  async executeMultiple(sql: string): Promise<void> {
    const start = performance.now();
    try {
      await this.inner.executeMultiple(sql);
      this.record(`TX_EXECUTE_MULTIPLE`, performance.now() - start, 0);
    } catch (err) {
      this.record(`TX_EXECUTE_MULTIPLE`, performance.now() - start, 0);
      throw err;
    }
  }

  async rollback(): Promise<void> {
    const start = performance.now();
    try {
      await this.inner.rollback();
      this.record('TX_ROLLBACK', performance.now() - start, 0);
    } catch (err) {
      this.record('TX_ROLLBACK', performance.now() - start, 0);
      throw err;
    }
  }

  async commit(): Promise<void> {
    const start = performance.now();
    try {
      await this.inner.commit();
      this.record('TX_COMMIT', performance.now() - start, 0);
    } catch (err) {
      this.record('TX_COMMIT', performance.now() - start, 0);
      throw err;
    }
  }

  close(): void {
    this.inner.close();
  }
}

export function createProfilerConfig(): ProfilerConfig {
  return {
    slowMs: parseInt(process.env.SQL_SLOW_MS ?? '5', 10),
    topN: parseInt(process.env.SQL_PROFILE_TOP ?? '20', 10),
  };
}

export function isProfilingEnabled(): boolean {
  return process.env.SQL_PROFILE === '1' || process.env.SQL_PROFILE === 'true';
}
