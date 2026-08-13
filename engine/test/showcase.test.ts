import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const emptyPool = {
  async query() {
    return { rows: [], rowCount: 0 };
  },
} as unknown as pg.Pool;

describe('Replit showcase boundary', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    app = await createServer(emptyPool, repoRoot);
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health, shell routes, and direct-route refreshes', async () => {
    const [health, root, demo, source] = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/' }),
      app.inject({ method: 'GET', url: '/demo' }),
      app.inject({ method: 'GET', url: '/source' }),
    ]);
    expect(health.json()).toEqual({ status: 'ok' });
    for (const response of [root, demo, source]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<title>JE Narrower</title>');
      expect(response.body).toContain('/showcase-assets/assets/');
    }
    const shellAssetPath = root.body.match(/src="([^"]+\.js)"/)?.[1];
    expect(shellAssetPath).toBeTruthy();
    const shellAsset = await app.inject({ method: 'GET', url: shellAssetPath! });
    expect(shellAsset.statusCode).toBe(200);
    expect(shellAsset.body).toContain('/demo-app/');
    expect(shellAsset.body).toContain('/api/showcase/tree');
  });

  it('loads the original frontend and its assets below /demo-app/', async () => {
    const page = await app.inject({ method: 'GET', url: '/demo-app/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('/demo-app/assets/');
    const assetPath = page.body.match(/src="([^"]+\.js)"/)?.[1];
    expect(assetPath).toBeTruthy();
    const asset = await app.inject({ method: 'GET', url: assetPath! });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('/api/businesses/');

    const refresh = await app.inject({ method: 'GET', url: '/demo-app/review/item' });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.body).toContain('/demo-app/assets/');
  });

  it('returns only the generated allowlist and approved source content', async () => {
    const tree = await app.inject({ method: 'GET', url: '/api/showcase/tree' });
    expect(tree.statusCode).toBe(200);
    const files = tree.json().files as Array<{ path: string }>;
    expect(files.some((file) => file.path === 'README.md')).toBe(true);
    expect(files.some((file) => /(^|\/)(data|node_modules|dist|\.git|\.cache)(\/|$)/.test(file.path))).toBe(false);
    expect(files.some((file) => file.path === '.env' || file.path.startsWith('.env.'))).toBe(false);
    expect(files.some((file) => file.path === 'showcase-manifest.json')).toBe(false);

    const readme = await app.inject({ method: 'GET', url: '/api/showcase/file?path=README.md' });
    expect(readme.statusCode).toBe(200);
    expect(readme.json()).toMatchObject({ path: 'README.md', language: 'markdown' });
    expect(readme.json().content).toContain('# JE Narrower');
  });

  it.each([
    '../package.json',
    '/etc/passwd',
    '.env',
    'data/exports/gl_p1.csv',
    'showcase-manifest.json',
    'not-in-manifest.txt',
    'engine//src/server.ts',
    'engine\\src\\server.ts',
  ])('rejects unapproved source path %s', async (requested) => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/showcase/file?path=${encodeURIComponent(requested)}`,
    });
    expect([400, 404]).toContain(response.statusCode);
  });
});
