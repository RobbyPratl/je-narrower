import type pg from 'pg';
import { updatePipeline } from '../dataset.js';
import type { PopulationContext } from '../dataset.js';
import { createJob, updateJobProgress, completeJob, failJob } from '../jobs.js';
import {
  buildPopulationStamp,
  investigateEntry,
  listFlaggedEntries,
} from './entry.js';

export async function runInvestigateBatch(
  pool: pg.Pool,
  context: PopulationContext,
  limit?: number | null,
  force = false,
): Promise<{ jobId: string; total: number }> {
  const entryIds = await listFlaggedEntries(pool, context, limit, force);
  const jobId = await createJob(pool, context, 'investigate', entryIds.length);

  void processBatch(pool, context, jobId, entryIds);

  return { jobId, total: entryIds.length };
}

async function processBatch(pool: pg.Pool, context: PopulationContext, jobId: string, entryIds: string[]) {
  const population = await buildPopulationStamp(pool, context);
  const tally = { passed: 0, retried: 0, escalated: 0 };

  try {
    for (let i = 0; i < entryIds.length; i++) {
      const entryId = entryIds[i]!;
      await updateJobProgress(pool, context, jobId, { done: i, total: entryIds.length, current: entryId });

      const caseFile = await investigateEntry(pool, context, entryId, population);
      if (caseFile.verifier.status === 'passed') tally.passed++;
      else if (caseFile.verifier.status === 'retried') tally.retried++;
      else tally.escalated++;
    }

    await updateJobProgress(pool, context, jobId, { done: entryIds.length, total: entryIds.length });
    await completeJob(pool, context, jobId, tally);
    await updatePipeline(pool, context, { investigated: true, grouped: false });
  } catch (err) {
    await failJob(pool, context, jobId, err instanceof Error ? err.message : String(err));
  }
}
