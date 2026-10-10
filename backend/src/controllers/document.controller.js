import * as docService from '../services/document.service.js';
import {
  createDocumentSchema,
  documentIdSchema,
  listDocumentsSchema,
  updateDocumentSchema,
} from '../utils/document.schemas.js';
import { issueTicket } from '../websocket/ticket.service.js';
import { AppError } from '../utils/app-error.js';

/**
 * `:id` is validated before it reaches Prisma: a non-UUID string would otherwise
 * surface as a PostgreSQL cast error and a 500. From the client's point of view
 * a malformed id names no document, so it is a 404.
 */
function documentIdFrom(req) {
  const result = documentIdSchema.safeParse(req.params.id);
  if (!result.success) {
    throw AppError.notFound('Document not found');
  }
  return result.data;
}

export async function createDocument(req, res) {
  const data = createDocumentSchema.parse(req.body);
  const document = await docService.createDocument(req.user.id, data);
  res.status(201).json({ document });
}

export async function getDocument(req, res) {
  const document = await docService.getDocument(req.user.id, documentIdFrom(req));
  res.status(200).json({ document });
}

export async function listDocuments(req, res) {
  const query = listDocumentsSchema.parse(req.query);
  const result = await docService.listDocuments(req.user.id, query);
  res.status(200).json(result);
}

export async function updateDocument(req, res) {
  const data = updateDocumentSchema.parse(req.body);
  const document = await docService.updateDocument(req.user.id, documentIdFrom(req), data);
  res.status(200).json({ document });
}

export async function deleteDocument(req, res) {
  await docService.deleteDocument(req.app.locals.hub, req.user.id, documentIdFrom(req));
  res.status(204).end();
}

/**
 * Issue a single-use WebSocket connection ticket (§11).
 *
 * The ticket is scoped to this (user, document) pair, stored in Redis with a
 * short TTL, and consumed on the first WebSocket handshake that presents it.
 * This avoids putting the raw JWT in the WebSocket URL.
 */
export async function issueWsTicket(req, res) {
  const documentId = documentIdFrom(req);
  // Throws 404/403 before a ticket is ever minted for a document the user cannot open.
  await docService.getDocument(req.user.id, documentId);

  const ticket = await issueTicket(req.user.id, documentId);
  res.status(200).json({ ticket });
}
