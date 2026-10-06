import { isServerMessage, WS_CLOSE_CODES } from '@collab/shared';
import { requestWsTicket } from '../services/document.service.js';

/**
 * Frontend WebSocket client with ticket-based auth and automatic reconnection (§17, §21).
 *
 * Usage:
 *   const client = createWsClient({
 *     documentId,
 *     accessToken,
 *     onStatusChange: (status) => setConnectionStatus(status),
 *     onMessage:      (msg)    => handleServerMessage(msg),
 *   });
 *
 *   // When the component unmounts:
 *   client.disconnect();
 *
 * The client:
 *   1. Requests a single-use ticket via REST.
 *   2. Opens a WebSocket to `/ws?ticket=...`.
 *   3. Validates incoming messages with `isServerMessage`.
 *   4. Reconnects with exponential backoff on unexpected disconnects.
 *   5. Reports status changes via the `onStatusChange` callback.
 */

/** Possible connection states. */
export const WS_STATUS = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
};

/** Build the WebSocket URL relative to the current page origin. */
function buildWsUrl(ticket) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * @param {object} options
 * @param {string} options.documentId
 * @param {string} options.accessToken
 * @param {(status: string) => void}  options.onStatusChange
 * @param {(message: object) => void} options.onMessage
 * @returns {{ disconnect: () => void, send: (payload: object) => void }}
 */
export function createWsClient({ documentId, accessToken, onStatusChange, onMessage }) {
  let ws = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let intentionalClose = false;
  let pingInterval = null;

  const MAX_RECONNECT_DELAY_MS = 30_000;
  const BASE_RECONNECT_DELAY_MS = 1_000;
  const PING_INTERVAL_MS = 25_000; // slightly under the server's 30 s heartbeat

  function setStatus(status) {
    onStatusChange(status);
  }

  async function connect() {
    if (intentionalClose) return;

    setStatus(reconnectAttempt > 0 ? WS_STATUS.RECONNECTING : WS_STATUS.CONNECTING);

    // ── 1. Get a fresh ticket ──────────────────────────────────────────
    let ticket;
    try {
      ticket = await requestWsTicket(accessToken, documentId);
    } catch (err) {
      console.error('[ws] Failed to get ticket:', err);
      setStatus(WS_STATUS.ERROR);
      scheduleReconnect();
      return;
    }

    if (intentionalClose) return;

    // ── 2. Open the socket ─────────────────────────────────────────────
    try {
      ws = new WebSocket(buildWsUrl(ticket));
    } catch (err) {
      console.error('[ws] Failed to create WebSocket:', err);
      setStatus(WS_STATUS.ERROR);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempt = 0;
      setStatus(WS_STATUS.CONNECTED);

      // Client-initiated keepalive — the server also pings, but this
      // exercises the connection from the client side and triggers the
      // server's `pong` listener.
      pingInterval = setInterval(() => {
        send({ type: 'ping' });
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        console.warn('[ws] Non-JSON message received');
        return;
      }

      if (!isServerMessage(parsed)) {
        console.warn('[ws] Unknown message type:', parsed);
        return;
      }

      // Don't surface pong to the application; it's a transport concern.
      if (parsed.type === 'pong') return;

      onMessage(parsed);
    };

    ws.onclose = (event) => {
      cleanup();

      if (intentionalClose) {
        setStatus(WS_STATUS.DISCONNECTED);
        return;
      }

      // If the server closed us for auth/forbidden reasons, don't retry.
      const noRetry = [
        WS_CLOSE_CODES.AUTH_FAILED,
        WS_CLOSE_CODES.FORBIDDEN,
        WS_CLOSE_CODES.DOCUMENT_NOT_FOUND,
      ];
      if (noRetry.includes(event.code)) {
        console.error(`[ws] Closed with code ${event.code}: ${event.reason}`);
        setStatus(WS_STATUS.ERROR);
        return;
      }

      setStatus(WS_STATUS.RECONNECTING);
      scheduleReconnect();
    };

    ws.onerror = () => {
      // The 'close' event always fires after 'error', so reconnect logic
      // is handled there.
      console.warn('[ws] Connection error');
    };
  }

  function cleanup() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    ws = null;
  }

  function scheduleReconnect() {
    if (intentionalClose) return;

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    reconnectAttempt += 1;

    console.warn(`[ws] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  /**
   * Send a JSON payload to the server.
   * Silently drops if the socket is not open (queuing is Phase 6's concern).
   *
   * @param {object} payload
   */
  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  /**
   * Intentionally close the connection. No reconnect will be attempted.
   */
  function disconnect() {
    intentionalClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    if (ws) {
      ws.close(WS_CLOSE_CODES.NORMAL, 'Client disconnecting');
      ws = null;
    }
    setStatus(WS_STATUS.DISCONNECTED);
  }

  // Start immediately
  connect();

  return { disconnect, send };
}
