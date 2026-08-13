import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/client.js';
import { withTransaction } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { requireCurrentPopulation, updatePipeline } from '../src/dataset.js';
import { runDiff, runProjection } from '../src/graph/run.js';
import { runGrouping } from '../src/group/build.js';
import { queryQueue } from '../src/group/queue.js';
import { recordEntryDecision, recordGroupDecision, getDecision, reopenDecision } from '../src/decisions/record.js';
import { runIngest } from '../src/ingest/index.js';
import { countFlagged, runScoring } from '../src/scoring/run.js';
import { buildPopulationStamp, investigateEntry, listFlaggedEntries } from '../src/investigate/entry.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pool = createPool();

beforeAll(async () => {
  await migrate(pool);
  await pool.query(
    `INSERT INTO businesses (business_id, name, source_company)
     VALUES ('test-pipeline', 'Pipeline Test', 'Meridian Trading Co.')
     ON CONFLICT (business_id) DO NOTHING`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe('pipeline', () => {
  it('projects and scores any ingested dataset', async () => {
    await runIngest(pool, {
      businessId: 'test-pipeline',
      datasetId: 'business-acme-2024',
      glFiles: ['data/exports/gl_p1.csv', 'data/exports/gl_p2.csv'],
      tbFiles: ['data/exports/tb_p1.csv', 'data/exports/tb_p2.csv'],
      repoRoot,
    });
    const context = await requireCurrentPopulation(pool, 'test-pipeline');

    const graph = await withTransaction(pool, async (db) => {
      const projection = await runProjection(db, context.datasetId);
      const diff = await runDiff(db, context.datasetId);
      return { projection, diff };
    });

    expect(graph.projection.pairs.P1).toBeGreaterThan(0);
    expect(graph.projection.pairs.P2).toBeGreaterThan(0);
    expect(Object.values(graph.diff).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

    const scoring = await withTransaction(pool, async (db) => runScoring(db, context.datasetId));
    expect(scoring.scored).toBeGreaterThan(0);

    const flagged = await countFlagged(pool, context.datasetId);
    expect(flagged).toBeGreaterThan(0);

    process.env.AGENT_PROVIDER = 'mock';
    const topFlagged = await listFlaggedEntries(pool, context, 10);
    const population = await buildPopulationStamp(pool, context);
    let sampleCase;
    for (const entryId of topFlagged) {
      sampleCase = await investigateEntry(pool, context, entryId, population);
    }
    await updatePipeline(pool, context, { investigated: true });

    expect(sampleCase!.entryId).toBeTruthy();
    expect(sampleCase!.engine.rules.length).toBeGreaterThan(0);
    if (sampleCase!.verifier.status !== 'escalated') {
      expect(sampleCase!.agent.findings.length).toBeGreaterThan(0);
    }
    expect(['passed', 'retried', 'escalated']).toContain(sampleCase!.verifier.status);

    const grouped = await runGrouping(pool, context);
    expect(grouped.totalFlagged).toBe(flagged);
    expect(grouped.groups + grouped.deviations + grouped.individuals).toBeGreaterThan(0);

    const queue = await queryQueue(pool, context, {});
    expect(queue.items.length).toBeGreaterThan(0);
    expect(queue.summary.totalFlagged).toBe(flagged);

    const target =
      queue.items.find((i) => i.kind === 'individual') ??
      queue.items.find((i) => i.kind === 'deviation') ??
      queue.items[0]!;
    const entryId = target.entryIds[0]!;

    if (target.kind === 'group' && target.entryCount > 1) {
      const result = await recordGroupDecision(pool, context, target.groupId, {
        conclusion: 'appropriate-recurring',
        basis: 'Monthly accrual pattern confirmed',
        entryIds: target.entryIds,
        excludedDeviations: [],
      });
      expect(result.decisionId).toMatch(/^dec-/);
      expect(result.entriesAffected).toBe(target.entryCount);
    } else {
      const result = await recordEntryDecision(pool, context, entryId, {
        conclusion: 'appropriate-other',
        basis: 'Reviewed supporting detail',
      });
      expect(result.decisionId).toMatch(/^dec-/);

      const stored = await getDecision(pool, context, result.decisionId);
      expect(stored?.conclusion).toBe('appropriate-other');

      const reopened = await reopenDecision(pool, context, result.decisionId, 'Need second look');
      expect(reopened.supersedes).toBe(result.decisionId);
    }
  }, 120_000);
});
