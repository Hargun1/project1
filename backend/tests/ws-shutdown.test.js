import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Graceful shutdown must not depend on clients' cooperation (Phase 12).
 *
 * `wss.close` waits for every client to finish the closing handshake. A client
 * that never answers the close frame used to hold shutdown for `ws`'s 30 s close
 * timeout, so `server.js` hit its 10 s force-exit before documents were flushed.
 * Found by stopping a container while a client's event loop was busy.
 */

const DOC_ID = '77777777-7777-4777-8777-777777777777';
const EDITOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../src/websocket/ticket.service.js', () => ({
  issueTicket: vi.fn(),
  consumeTicket: vi.fn(async () => ({ userId: EDITOR, documentId: DOC_ID })),
}));
vi.mock('../src/repositories/user.repository.js', () => ({
  findById: vi.fn(async (id) => ({ id, name: 'Editor', email: 'e@x.test' })),
}));
vi.mock('../src/repositories/document.repository.js', () => ({
  getDocumentWithRole: vi.fn(async () => ({ document: { id: DOC_ID }, role: 'EDITOR' })),
  getDocumentState: vi.fn(async () => null),
  withLockedDocumentState: vi.fn(async (_id, fn) =>
    fn({
      current: null,
      writeState: async () => {},
      latestRevision: async () => null,
      revisionSnapshot: async () => null,
      createRevision: async (data) => ({ id: 'r', ...data }),
    }),
  ),
}));

const { attachWebSocketServer, closeWebSocketServer } =
  await import('../src/websocket/ws-server.js');
const { createCollaborationHub } = await import('../src/services/collaboration.service.js');

let server;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
});

/**
 * A WebSocket client reduced to the handshake: it upgrades, then ignores every
 * frame it receives, including the server's close frame.
 */
async function unresponsiveClient(port) {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    [
      'GET /ws?ticket=t-1 HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );
  const [response] = await once(socket, 'data');
  expect(response.toString()).toMatch(/^HTTP\/1\.1 101/);
  socket.on('data', () => {}); // read and discard; never reply
  return socket;
}

describe('closeWebSocketServer', () => {
  it('terminates a client that never answers the close frame, after the grace period', async () => {
    server = createServer();
    const wss = attachWebSocketServer(server, { hub: createCollaborationHub() });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const socket = await unresponsiveClient(server.address().port);
    const socketClosed = once(socket, 'close');
    expect(wss.clients.size).toBe(1);

    const started = Date.now();
    await closeWebSocketServer(wss, { graceMs: 200 });
    const elapsed = Date.now() - started;

    // Not ws's 30 s close timeout: the grace period, plus a little.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
    await socketClosed;
  });
});
