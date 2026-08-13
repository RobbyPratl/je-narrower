import type pg from 'pg';
import { ApiError } from './dataset.js';

export interface Business {
  businessId: string;
  name: string;
  sourceCompany: string | null;
  createdAt: Date;
}

interface BusinessRow {
  business_id: string;
  name: string;
  source_company: string | null;
  created_at: Date;
}

export async function listBusinesses(pool: pg.Pool): Promise<Business[]> {
  const { rows } = await pool.query<BusinessRow>(
    `SELECT business_id, name, source_company, created_at
     FROM businesses
     ORDER BY created_at, business_id`,
  );
  return rows.map(mapBusiness);
}

export async function getBusiness(pool: pg.Pool, businessId: string): Promise<Business | null> {
  const { rows } = await pool.query<BusinessRow>(
    `SELECT business_id, name, source_company, created_at
     FROM businesses
     WHERE business_id = $1`,
    [businessId],
  );
  return rows[0] ? mapBusiness(rows[0]) : null;
}

export async function requireBusiness(pool: pg.Pool, businessId: string): Promise<Business> {
  const business = await getBusiness(pool, businessId);
  if (!business) {
    throw new ApiError(404, 'business_not_found', 'business not found');
  }
  return business;
}

export async function createBusiness(
  pool: pg.Pool,
  input: { businessId: string; name: string; sourceCompany?: string | null },
): Promise<Business> {
  const { rows } = await pool.query<BusinessRow>(
    `INSERT INTO businesses (business_id, name, source_company)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id) DO NOTHING
     RETURNING business_id, name, source_company, created_at`,
    [input.businessId, input.name, input.sourceCompany ?? null],
  );
  if (!rows[0]) {
    throw new ApiError(409, 'business_exists', 'business already exists');
  }
  return mapBusiness(rows[0]);
}

export async function listBusinessDatasets(pool: pg.Pool, businessId: string) {
  await requireBusiness(pool, businessId);
  const { rows } = await pool.query<{
    dataset_id: string;
    status: string;
    loaded_at: Date;
    is_current: boolean;
    pipeline: unknown;
  }>(
    `SELECT dataset_id, status, loaded_at, is_current, pipeline
     FROM datasets
     WHERE business_id = $1
     ORDER BY loaded_at DESC, dataset_id`,
    [businessId],
  );
  return rows.map((row) => ({
    datasetId: row.dataset_id,
    status: row.status,
    loadedAt: row.loaded_at.toISOString(),
    current: row.is_current,
    pipeline: row.pipeline,
  }));
}

function mapBusiness(row: BusinessRow): Business {
  return {
    businessId: row.business_id,
    name: row.name,
    sourceCompany: row.source_company,
    createdAt: row.created_at,
  };
}
