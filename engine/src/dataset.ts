import type pg from 'pg';
import type { PipelineState } from './types.js';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The ownership scope every population query and mutation must carry. */
export interface PopulationContext {
  businessId: string;
  datasetId: string;
  pipeline: PipelineState;
}

export interface CurrentPopulation extends PopulationContext {
  status: string;
  loadedAt: Date;
  sourceFiles: unknown;
  reconciliation: unknown;
  overrideReason: string | null;
  overrideAt: Date | null;
}

interface PopulationRow {
  business_id: string;
  dataset_id: string;
  status: string;
  loaded_at: Date;
  source_files: unknown;
  reconciliation: unknown;
  pipeline: PipelineState;
  override_reason: string | null;
  override_at: Date | null;
}

const POPULATION_COLUMNS = `
  business_id, dataset_id, status, loaded_at, source_files, reconciliation,
  pipeline, override_reason, override_at
`;

/** Return a business's current population, if it has one. */
export async function getCurrentPopulation(
  pool: pg.Pool,
  businessId: string,
): Promise<CurrentPopulation | null> {
  const { rows } = await pool.query<PopulationRow>(
    `SELECT ${POPULATION_COLUMNS}
     FROM datasets
     WHERE business_id = $1 AND is_current
     LIMIT 1`,
    [businessId],
  );
  return rows[0] ? mapPopulation(rows[0]) : null;
}

/** Return a business's current population or the standard empty-state error. */
export async function requireCurrentPopulation(
  pool: pg.Pool,
  businessId: string,
): Promise<CurrentPopulation> {
  const population = await getCurrentPopulation(pool, businessId);
  if (!population) {
    const business = await pool.query(`SELECT 1 FROM businesses WHERE business_id = $1`, [businessId]);
    if (business.rowCount === 0) {
      throw new ApiError(404, 'business_not_found', 'business not found');
    }
    throw new ApiError(404, 'no_current_dataset', 'business has no current dataset');
  }
  return population;
}

/** Resolve a specific dataset while preventing cross-business discovery. */
export async function resolvePopulation(
  pool: pg.Pool,
  businessId: string,
  datasetId: string,
): Promise<CurrentPopulation> {
  const { rows } = await pool.query<PopulationRow>(
    `SELECT ${POPULATION_COLUMNS}
     FROM datasets
     WHERE business_id = $1 AND dataset_id = $2`,
    [businessId, datasetId],
  );
  if (!rows[0]) {
    throw new ApiError(404, 'dataset_not_found', 'dataset not found');
  }
  return mapPopulation(rows[0]);
}

export function requirePipelineStage(
  context: PopulationContext,
  stage: keyof PipelineState,
): void {
  if (!context.pipeline[stage]) {
    throw new ApiError(
      409,
      'pipeline_incomplete',
      `requires ${stage} — run prior pipeline stages first`,
      { businessId: context.businessId, datasetId: context.datasetId, pipeline: context.pipeline },
    );
  }
}

/** Atomically patch one explicitly scoped population's pipeline state. */
export async function updatePipeline(
  pool: pg.Pool,
  context: Pick<PopulationContext, 'businessId' | 'datasetId'>,
  patch: Partial<PipelineState>,
): Promise<PopulationContext> {
  const { rows } = await pool.query<{ pipeline: PipelineState }>(
    `UPDATE datasets
     SET pipeline = COALESCE(pipeline, '{}'::jsonb) || $1::jsonb
     WHERE business_id = $2 AND dataset_id = $3
     RETURNING pipeline`,
    [JSON.stringify(patch), context.businessId, context.datasetId],
  );
  if (!rows[0]) {
    throw new ApiError(404, 'dataset_not_found', 'dataset not found');
  }
  return {
    businessId: context.businessId,
    datasetId: context.datasetId,
    pipeline: normalizePipeline(rows[0].pipeline),
  };
}

function mapPopulation(row: PopulationRow): CurrentPopulation {
  return {
    businessId: row.business_id,
    datasetId: row.dataset_id,
    status: row.status,
    loadedAt: row.loaded_at,
    sourceFiles: row.source_files,
    reconciliation: row.reconciliation,
    pipeline: normalizePipeline(row.pipeline),
    overrideReason: row.override_reason,
    overrideAt: row.override_at,
  };
}

function normalizePipeline(pipeline: PipelineState | null | undefined): PipelineState {
  return {
    ingested: Boolean(pipeline?.ingested),
    projected: Boolean(pipeline?.projected),
    scored: Boolean(pipeline?.scored),
    investigated: Boolean(pipeline?.investigated),
    grouped: Boolean(pipeline?.grouped),
  };
}
