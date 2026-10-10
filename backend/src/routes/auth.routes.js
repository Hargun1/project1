import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as authCtrl from '../controllers/auth.controller.js';

/**
 * Auth routes (§10, §15).
 *
 * `express@5` propagates errors thrown in async handlers automatically, so
 * we can use `async (req, res) => { ... }` without a try/catch wrapper.
 *
 * A factory, so the app can hand in the protections it configured (Phase 11):
 *
 * @param {object} guards
 * @param {Function} guards.trustedOrigin  CSRF check — these routes use the refresh cookie
 * @param {Function} guards.perIp          brute-force limit per client IP
 * @param {Function} guards.perEmail       login attempts per account
 */
export function createAuthRouter({ trustedOrigin, perIp, perEmail }) {
  const router = Router();
  router.use(trustedOrigin);

  router.post('/register', perIp, authCtrl.register);
  router.post('/login', perIp, perEmail, authCtrl.login);
  router.post('/refresh', perIp, authCtrl.refresh);
  router.post('/logout', perIp, authCtrl.logoutHandler);
  router.get('/me', authenticate, authCtrl.getMe);
  return router;
}
