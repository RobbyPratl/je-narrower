import type pg from 'pg';
import { updatePipeline } from '../dataset.js';
import type { PopulationContext } from '../dataset.js';
import { withTransaction } from '../db/client.js';
import { runDiff, runProjection } from '../graph/run.js';
import { runGrouping } from '../group/build.js';
import { listFlaggedEntries, investigateEntry, buildPopulationStamp, type InvestigationOptions } from '../investigate/entry.js';
import { completeJob, createJob, failJob, updateJobProgress, updateJobStage } from '../jobs.js';
import { countFlagged, runScoring } from '../scoring/run.js';
import { config } from '../config.js';

export type RunFrom = 'project' | 'score' | 'investigate' | 'group';

const STAGE_ORDER: RunFrom[] = ['project', 'score', 'investigate', 'group'];

export interface RunOptions {
  from: RunFrom;
  investigateLimit?: number | null;
  investigation?: InvestigationOptions;
}

function stagesFrom(from: RunFrom): RunFrom[] {
  const start = STAGE_ORDER.indexOf(from);
  return STAGE_ORDER.slice(start);
}

export async function executePipelineRun(
  pool: pg.Pool,
  context: PopulationContext,
  jobId: string,
  opts: RunOptions,
): Promise<void> {
  const stages = stagesFrom(opts.from);
  const result: Record<string, unknown> = {};

  try {
    if (stages.includes('project')) {
      await updateJobStage(pool, context, jobId, 'project');
      await updateJobProgress(pool, context, jobId, { done: 0, total: 1 });

      const graph = await withTransaction(pool, async (db) => {
        const projection = await runProjection(db, context.datasetId);
        const diff = await runDiff(db, context.datasetId);
        return { pairs: projection.pairs, diff, skipped: projection.skipped };
      });

      await updatePipeline(pool, context, {
        projected: true,
        scored: false,
        investigated: false,
        grouped: false,
      });
      result.project = graph;
      await updateJobProgress(pool, context, jobId, { done: 1, total: 1 });
    }

    if (stages.includes('score')) {
      await updateJobStage(pool, context, jobId, 'score');
      await updateJobProgress(pool, context, jobId, { done: 0, total: 1 });

      const scoring = await withTransaction(pool, async (db) => runScoring(db, context.datasetId));
      const flagged = await countFlagged(pool, context.datasetId);
      await updatePipeline(pool, context, { scored: true, investigated: false, grouped: false });
      result.score = { scored: scoring.scored, flagged, byRule: scoring.byRule };
      await updateJobProgress(pool, context, jobId, { done: 1, total: 1 });
    }

    if (stages.includes('investigate')) {
      await updateJobStage(pool, context, jobId, 'investigate');
      const investigateLimit = opts.investigateLimit === undefined
        ? config.agent.initialBatchLimit
        : opts.investigateLimit;
      const entryIds = await listFlaggedEntries(pool, context, investigateLimit);
      const population = await buildPopulationStamp(pool, context);
      const tally = { passed: 0, retried: 0, escalated: 0 };

      for (let i = 0; i < entryIds.length; i++) {
        const entryId = entryIds[i]!;
        await updateJobProgress(pool, context, jobId, { done: i, total: entryIds.length, current: entryId });
        const caseFile = await investigateEntry(pool, context, entryId, population, opts.investigation);
        if (caseFile.verifier.status === 'passed') tally.passed++;
        else if (caseFile.verifier.status === 'retried') tally.retried++;
        else tally.escalated++;
      }

      await updateJobProgress(pool, context, jobId, { done: entryIds.length, total: entryIds.length });
      await updatePipeline(pool, context, { investigated: true, grouped: false });
      result.investigate = { ...tally, total: entryIds.length };
    }

    if (stages.includes('group')) {
      await updateJobStage(pool, context, jobId, 'group');
      await updateJobProgress(pool, context, jobId, { done: 0, total: 1 });
      result.group = await runGrouping(pool, context);
      await updateJobProgress(pool, context, jobId, { done: 1, total: 1 });
    }

    await completeJob(pool, context, jobId, result);
  } catch (err) {
    await failJob(pool, context, jobId, err instanceof Error ? err.message : String(err));
  }
}

export async function startPipelineRun(
  pool: pg.Pool,
  context: PopulationContext,
  opts: RunOptions,
): Promise<{ jobId: string }> {
  const jobId = await createJob(pool, context, 'run', stagesFrom(opts.from).length, opts.from);
  void executePipelineRun(pool, context, jobId, opts);
  return { jobId };
}
