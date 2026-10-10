/**
 * Base64 <-> Uint8Array, identical in the browser and in Node.
 *
 * Yjs updates are binary (`Uint8Array`), but every WebSocket message in this
 * project is a JSON envelope, so binary payloads travel as base64 strings. That
 * costs ~33% extra bytes on the wire and is a deliberate trade-off: one message
 * format (JSON, validated by one Zod union) is easier to debug and reason about
 * than a mixed text/binary protocol. The same envelope is reused for Redis
 * Pub/Sub in Phase 8 — see docs/collaboration.md.
 *
 * `btoa`/`atob` exist in both runtimes (Node >= 16), so this module needs no
 * environment check. They only accept "binary strings" (one char per byte), and
 * `String.fromCharCode(...bytes)` overflows the call stack on large arrays, hence
 * the chunking.
 */

const CHUNK_SIZE = 0x8000;

/** Strict alphabet check, so `fromBase64` never silently decodes garbage. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` is a well-formed (padded) base64 string
 */
export function isBase64(value) {
  return typeof value === 'string' && BASE64_PATTERN.test(value);
}

/**
 * @param {string} base64
 * @returns {Uint8Array}
 * @throws {TypeError} when the input is not well-formed base64
 */
export function fromBase64(base64) {
  if (!isBase64(base64)) {
    throw new TypeError('Value is not valid base64');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
