import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as docCtrl from '../controllers/document.controller.js';
import * as revisionCtrl from '../controllers/revision.controller.js';
import * as memberCtrl from '../controllers/member.controller.js';

export const documentRouter = Router();

documentRouter.use(authenticate);

documentRouter.get('/', docCtrl.listDocuments);
documentRouter.post('/', docCtrl.createDocument);
documentRouter.get('/:id', docCtrl.getDocument);
documentRouter.patch('/:id', docCtrl.updateDocument);
documentRouter.delete('/:id', docCtrl.deleteDocument);

// Document *content* has no REST write endpoint: it is CRDT state that changes
// only through CRDT operations — the WebSocket sync protocol, or a restore
// executed by the collaboration hub — so nobody can overwrite anyone with a
// whole-document write.
documentRouter.post('/:id/ws-ticket', docCtrl.issueWsTicket);

// Revision history (Phase 9). Authorisation per action is in revision.service.
documentRouter.get('/:id/revisions', revisionCtrl.listRevisions);
documentRouter.post('/:id/revisions', revisionCtrl.createRevision);
documentRouter.get('/:id/revisions/:revisionId', revisionCtrl.getRevision);
documentRouter.post('/:id/revisions/:revisionId/restore', revisionCtrl.restoreRevision);

// Members (Phase 10). Authorisation per action is in member.service.
documentRouter.get('/:id/members', memberCtrl.listMembers);
documentRouter.post('/:id/members', memberCtrl.addMember);
documentRouter.patch('/:id/members/:userId', memberCtrl.updateMember);
documentRouter.delete('/:id/members/:userId', memberCtrl.removeMember);
