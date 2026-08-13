import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { PopulationContext } from './dataset.js';

export type JobStatus = 'running' | 'done' | 'failed';

export interface JobProgress {
  done: number;
  total: number;
  current?: string;
}

export async function createJob(
  pool: pg.Pool,
  context: PopulationContext,
  kind: string,
  total: number,
  stage?: string,
): Promise<string> {
  const jobId = `job-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO jobs (dataset_id, job_id, kind, status, stage, progress)
     VALUES ($1, $2, $3, 'running', $4, $5::jsonb)`,
    [context.datasetId, jobId, kind, stage ?? kind, JSON.stringify({ done: 0, total })],
  );
  return jobId;
}

export async function updateJobProgress(pool: pg.Pool, context: PopulationContext, jobId: string, progress: JobProgress) {
  await pool.query(`UPDATE jobs SET progress = $3::jsonb WHERE dataset_id = $1 AND job_id = $2`, [
    context.datasetId,
    jobId,
    JSON.stringify(progress),
  ]);
}

export async function updateJobStage(pool: pg.Pool, context: PopulationContext, jobId: string, stage: string) {
  await pool.query(`UPDATE jobs SET stage = $3 WHERE dataset_id = $1 AND job_id = $2`, [context.datasetId, jobId, stage]);
}

export async function completeJob(pool: pg.Pool, context: PopulationContext, jobId: string, result: unknown) {
  await pool.query(
    `UPDATE jobs SET status = 'done', result = $3::jsonb, finished_at = now()
     WHERE dataset_id = $1 AND job_id = $2`,
    [context.datasetId, jobId, JSON.stringify(result)],
  );
}

export async function failJob(pool: pg.Pool, context: PopulationContext, jobId: string, error: string) {
  await pool.query(
    `UPDATE jobs SET status = 'failed', error = $3, finished_at = now()
     WHERE dataset_id = $1 AND job_id = $2`,
    [context.datasetId, jobId, error],
  );
}

export async function getJob(pool: pg.Pool, context: PopulationContext, jobId: string) {
  const { rows } = await pool.query(
    `SELECT job_id, kind, status, stage, progress, error, result, started_at, finished_at
     FROM jobs WHERE dataset_id = $1 AND job_id = $2`,
    [context.datasetId, jobId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    jobId: row.job_id,
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    error: row.error,
    result: row.result,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}
