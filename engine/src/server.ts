import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import type pg from 'pg';
import { registerRoutes } from './api/routes.js';
import { ApiError } from './dataset.js';
import { LoadError, ParseError } from './ingest/index.js';
import { registerShowcase } from './showcase.js';

export async function createServer(pool: pg.Pool, repoRoot?: string) {
  const app = Fastify({ logger: true });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        details: error.details,
      });
    }
    if (error instanceof ParseError) {
      return reply.code(400).send({ error: 'parse_error', violations: error.violations });
    }
    if (error instanceof LoadError) {
      return reply.code(422).send({ error: 'load_error', message: error.message });
    }
    req.log.error(error);
    return reply.send(error);
  });
  registerRoutes(app, pool, repoRoot);
  app.get('/health', async () => ({ status: 'ok' }));
  if (repoRoot) {
    try {
      await registerShowcase(app, repoRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      app.log.warn('showcase build not found; API-only development server started');
    }
  }
  return app;
}
