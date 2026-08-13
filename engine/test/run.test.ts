import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { getJob } from '../src/jobs.js';
import { runIngest } from '../src/ingest/index.js';
import { executePipelineRun } from '../src/pipeline/run.js';
import { createJob } from '../src/jobs.js';
import { requireCurrentPopulation } from '../src/dataset.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pool = createPool();

describe('pipeline run', () => {
  beforeAll(async () => {
    process.env.AGENT_PROVIDER = 'mock';
    await migrate(pool);
    await pool.query(
      `INSERT INTO businesses (business_id, name, source_company)
       VALUES ('test-run', 'Run Test', 'Meridian Trading Co.')
       ON CONFLICT (business_id) DO NOTHING`,
    );
    await runIngest(pool, {
      businessId: 'test-run',
      datasetId: 'business-run-test',
      glFiles: ['data/exports/gl_p1.csv', 'data/exports/gl_p2.csv'],
      tbFiles: ['data/exports/tb_p1.csv', 'data/exports/tb_p2.csv'],
      repoRoot,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('chains project through group in one job', async () => {
    const context = await requireCurrentPopulation(pool, 'test-run');
    const jobId = await createJob(pool, context, 'run', 4, 'project');
    await executePipelineRun(pool, context, jobId, {
      from: 'project',
      investigateLimit: 5,
    });

    const job = await getJob(pool, context, jobId);
    expect(job?.status).toBe('done');
    expect(job?.kind).toBe('run');
    expect(job?.result).toMatchObject({
      project: expect.objectContaining({ pairs: expect.any(Object) }),
      score: expect.objectContaining({ flagged: expect.any(Number) }),
      investigate: expect.objectContaining({ passed: expect.any(Number), total: expect.any(Number) }),
      group: expect.objectContaining({ totalFlagged: expect.any(Number) }),
    });
    const investigate = (job?.result as { investigate?: { total: number } }).investigate;
    expect(investigate!.total).toBeGreaterThan(0);
    expect(investigate!.total).toBeLessThanOrEqual(5);
  }, 120_000);
});
