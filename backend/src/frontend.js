import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';

const defaultDirectory = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));

/** Serve the built SPA on the API origin when no separate Nginx is deployed. */
export function attachFrontend(app, directory = defaultDirectory) {
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          workerSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(express.static(directory, { index: false }));
  app.get('/{*page}', (req, res, next) => {
    // Keep missing API endpoints, upgrades and assets as errors, never HTML.
    if (/^\/(api|ws|healthz|readyz|assets)(\/|$)/.test(req.path) || path.extname(req.path)) {
      return next();
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(path.join(directory, 'index.html'));
  });
}
