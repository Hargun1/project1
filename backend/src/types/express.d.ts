/**
 * Express request augmentation.
 *
 * `requestId` (rather than the `id` that pino-http declares on IncomingMessage)
 * avoids clashing with that library's own type declaration.
 */
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export {};
