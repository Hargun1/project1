import { describe, expect, it } from 'vitest';
import {
  fromBase64,
  isBase64,
  isServerMessage,
  toBase64,
  WS_CLIENT_MESSAGE_TYPES,
  WS_SERVER_MESSAGE_TYPES,
} from '../src/index.js';

describe('base64 codec', () => {
  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('round-trips an empty array', () => {
    expect(toBase64(new Uint8Array())).toBe('');
    expect(fromBase64('')).toEqual(new Uint8Array());
  });

  // String.fromCharCode(...bytes) would overflow the call stack here; the
  // encoder must chunk.
  it('handles payloads larger than one chunk', () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 31) % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('matches the standard alphabet used by Node', () => {
    const bytes = new TextEncoder().encode('hello, collaborative world');
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it.each(['abc', 'ab$=', 'a===', '====', ' YQ==', 42, null])(
    'rejects malformed input %j',
    (value) => {
      expect(isBase64(value)).toBe(false);
      expect(() => fromBase64(value)).toThrow(TypeError);
    },
  );
});

describe('WebSocket message vocabulary', () => {
  it('lets the client send the sync protocol messages', () => {
    expect(WS_CLIENT_MESSAGE_TYPES).toEqual(
      expect.arrayContaining(['sync-step1', 'sync-step2', 'update']),
    );
  });

  it('accepts known server messages and rejects anything else', () => {
    for (const type of WS_SERVER_MESSAGE_TYPES) {
      expect(isServerMessage({ type })).toBe(true);
    }
    expect(isServerMessage({ type: 'nope' })).toBe(false);
    expect(isServerMessage({})).toBe(false);
    expect(isServerMessage(null)).toBe(false);
    expect(isServerMessage('update')).toBe(false);
  });
});
