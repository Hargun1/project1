import * as docService from '../services/document.service.js';
import { createDocumentSchema, updateDocumentSchema, listDocumentsSchema, saveContentSchema } from '../utils/document.schemas.js';

export async function createDocument(req, res) {
  const data = createDocumentSchema.parse(req.body);
  const document = await docService.createDocument(req.user.id, data);
  res.status(201).json({ document });
}

export async function getDocument(req, res) {
  const document = await docService.getDocument(req.user.id, req.params.id);
  res.status(200).json({ document });
}

export async function listDocuments(req, res) {
  const query = listDocumentsSchema.parse(req.query);
  const result = await docService.listDocuments(req.user.id, query);
  res.status(200).json(result);
}

export async function updateDocument(req, res) {
  const data = updateDocumentSchema.parse(req.body);
  const document = await docService.updateDocument(req.user.id, req.params.id, data);
  res.status(200).json({ document });
}

export async function deleteDocument(req, res) {
  await docService.deleteDocument(req.user.id, req.params.id);
  res.status(204).end();
}

/** Phase 4 — save plain-text content. */
export async function saveContent(req, res) {
  const { content } = saveContentSchema.parse(req.body);
  const document = await docService.saveContent(req.user.id, req.params.id, content);
  res.status(200).json({ document });
}
