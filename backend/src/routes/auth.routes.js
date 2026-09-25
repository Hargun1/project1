import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as authCtrl from '../controllers/auth.controller.js';

/**
 * Auth routes (§10, §15).
 *
 * `express@5` propagates errors thrown in async handlers automatically, so
 * we can use `async (req, res) => { ... }` without a try/catch wrapper.
 */
export const authRouter = Router();

authRouter.post('/register', authCtrl.register);
authRouter.post('/login', authCtrl.login);
authRouter.post('/refresh', authCtrl.refresh);
authRouter.post('/logout', authCtrl.logoutHandler);
authRouter.get('/me', authenticate, authCtrl.getMe);
