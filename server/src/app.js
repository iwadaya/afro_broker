// server/src/app.js — Express composition root (trimmed port of Universe app.js).
import cors from 'cors';
import compression from 'compression';
import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import path from 'path';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { pool, getPoolStats } from './db/pool.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { authenticate, requireAuth, csrfProtection } from './middleware/requestContext.js';
import { attachRequestId } from './middleware/requestId.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import authRouter from './routes/auth.js';
import configRouter from './routes/config.js';
import { registerApiRoutes } from './routes/registerApiRoutes.js';

function createCorsOptions() {
  if (env.corsOrigin === '*') return { origin: true, credentials: !env.isProduction, exposedHeaders: ['X-Request-Id'], maxAge: 86400 };
  const allowed = new Set(env.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean));
  allowed.add(`http://localhost:${env.port}`); allowed.add(`http://127.0.0.1:${env.port}`);
  return {
    origin(origin, cb) { if (!origin || allowed.has(origin)) return cb(null, true); return cb(new Error(`Origin not allowed by CORS: ${origin}`)); },
    credentials: true, exposedHeaders: ['X-Request-Id'], maxAge: 86400,
  };
}

export function rateLimitBypassed() { return process.env.ALLOW_DEMO_AUTH === 'true' || process.env.NODE_ENV === 'test'; }

function registerHealthRoutes(app) {
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: env.nodeEnv, requestId: res.locals.requestId || null });
  });
  app.get('/api/health/deep', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const started = Date.now(); await pool.query('SELECT 1');
      res.json({ status: 'ok', db: { ok: true, pingMs: Date.now() - started, pool: getPoolStats() }, brokingEnabled: env.brokingEnabled });
    } catch (error) { res.status(503).json({ status: 'error', message: error.message }); }
  });
}

function registerClient(app) {
  const candidates = [env.clientDistDir, path.resolve(process.cwd(), 'client/dist'), path.resolve(process.cwd(), '../client/dist')];
  const clientDir = candidates.find((p) => fs.existsSync(p) && fs.existsSync(path.join(p, 'index.html')));
  if (!clientDir) { logger.warn('[static] client/dist not found — SPA will not be served'); return; }
  const indexHtml = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8');
  const serveIndex = (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.type('html').send(indexHtml); };
  app.get(['/', '/index.html'], serveIndex);
  app.use(express.static(clientDir, { index: false, maxAge: '1y', etag: false, lastModified: false,
    setHeaders(res, filePath) { if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
  app.get(/^(?!\/api\/)(?!\/assets\/).*/, serveIndex);
  logger.info('[static] serving client', { clientDir });
}

export async function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.set('etag', 'weak');
  app.disable('x-powered-by');
  app.use(attachRequestId);
  registerHealthRoutes(app);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"], 'base-uri': ["'self'"], 'object-src': ["'none'"], 'frame-ancestors': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression({ threshold: 1024 }));
  app.use(cors(createCorsOptions()));
  app.use('/api', rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip)}`, skip: () => rateLimitBypassed() }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false, skip: (req) => req.method !== 'POST' || rateLimitBypassed(),
    keyGenerator: (req) => `login:${ipKeyGenerator(req.ip)}:${String(req.body?.username || '').trim().toLowerCase()}` }));
  app.use('/api', authenticate);
  app.use('/api', csrfProtection);
  app.use('/api', configRouter);
  app.use('/api', authRouter);
  app.use('/api', requireAuth);
  await registerApiRoutes(app);
  registerClient(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
