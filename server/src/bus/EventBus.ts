/**
 * EventBus — WebSocket connection manager and message broadcaster.
 *
 * Critical rule: the server MUST persist to SQLite BEFORE broadcasting.
 * This guarantees that a reconnecting client will see the same state
 * as existing clients.
 *
 * Broadcasting is intentionally broad: every broadcast goes to ALL
 * connected clients. This is a single-user app with a handful of
 * clients, so the cost of sending a message a client doesn't need is
 * trivial, and a dumb pipe is simpler than maintaining per-chat
 * subscriptions. Each client ignores broadcasts for entities/chats it
 * isn't rendering (see AGENTS.md §5).
 */

import { WebSocket } from 'ws';
import type { ServerMessage, ClientMessage, FullState } from '@tamari/types';
import { ServerMessageSchema } from '@tamari/types';
import { getLogger } from '../lib/logger.js';

const log = getLogger('bus');

const SENSITIVE_LOG_KEYS = new Set(
  ['apikey', 'api_key', 'key', 'token', 'secret', 'password', 'auth', 'authorization', 'value', 'access_token', 'refresh_token', 'proxy_password', 'proxypassword'].map((k) =>
    k.toLowerCase().replace(/[-_.]/g, ''),
  ),
);

function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_LOG_KEYS.has(key.toLowerCase().replace(/[-_.]/g, ''));
}

/** Best-effort recursive redaction of known-sensitive keys so secrets/PII never reach logs. */
function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForLog);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = isSensitiveLogKey(k) ? '[REDACTED]' : redactForLog(v);
    }
    return out;
  }
  return value;
}

export type MessageHandler = (client: ClientConnection, msg: ClientMessage) => void | Promise<void>;

export interface ClientConnection {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
}

export class EventBus {
  private clients = new Map<string, ClientConnection>();
  private handlers = new Map<string, MessageHandler[]>();
  private idCounter = 0;

  addClient(ws: WebSocket): ClientConnection {
    const id = `c:${++this.idCounter}`;
    const client: ClientConnection = { id, ws, authenticated: false };
    this.clients.set(id, client);
    log.debug(`+client ${id} (${this.clients.size} total)`);
    return client;
  }

  removeClient(id: string): void {
    this.clients.delete(id);
    log.debug(`-client ${id} (${this.clients.size} total)`);
  }

  registerHandler(type: ClientMessage['type'], handler: MessageHandler): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  async dispatch(client: ClientConnection, msg: ClientMessage): Promise<void> {
    // Log only the type at info (full payloads may contain API keys / chat content); the
    // redacted payload is available at debug for troubleshooting.
    log.info({ client: client.id, type: msg.type }, `${client.id} → ${msg.type}`);
    log.debug({ client: client.id, message: redactForLog(msg) }, 'inbound message payload');
    const handlers = this.handlers.get(msg.type) ?? [];
    for (const handler of handlers) {
      try {
        await handler(client, msg);
      } catch (err) {
        log.error({ client: client.id, type: msg.type, err }, `Handler error for ${msg.type}`);
        this.sendTo(client.id, {
          type: 'error',
          message: err instanceof Error ? err.message : 'Internal error',
          code: err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR',
        });
      }
    }
  }

  // ---------- Broadcasting ----------

  broadcast(msg: ServerMessage, originatorId?: string): void {
    // Every ServerMessage variant except 'auth.error' carries an optional
    // originator clientId — narrow it out so the spread stays well-typed.
    const enriched: ServerMessage =
      originatorId !== undefined && msg.type !== 'auth.error' ? { ...msg, clientId: originatorId } : msg;
    this.debugValidateOutbound(enriched);
    let payload: string;
    try {
      payload = JSON.stringify(enriched);
    } catch (err) {
      log.error(
        { type: enriched.type, err },
        'broadcast: JSON.stringify threw — message NOT sent to any client',
      );
      return;
    }
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(payload);
          count++;
        } catch (err) {
          log.error(
            { clientId: client.id, type: enriched.type, err },
            'broadcast: ws.send threw for one client',
          );
        }
      }
    }
    const type: string = enriched.type;
    if (type !== 'generation.token' && type !== 'generation.reasoningToken') {
      log.info({ type, count }, `* ${type} → ${count} clients`);
      log.debug({ type, count, message: redactForLog(enriched) }, 'outbound message payload');
    }
  }

  sendTo(clientId: string, msg: ServerMessage): void {
    this.debugValidateOutbound(msg);
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      let payload: string;
      try {
        payload = JSON.stringify(msg);
      } catch (err) {
        log.error(
          { clientId, type: msg.type, err },
          'sendTo: JSON.stringify threw — message NOT sent',
        );
        return;
      }
      try {
        client.ws.send(payload);
      } catch (err) {
        log.error(
          { clientId, type: msg.type, err },
          'sendTo: ws.send threw',
        );
        return;
      }
      log.debug(
        { client: clientId, type: msg.type },
        `→ ${clientId} ${msg.type}`,
      );
    }
  }

  /**
   * Opt-in (ST_VALIDATE_OUTBOUND=1) validation of outgoing messages against
   * ServerMessageSchema. Catches server bugs that produce a message the client
   * would silently drop via its own Zod check — surfaces them in the server log
   * instead of as an invisible dropped frame.
   */
  private debugValidateOutbound(msg: ServerMessage): void {
    if (process.env.ST_VALIDATE_OUTBOUND !== '1') return;
    const result = ServerMessageSchema.safeParse(msg);
    if (!result.success) {
      log.error(
        { type: msg.type, err: result.error.flatten() },
        'outbound message failed ServerMessageSchema — client will drop it',
      );
    }
  }

  // ---------- Snapshot ----------

  sendSnapshot(clientId: string, state: FullState): void {
    this.sendTo(clientId, { type: 'snapshot', state });
  }

  getConnectionCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN || client.ws.readyState === WebSocket.CONNECTING) {
        client.ws.close();
      }
    }
    this.clients.clear();
  }
}
