import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_CLOSE_CODES } from '@collab/shared';

/**
 * The browser's WebSocket transport (Phase 13): tickets, the "connected"
 * definition, message filtering, backoff and which close codes end retrying.
 * No browser needed: WebSocket, window.location and the ticket request are
 * replaced, and fake timers drive the backoff.
 */

const tickets = vi.hoisted(() => ({ next: 0, fail: null }));

vi.mock('../src/services/document.service.js', () => ({
  requestWsTicket: vi.fn(async () => {
    if (tickets.fail) throw tickets.fail;
    tickets.next += 1;
    return `ticket-${tickets.next}`;
  }),
}));

const { createWsClient, WS_STATUS } = await import('../src/websocket/ws-client.js');
const { ApiError } = await import('../src/services/api.js');

/** Records every socket the client opens; tests drive the server side. */
class FakeWebSocket {
  static OPEN = 1;
  static sockets = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closedWith = null;
    FakeWebSocket.sockets.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    this.closedWith = { code, reason };
  }

  // ── server side ──
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  serverClose(code, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const latest = () => FakeWebSocket.sockets.at(-1);
const flush = () => vi.advanceTimersByTimeAsync(0);
const JOINED = { type: 'joined', documentId: 'd', userId: 'u', userName: 'U', role: 'EDITOR' };

let statuses;
let messages;

function start() {
  return createWsClient({
    documentId: 'doc-1',
    getAccessToken: async () => 'access-token',
    onStatusChange: (status, detail) => statuses.push(detail ? `${status}: ${detail}` : status),
    onMessage: (message) => messages.push(message),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0); // backoff = exactly half the base delay
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'editor.test' } });
  FakeWebSocket.sockets = [];
  tickets.next = 0;
  tickets.fail = null;
  statuses = [];
  messages = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('connecting', () => {
  it('opens /ws on the page’s host with a fresh single-use ticket', async () => {
    start();
    await flush();
    expect(latest().url).toBe('ws://editor.test/ws?ticket=ticket-1');
  });

  it('uses wss: on an https page', async () => {
    window.location.protocol = 'https:';
    start();
    await flush();
    expect(latest().url).toMatch(/^wss:\/\/editor\.test\/ws\?/);
  });

  it('reports CONNECTED only once the server says "joined", not when TCP opens', async () => {
    start();
    await flush();
    latest().open();
    expect(statuses).toEqual([WS_STATUS.CONNECTING]);
    latest().receive(JOINED);
    expect(statuses).toEqual([WS_STATUS.CONNECTING, WS_STATUS.CONNECTED]);
  });

  it('passes valid messages on and drops non-JSON, unknown types and pongs', async () => {
    start();
    await flush();
    latest().open();
    latest().receive('not json');
    latest().receive({ type: 'made-up' });
    latest().receive({ type: 'pong' });
    latest().receive({ type: 'update', update: 'AAA=' });
    expect(messages).toEqual([{ type: 'update', update: 'AAA=' }]);
  });

  it('sends only while the socket is open (Yjs re-syncs anything dropped)', async () => {
    const client = start();
    await flush();
    expect(client.send({ type: 'ping' })).toBe(false);
    latest().open();
    expect(client.send({ type: 'ping' })).toBe(true);
    expect(latest().sent).toEqual([{ type: 'ping' }]);
  });

  it('pings every 25 s, inside the server’s 30 s heartbeat', async () => {
    start();
    await flush();
    latest().open();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(latest().sent).toEqual([{ type: 'ping' }]);
  });
});

