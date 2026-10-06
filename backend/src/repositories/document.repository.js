import { prisma } from '../database/prisma.js';

export async function createDocument({ ownerId, name, language }) {
  // Use a transaction to create the document and add the owner as a member
  return prisma.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: {
        ownerId,
        name,
        language,
      },
    });

    await tx.documentMember.create({
      data: {
        documentId: doc.id,
        userId: ownerId,
        role: 'OWNER',
      },
    });

    return doc;
  });
}

export async function getDocumentById(id) {
  return prisma.document.findUnique({
    where: { id },
  });
}

export async function getDocumentWithRole(id, userId) {
  const doc = await prisma.document.findFirst({
    where: { id, deletedAt: null },
  });
  if (!doc) return null;

  const member = await prisma.documentMember.findUnique({
    where: { documentId_userId: { documentId: id, userId } },
  });

  return { document: doc, role: member?.role || null };
}

export async function listUserDocuments(userId, { skip, take, search, language }) {
  const where = {
    deletedAt: null,
    members: {
      some: {
        userId,
      },
    },
  };

  if (search) {
    where.name = { contains: search, mode: 'insensitive' };
  }
  if (language) {
    where.language = language;
  }

  const [documents, total] = await Promise.all([
    prisma.document.findMany({
      where,
      skip,
      take,
      orderBy: { updatedAt: 'desc' },
      include: {
        members: {
          where: { userId },
          select: { role: true },
        },
        owner: {
          select: { id: true, name: true, email: true },
        }
      },
    }),
    prisma.document.count({ where }),
  ]);

  return { documents, total };
}

export async function updateDocument(id, data) {
  return prisma.document.update({
    where: { id },
    data,
  });
}

export async function softDeleteDocument(id) {
  return prisma.document.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

/**
 * Phase 4 — save plain-text document content.
 * @param {string} id
 * @param {string} content
 */
export async function updateDocumentContent(id, content) {
  return prisma.document.update({
    where: { id },
    data: { content },
  });
}
