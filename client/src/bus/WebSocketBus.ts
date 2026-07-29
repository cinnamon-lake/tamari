import type { ClientMessageInput, ServerMessage } from '@tamari/types';
import { ServerMessageSchema } from '@tamari/types';
import { getAuthToken } from '../lib/auth.js';

type MessageHandler<T extends ServerMessage['type']> = (msg: Extract<ServerMessage, { type: T }>) => void;

/** How often to ping the server to keep/probe the connection. */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Reconnect if no pong has arrived within this window (zombie socket). */
const HEARTBEAT_STALE_MS = 25_000;

export class WebSocketBus {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private handlers = new Map<string, Set<(msg: ServerMessage) => void>>();
  private pending: ClientMessageInput[] = [];
  private url: string;

  connected = false;
  clientId = '';
  authError = false;

  constructor(url?: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getAuthToken();
    const baseUrl = url ?? `${protocol}//${window.location.host}/ws`;
    this.url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
  }

  connect() {
    if (this.ws) return;

    // Rebuild URL in case the auth token changed
    const token = getAuthToken();
    const baseUrl = this.url.split('?')[0] ?? this.url;
    this.url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
    this.authError = false;

    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.onopen = () => {
      // Ignore events from a socket that forceReconnect() has already
      // replaced — acting on them would corrupt the live connection.
      if (this.ws !== socket) return;
      this.connected = true;
      // Request snapshot via auth (token already sent in URL query params)
      this.send({ type: 'auth' });
      // Flush pending messages. Drain into a local copy first: if send()
      // re-queues (socket not actually OPEN), the re-queued messages land in
      // a fresh `pending` instead of spinning this loop forever.
      const queued = this.pending.splice(0);
      for (const msg of queued) {
        this.send(msg);
      }
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      try {
        const parsed = JSON.parse(String(event.data)) as Record<string, unknown> | null;
        // Heartbeat pong — a transport-level ack, not a domain ServerMessage,
        // so handle it before schema validation.
        if (parsed?.type === 'pong') {
          this.lastPongAt = Date.now();
          return;
        }
        const result = ServerMessageSchema.safeParse(parsed);
        if (!result.success) {
          console.error('[bus] Invalid message:', result.error.flatten());
          return;
        }
        const msg = result.data;
        if (msg.type === 'client.assigned') {
          this.clientId = msg.clientId;
        }
        if (msg.type === 'auth.error') {
          this.authError = true;
          console.error('[bus] Authentication error:', msg.message);
        }
        this.emit(msg);
      } catch (err) {
        console.error('[bus] Failed to parse message:', err);
      }
    };

    socket.onclose = () => {
      // A close event can arrive late, after forceReconnect() already
      // installed a replacement socket. Ignore it — otherwise we'd null out
      // the live socket (the next send/flush would then stall or spin).
      if (this.ws !== socket) return;
      this.ws = null;
      this.connected = false;
      this.stopHeartbeat();
      // Don't auto-reconnect after auth failure — wait for user to fix token
      if (this.authError) return;
      // Disconnected, reconnecting in 3s
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    socket.onerror = (err) => {
      console.error('[bus] WebSocket error:', err);
    };
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  /**
   * Probe the connection every HEARTBEAT_INTERVAL_MS. Regular pings keep the
   * socket warm (defeating idle timeouts/proxies), and if no pong arrives for
   * HEARTBEAT_STALE_MS the socket is a zombie — readyState OPEN but the peer is
   * gone — so force a reconnect, which flushes `pending` on the fresh link.
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_STALE_MS) {
        console.error('[bus] heartbeat: no pong, socket appears dead — reconnecting');
        this.forceReconnect();
        return;
      }
      this.ws.send(JSON.stringify({ type: 'ping' }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Tear down the current socket synchronously and open a fresh one. */
  private forceReconnect() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // ignore — socket may already be dead
    }
    this.ws = null;
    this.connected = false;
    this.connect();
  }

  send(msg: ClientMessageInput) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      let payload: string;
      try {
        payload = JSON.stringify(msg);
      } catch (err) {
        console.error(
          '[bus] send: JSON.stringify threw type=' + (msg as { type: string }).type +
            ' err=' + (err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      try {
        this.ws.send(payload);
      } catch (err) {
        console.error(
          '[bus] send: ws.send threw type=' + (msg as { type: string }).type +
            ' err=' + (err instanceof Error ? err.message : String(err)) +
            ' — re-queuing to pending',
        );
        this.pending.push(msg);
      }
    } else {
      this.pending.push(msg);
    }
  }

  on<T extends ServerMessage['type']>(type: T, handler: MessageHandler<T>) {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as (msg: ServerMessage) => void);
    this.handlers.set(type, set);

    // Return unsubscribe function
    return () => {
      set.delete(handler as (msg: ServerMessage) => void);
      if (set.size === 0) this.handlers.delete(type);
    };
  }

  private emit(msg: ServerMessage) {
    const set = this.handlers.get(msg.type);
    if (set) {
      set.forEach((h) => h(msg));
    }
  }
}

export const bus = new WebSocketBus();
