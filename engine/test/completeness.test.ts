import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { runIngest } from '../src/ingest/index.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pool = createPool();

beforeAll(async () => {
  await migrate(pool);
  await pool.query(
    `INSERT INTO businesses (business_id, name, source_company)
     VALUES ('test-completeness', 'Completeness Test', 'Meridian Trading Co.')
     ON CONFLICT (business_id) DO NOTHING`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe('runIngest', () => {
  it('loads full fixtures as reconciled', async () => {
    const result = await runIngest(pool, {
      businessId: 'test-completeness',
      datasetId: 'test-full-business',
      glFiles: ['data/exports/gl_p1.csv', 'data/exports/gl_p2.csv'],
      tbFiles: ['data/exports/tb_p1.csv', 'data/exports/tb_p2.csv'],
      repoRoot,
    });

    expect(result.status).toBe('reconciled');
    expect(result.summary.entries.P1).toBe(947);
    expect(result.summary.entries.P2).toBe(1025);
    expect(result.summary.accounts).toBe(34);
    expect(result.summary.checksFailed).toBe(0);
  });

  it('loads truncated P2 as unreconciled', async () => {
    const result = await runIngest(pool, {
      businessId: 'test-completeness',
      datasetId: 'test-truncated-business',
      glFiles: ['data/exports/gl_p1.csv', 'data/exports/gl_p2_truncated.csv'],
      tbFiles: ['data/exports/tb_p1.csv', 'data/exports/tb_p2.csv'],
      repoRoot,
    });

    expect(result.status).toBe('unreconciled');
    expect(result.reconciled).toBe(false);
    const tieout = result.report.find((r) => r.check === 'gl_tb_tieout');
    expect(tieout?.ok).toBe(false);
    expect(result.grossDeltaCents).toBeGreaterThan(0);
  });
});
