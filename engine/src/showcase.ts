import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './dataset.js';

interface ManifestEntry {
  path: string;
  language: string;
  size: number;
}

const maxDisplayBytes = 256 * 1024;

export async function registerShowcase(app: FastifyInstance, repoRoot: string): Promise<void> {
  const root = path.resolve(repoRoot);
  const webDist = path.join(root, 'web/dist');
  const shellDist = path.join(root, 'showcase/dist');
  const manifest = JSON.parse(
    await readFile(path.join(root, 'showcase-manifest.json'), 'utf8'),
  ) as ManifestEntry[];
  const approved = new Map(manifest.map((entry) => [entry.path, entry]));

  app.get('/api/showcase/tree', async () => ({ root: 'je-narrower', files: manifest }));
  app.get('/api/showcase/file', async (request) => {
    const requested = (request.query as { path?: unknown }).path;
    if (typeof requested !== 'string') {
      throw new ApiError(400, 'invalid_request', 'path required');
    }
    const entry = approved.get(validatePath(requested));
    if (!entry) throw new ApiError(404, 'not_found', 'file not approved');

    const absolute = path.join(root, entry.path);
    const resolved = await realpath(absolute).catch(() => null);
    if (!resolved || !isInside(root, resolved)) {
      throw new ApiError(404, 'not_found', 'file not approved');
    }
    const info = await stat(resolved);
    if (!info.isFile() || info.size > maxDisplayBytes) {
      throw new ApiError(413, 'file_too_large', 'file cannot be displayed');
    }
    return { ...entry, content: await readFile(resolved, 'utf8') };
  });

  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/demo-app/',
    index: false,
    wildcard: false,
  });
  await app.register(fastifyStatic, {
    root: shellDist,
    prefix: '/showcase-assets/',
    index: false,
    wildcard: false,
    decorateReply: false,
  });

  app.get('/demo-app', async (_request, reply) => reply.redirect('/demo-app/'));
  app.get('/demo-app/*', async (request, reply) => {
    const suffix = (request.params as { '*': string })['*'];
    if (suffix && path.posix.extname(suffix)) return reply.code(404).send({ error: 'not_found' });
    return reply.sendFile('index.html', webDist);
  });
  for (const route of ['/', '/demo', '/source']) {
    app.get(route, async (_request, reply) => reply.sendFile('index.html', shellDist));
  }
}

function validatePath(requested: string): string {
  if (
    requested.includes('\0') ||
    requested.includes('\\') ||
    path.posix.isAbsolute(requested) ||
    requested.split('/').includes('..') ||
    path.posix.normalize(requested) !== requested
  ) {
    throw new ApiError(400, 'invalid_path', 'invalid source path');
  }
  return requested;
}

function isInside(root: string, candidate: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}
