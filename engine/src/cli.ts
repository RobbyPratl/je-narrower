import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './db/client.js';
import { migrate } from './db/migrate.js';
import { createServer } from './server.js';
import { createBusiness, getBusiness } from './business.js';
import { getCurrentPopulation, requireCurrentPopulation } from './dataset.js';
import { runIngest } from './ingest/index.js';
import { createJob, getJob } from './jobs.js';
import { executePipelineRun, type RunFrom } from './pipeline/run.js';
import { buildPopulationStamp, investigateEntry, listFlaggedEntries } from './investigate/entry.js';
import { mockFindings } from './investigate/provider.js';
import { runGrouping } from './group/build.js';
import { recordGroupDecision } from './decisions/record.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pool = createPool();

const cmd = process.argv[2];

async function main() {
  if (cmd === 'migrate') {
    await migrate(pool);
    return;
  }

  if (cmd === 'seed-demo') {
    await seedDemo();
    return;
  }

  if (cmd === 'serve' || cmd === 'serve-replit') {
    if (cmd === 'serve-replit') await migrate(pool);
    const app = await createServer(pool, repoRoot);
    const port = Number(process.env.PORT ?? 4000);
    await app.listen({ port, host: '0.0.0.0' });
    if (cmd === 'serve-replit') {
      console.log('server ready; preparing demo population in the background');
      void seedDemo().catch((err) => console.error('background demo seed failed', err));
    }
    return;
  }

  console.error('usage: cli.ts migrate | seed-demo | serve | serve-replit');
  process.exit(1);
}

async function seedDemo() {
  const businessId = process.env.DEMO_BUSINESS_ID ?? 'meridian';
  if (!await getBusiness(pool, businessId)) {
    await createBusiness(pool, { businessId, name: 'Meridian Trading' });
  }

  let context = await getCurrentPopulation(pool, businessId);
  if (!context) {
    await runIngest(pool, {
      businessId,
      datasetId: process.env.DEMO_DATASET_ID ?? 'meridian-demo',
      glFiles: ['data/exports/gl_p1.csv', 'data/exports/gl_p2.csv'],
      tbFiles: ['data/exports/tb_p1.csv', 'data/exports/tb_p2.csv'],
      repoRoot,
    });
    context = await requireCurrentPopulation(pool, businessId);
  }
  const limit = Number(process.env.DEMO_INVESTIGATE_LIMIT ?? 25);
  const demoInvestigation = { generate: mockFindings, model: 'demo:seeded' };

  if (!context.pipeline.grouped) {
    const from: RunFrom = !context.pipeline.projected
      ? 'project'
      : !context.pipeline.scored
        ? 'score'
        : !context.pipeline.investigated
          ? 'investigate'
          : 'group';
    const jobId = await createJob(pool, context, 'demo-seed', 4, from);
    await executePipelineRun(pool, context, jobId, {
      from,
      investigateLimit: limit,
      investigation: demoInvestigation,
    });
    const job = await getJob(pool, context, jobId);
    if (job?.status !== 'done') throw new Error(job?.error ?? 'demo seed failed');
    context = await requireCurrentPopulation(pool, businessId);
  }

  const { rows: groupRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM review_groups WHERE dataset_id = $1 AND kind = 'group'`,
    [context.datasetId],
  );
  if (Number(groupRows[0]?.count ?? 0) === 0) {
    await runGrouping(pool, context);
  }

  const population = await buildPopulationStamp(pool, context);
  const missingCases = await listFlaggedEntries(pool, context, limit);
  for (const entryId of missingCases) {
    await investigateEntry(pool, context, entryId, population, demoInvestigation);
  }

  await seedReviewHistory(context);
  console.log(`demo population ready for ${businessId}`);
}

async function seedReviewHistory(context: Awaited<ReturnType<typeof requireCurrentPopulation>>) {
  const { rows: decisionRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM decisions WHERE dataset_id = $1',
    [context.datasetId],
  );
  if (Number(decisionRows[0]?.count ?? 0) > 0) return;

  const { rows } = await pool.query<{ group_id: string; entry_ids: string[] }>(
    `SELECT rg.group_id, array_agg(gm.entry_id ORDER BY gm.entry_id) AS entry_ids
     FROM review_groups rg
     JOIN group_members gm ON gm.dataset_id = rg.dataset_id AND gm.group_id = rg.group_id
     WHERE rg.dataset_id = $1 AND rg.kind = 'group'
     GROUP BY rg.dataset_id, rg.group_id
     ORDER BY COUNT(gm.entry_id) DESC
     LIMIT 1`,
    [context.datasetId],
  );
  const example = rows[0];
  if (!example) return;

  await recordGroupDecision(pool, context, example.group_id, {
    conclusion: 'appropriate-recurring',
    basis: 'Demo conclusion: recurring account combination, common preparer, and consistent entry structure reviewed.',
    recordedBy: 'demo.reviewer',
    entryIds: example.entry_ids,
  });
  await recordGroupDecision(pool, context, example.group_id, {
    conclusion: 'requires-procedures',
    basis: 'Demo revision: retain the group for supporting-document inspection before final disposition.',
    recordedBy: 'demo.reviewer',
    entryIds: example.entry_ids,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    if (cmd !== 'serve' && cmd !== 'serve-replit') void pool.end();
  });
