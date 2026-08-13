import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

const emptyPool = {
  async query() {
    return { rows: [], rowCount: 0 };
  },
} as unknown as pg.Pool;

describe('API boundary', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    app = await createServer(emptyPool);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns an empty business list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/businesses' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ businesses: [] });
  });

  it('maps Zod request failures to the standard API error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/businesses/example/datasets/ingest',
      payload: { datasetId: 'example' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_request',
      message: 'datasetId and gl.p1/p2, tb.p1/p2 required (or multipart upload)',
    });
  });

  it('returns business_not_found when the business key is unknown', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/businesses/missing/profile' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'business_not_found' });
  });
});
