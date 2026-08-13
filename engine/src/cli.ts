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

  if (cmd === 'serve') {
    const app = await createServer(pool, repoRoot);
    const port = Number(process.env.PORT ?? 4000);
    await app.listen({ port, host: '0.0.0.0' });
    return;
  }

  console.error('usage: cli.ts migrate | seed-demo | serve');
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
  if (context.pipeline.grouped) {
    console.log(`demo population already ready for ${businessId}`);
    return;
  }

  const from: RunFrom = !context.pipeline.projected
    ? 'project'
    : !context.pipeline.scored
      ? 'score'
      : !context.pipeline.investigated
        ? 'investigate'
        : 'group';
  const jobId = await createJob(pool, context, 'demo-seed', 4, from);
  const limit = Number(process.env.DEMO_INVESTIGATE_LIMIT ?? 25);
  await executePipelineRun(pool, context, jobId, { from, investigateLimit: limit });
  const job = await getJob(pool, context, jobId);
  if (job?.status !== 'done') throw new Error(job?.error ?? 'demo seed failed');
  console.log(`demo population ready for ${businessId}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    if (cmd !== 'serve') void pool.end();
  });
