import { isServerMessage, WS_CLOSE_CODES } from '@collab/shared';
import { requestWsTicket } from '../services/document.service.js';
import { ApiError } from '../services/api.js';

/**
 * WebSocket transport with ticket-based auth and automatic reconnection (§17, §21).
 *
 * This module knows nothing about Yjs. It owns the socket, the ticket, the
 * keepalive and the backoff; `collaboration/collab-provider.js` builds the sync
 * protocol on top of it.
 *
 *   1. Get a valid access token (refreshing it if it is about to expire).
 *   2. Exchange it for a single-use ticket via REST.
 *   3. Open `/ws?ticket=...`.
 *   4. Validate every inbound message with `isServerMessage`.
 *   5. On an unexpected close, retry with exponential backoff and a fresh ticket.
 */

/** Possible connection states. */
export const WS_STATUS = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
};

/** Close codes that mean "retrying will not help". */
const PERMANENT_CLOSE_CODES = [
  WS_CLOSE_CODES.AUTH_FAILED,
  WS_CLOSE_CODES.FORBIDDEN,
  WS_CLOSE_CODES.DOCUMENT_NOT_FOUND,
];

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const PING_INTERVAL_MS = 25_000; // under the server's 30 s heartbeat

/** Build the WebSocket URL relative to the current page origin. */
function buildWsUrl(ticket) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * @param {object} options
 * @param {string} options.documentId
 * @param {() => Promise<string>} options.getAccessToken
 * @param {(status: string, detail?: string) => void} options.onStatusChange
 * @param {(message: object) => void} options.onMessage
 * @returns {{ disconnect: () => void, send: (payload: object) => boolean }}
 */
export function createWsClient({ documentId, getAccessToken, onStatusChange, onMessage }) {
  let ws = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let intentionalClose = false;
  let pingInterval = null;

  async function connect() {
    if (intentionalClose) return;
    onStatusChange(reconnectAttempt > 0 ? WS_STATUS.RECONNECTING : WS_STATUS.CONNECTING);

    // ── 1–2. Fresh token, then a fresh single-use ticket ───────────────
    let ticket;
    try {
      ticket = await requestWsTicket(await getAccessToken(), documentId);
    } catch (err) {
      if (intentionalClose) return;
      // Access was revoked or the document is gone: retrying cannot succeed.
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
        onStatusChange(WS_STATUS.ERROR, err.message);
        return;
      }
      console.warn('[ws] could not get a ticket, will retry:', err.message);
      scheduleReconnect();
      return;
    }
    if (intentionalClose) return;

    // ── 3. Open the socket ─────────────────────────────────────────────
    const socket = new WebSocket(buildWsUrl(ticket));
    ws = socket;

    socket.onopen = () => {
      pingInterval = setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS);
    };

    socket.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        console.warn('[ws] non-JSON message ignored');
        return;
      }
      if (!isServerMessage(parsed)) {
        console.warn('[ws] unknown message type ignored:', parsed?.type);
        return;
      }
      if (parsed.type === 'pong') return; // transport concern only

      // "Connected" means authenticated and in the room, not merely TCP-open.
      if (parsed.type === 'joined') {
        reconnectAttempt = 0;
        onStatusChange(WS_STATUS.CONNECTED);
      }
      onMessage(parsed);
    };

    socket.onclose = (event) => {
      clearInterval(pingInterval);
      pingInterval = null;
      if (ws === socket) ws = null;

      if (intentionalClose) {
        onStatusChange(WS_STATUS.DISCONNECTED);
        return;
      }
      if (PERMANENT_CLOSE_CODES.includes(event.code)) {
        onStatusChange(WS_STATUS.ERROR, event.reason || 'Connection refused');
        return;
      }
      scheduleReconnect();
    };

    socket.onerror = () => {
      // 'close' always follows 'error'; reconnect logic lives there.
    };
  }

  function scheduleReconnect() {
    if (intentionalClose) return;
    // Exponential backoff with jitter, so a restarted server is not hit by every
    // client at the same instant.
    const base = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    reconnectAttempt += 1;
    onStatusChange(WS_STATUS.RECONNECTING);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  /**
   * Send a JSON payload. Returns false (and drops it) when the socket is not
   * open — the Yjs layer does not need a queue, because the state-vector
   * exchange on reconnect re-sends whatever the server is missing.
   *
   * @param {object} payload
   * @returns {boolean}
   */
  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  /** Intentionally close the connection. No reconnect will be attempted. */
  function disconnect() {
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    clearInterval(pingInterval);
    if (ws) {
      ws.close(WS_CLOSE_CODES.NORMAL, 'Client disconnecting');
      ws = null;
    }
    onStatusChange(WS_STATUS.DISCONNECTED);
  }

  void connect();

  return { disconnect, send };
}
