import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, withTransaction } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { requireCurrentPopulation } from '../src/dataset.js';
import { runDiff, runProjection } from '../src/graph/run.js';
import { runIngest } from '../src/ingest/index.js';
import { buildPopulationStamp, investigateEntry } from '../src/investigate/entry.js';
import { runScoring } from '../src/scoring/run.js';

const live = process.env.LIVE_SMOKE === '1' ? describe : describe.skip;
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pool = createPool();
const businessId = 'live-smoke';
const datasetId = 'live-smoke-dataset';

live('live Ollama investigation smoke test', () => {
  beforeAll(async () => {
    await migrate(pool);
    await pool.query('DELETE FROM businesses WHERE business_id = $1', [businessId]);
    await pool.query(
      `INSERT INTO businesses (business_id, name, source_company)
       VALUES ($1, 'Live Smoke', 'Meridian Trading Co.')`,
      [businessId],
    );
    await runIngest(pool, {
      businessId,
      datasetId,
      glFiles: ['data/exports/gl_p1.csv', 'data/exports/gl_p2.csv'],
      tbFiles: ['data/exports/tb_p1.csv', 'data/exports/tb_p2.csv'],
      repoRoot,
    });
    await withTransaction(pool, async (db) => {
      await runProjection(db, datasetId);
      await runDiff(db, datasetId);
      await runScoring(db, datasetId);
    });
  }, 120_000);

  afterAll(async () => {
    await pool.query('DELETE FROM businesses WHERE business_id = $1', [businessId]);
    await pool.end();
  });

  it('runs three non-template cases and reports latency and citation quality', async () => {
    const context = await requireCurrentPopulation(pool, businessId);
    const { rows } = await pool.query<{ entry_id: string }>(
      `SELECT s.entry_id
       FROM scores s
       WHERE s.dataset_id = $1
       GROUP BY s.entry_id
       HAVING BOOL_OR(s.rule NOT IN ('round_amount', 'off_hours', 'date_mismatch'))
       ORDER BY MAX(s.score) DESC, s.entry_id
       LIMIT 3`,
      [datasetId],
    );
    expect(rows).toHaveLength(3);

    const population = await buildPopulationStamp(pool, context);
    const results = [];
    for (const { entry_id: entryId } of rows) {
      const started = performance.now();
      const caseFile = await investigateEntry(pool, context, entryId, population);
      results.push({
        entryId,
        milliseconds: Math.round(performance.now() - started),
        model: caseFile.model,
        verifier: caseFile.verifier.status,
        verifierFailures: caseFile.verifier.failures,
        findings: caseFile.agent.findings,
      });
    }

    console.log(JSON.stringify({ liveSmoke: results }, null, 2));
    expect(results.every((result) => result.model.startsWith('ollama:'))).toBe(true);
    expect(results.every((result) => result.findings.length > 0)).toBe(true);
  }, 300_000);
});