describe('reconnecting', () => {
  it('retries an unexpected close with exponential backoff and a new ticket each time', async () => {
    start();
    await flush();
    const first = latest();
    first.serverClose(1006);

    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(latest().url).toContain('ticket=ticket-2'); // tickets are single-use

    latest().serverClose(1006); // second failure: the delay doubles
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.sockets).toHaveLength(3);
    expect(statuses).toContain(WS_STATUS.RECONNECTING);
  });

  it('caps the delay at 30 s', async () => {
    start();
    await flush();
    for (let i = 0; i < 8; i += 1) {
      latest().serverClose(1006);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const before = FakeWebSocket.sockets.length;
    latest().serverClose(1006);
    await vi.advanceTimersByTimeAsync(14_999); // half of the 30 s cap, minus 1 ms
    expect(FakeWebSocket.sockets).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.sockets).toHaveLength(before + 1);
  });

  it('starts the backoff over after a successful join', async () => {
    start();
    await flush();
    latest().serverClose(1006);
    await vi.advanceTimersByTimeAsync(500);
    latest().serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    latest().open();
    latest().receive(JOINED);

    const before = FakeWebSocket.sockets.length;
    latest().serverClose(1006);
    await vi.advanceTimersByTimeAsync(500); // the first-attempt delay again
    expect(FakeWebSocket.sockets).toHaveLength(before + 1);
  });

  it('keeps backing off when sockets open but are refused before joining', async () => {
    // e.g. the database is down: TCP connects, then the server closes with 4009.
    // Resetting the backoff on "open" would hammer the server at the fastest rate.
    start();
    await flush();
    latest().serverClose(1006);
    await vi.advanceTimersByTimeAsync(500);
    latest().open();
    latest().serverClose(WS_CLOSE_CODES.DOCUMENT_UNAVAILABLE);

    const before = FakeWebSocket.sockets.length;
    await vi.advanceTimersByTimeAsync(999); // second attempt: 1 s, not 0.5 s again
    expect(FakeWebSocket.sockets).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.sockets).toHaveLength(before + 1);
  });

  it.each([
    ['SERVER_SHUTDOWN', WS_CLOSE_CODES.SERVER_SHUTDOWN],
    ['RATE_LIMITED', WS_CLOSE_CODES.RATE_LIMITED],
    ['DOCUMENT_UNAVAILABLE', WS_CLOSE_CODES.DOCUMENT_UNAVAILABLE],
  ])('reconnects after %s, which is temporary', async (_name, code) => {
    start();
    await flush();
    latest().serverClose(code);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.sockets).toHaveLength(2);
  });

  it.each([
    ['AUTH_FAILED', WS_CLOSE_CODES.AUTH_FAILED],
    ['FORBIDDEN (access removed)', WS_CLOSE_CODES.FORBIDDEN],
    ['DOCUMENT_NOT_FOUND (deleted)', WS_CLOSE_CODES.DOCUMENT_NOT_FOUND],
  ])('stops for good after %s', async (_name, code) => {
    start();
    await flush();
    latest().serverClose(code, 'Access denied');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.sockets).toHaveLength(1);
    expect(statuses.at(-1)).toBe(`${WS_STATUS.ERROR}: Access denied`);
  });

  it('stops when the ticket request says the user may not open the document', async () => {
    tickets.fail = new ApiError(403, 'FORBIDDEN', 'No access');
    start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.sockets).toHaveLength(0);
    expect(statuses.at(-1)).toBe(`${WS_STATUS.ERROR}: No access`);
  });

  it('keeps retrying when the ticket request fails for a network reason', async () => {
    tickets.fail = new ApiError(0, 'NETWORK_ERROR', 'offline');
    start();
    await vi.advanceTimersByTimeAsync(600);
    tickets.fail = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.sockets).toHaveLength(1);
  });
});

describe('disconnect()', () => {
  it('closes normally and never reconnects', async () => {
    const client = start();
    await flush();
    const socket = latest();
    socket.open();
    client.disconnect();
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'Client disconnecting' });
    socket.serverClose(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.sockets).toHaveLength(1);
    expect(statuses.at(-1)).toBe(WS_STATUS.DISCONNECTED);
  });

  it('cancels a pending reconnect', async () => {
    const client = start();
    await flush();
    latest().serverClose(1006);
    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.sockets).toHaveLength(1);
  });
});
