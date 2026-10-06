import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as docCtrl from '../controllers/document.controller.js';

export const documentRouter = Router();

documentRouter.use(authenticate);

documentRouter.get('/', docCtrl.listDocuments);
documentRouter.post('/', docCtrl.createDocument);
documentRouter.get('/:id', docCtrl.getDocument);
documentRouter.patch('/:id', docCtrl.updateDocument);
documentRouter.put('/:id/content', docCtrl.saveContent);
documentRouter.delete('/:id', docCtrl.deleteDocument);
