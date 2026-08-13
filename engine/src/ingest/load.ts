import type { Db } from '../db/client.js';
import { centsToNumeric } from '../money.js';
import type { Period } from '../config.js';
import type { SourceFile } from '../types.js';
import {
  deriveNormalBalance,
  emptyToNull,
  type GlRow,
  type TbRow,
} from './schema.js';

export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadError';
  }
}

export interface LoadInput {
  businessId: string;
  datasetId: string;
  gl: { p1: GlRow[]; p2: GlRow[] };
  tb: { p1: TbRow[]; p2: TbRow[] };
  sourceFiles: SourceFile[];
}

interface AccountDraft {
  account: string;
  account_number: string | null;
  name: string;
  root_type: GlRow['root_type'];
  account_type: string | null;
  normal_balance: 'debit' | 'credit';
}

const DERIVED_TABLES = [
  'jobs',
  'group_members',
  'review_groups',
  'decisions',
  'cases',
  'scores',
  'projection_skips',
  'pair_diff',
  'pairs',
  'lines',
  'entries',
  'trial_balance',
  'accounts',
];

const BATCH = 500;

export async function load(db: Db, input: LoadInput): Promise<void> {
  await validateBusinessCompany(db, input);
  const dataset = await db.query<{ dataset_id: string }>(
    `INSERT INTO datasets (dataset_id, business_id, status, source_files, reconciliation, pipeline, override_reason, override_at, is_current)
     VALUES ($1, $2, 'loading', $3::jsonb, '[]'::jsonb, '{}'::jsonb, NULL, NULL, false)
     ON CONFLICT (dataset_id) DO UPDATE SET
       status = 'loading',
       loaded_at = now(),
       source_files = EXCLUDED.source_files,
       reconciliation = '[]'::jsonb,
       pipeline = '{}'::jsonb,
       override_reason = NULL,
       override_at = NULL,
       is_current = false
     WHERE datasets.business_id = EXCLUDED.business_id
     RETURNING dataset_id`,
    [input.datasetId, input.businessId, JSON.stringify(input.sourceFiles)],
  );
  if (dataset.rows.length === 0) {
    throw new LoadError(`dataset ${input.datasetId} belongs to another business`);
  }

  for (const table of DERIVED_TABLES) {
    await db.query(`DELETE FROM ${table} WHERE dataset_id = $1`, [input.datasetId]);
  }

  const accounts = buildAccounts(input);
  await batchInsert(
    db,
    'INSERT INTO accounts (dataset_id, account, account_number, name, root_type, account_type, normal_balance) VALUES ',
    [...accounts.values()].map((a) => [input.datasetId, a.account, a.account_number, a.name, a.root_type, a.account_type, a.normal_balance]),
    7,
  );

  const allGl = [...input.gl.p1, ...input.gl.p2];
  const byEntry = groupBy(allGl, (r) => r.entry_id);

  const entryRows: unknown[][] = [];
  const lineRows: unknown[][] = [];

  for (const [entryId, lines] of byEntry) {
    const header = deriveEntryHeader(entryId, lines);
    entryRows.push([
      input.datasetId,
      header.entry_id,
      header.period,
      header.posted_at,
      header.effective_date,
      header.user,
      header.source,
      header.voucher_type,
      header.narration,
      header.line_count,
      centsToNumeric(header.total_amount_cents),
    ]);

    for (const line of lines.sort((a, b) => a.line_no - b.line_no)) {
      lineRows.push([
        input.datasetId,
        line.line_id,
        entryId,
        line.line_no,
        line.account,
        centsToNumeric(line.debit),
        centsToNumeric(line.credit),
        emptyToNull(line.party_type),
        emptyToNull(line.party),
        emptyToNull(line.cost_center),
        emptyToNull(line.remarks) ?? null,
      ]);
    }
  }

  await batchInsert(
    db,
    'INSERT INTO entries (dataset_id, entry_id, period, posted_at, effective_date, "user", source, voucher_type, narration, line_count, total_amount) VALUES ',
    entryRows,
    11,
    (base) =>
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::timestamptz, $${base + 5}::date, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`,
  );

  await batchInsert(
    db,
    'INSERT INTO lines (dataset_id, line_id, entry_id, line_no, account, debit, credit, party_type, party, cost_center, memo) VALUES ',
    lineRows,
    11,
  );

  await insertTb(db, input.datasetId, 'P1', input.tb.p1);
  await insertTb(db, input.datasetId, 'P2', input.tb.p2);

  await db.query(
    `UPDATE datasets SET pipeline = $3::jsonb WHERE dataset_id = $1 AND business_id = $2`,
    [input.datasetId, input.businessId, JSON.stringify({ ingested: true, projected: false, scored: false, investigated: false, grouped: false })],
  );

}

async function validateBusinessCompany(db: Db, input: LoadInput): Promise<void> {
  const companies = new Set([...input.gl.p1, ...input.gl.p2].map((row) => row.company.trim()));
  if (companies.size !== 1) {
    throw new LoadError(`GL files contain multiple companies: ${[...companies].sort().join(', ')}`);
  }
  const company = companies.values().next().value;
  if (!company) throw new LoadError('GL company required');

  const { rows } = await db.query<{ source_company: string }>(
    `UPDATE businesses
     SET source_company = COALESCE(source_company, $2)
     WHERE business_id = $1
     RETURNING source_company`,
    [input.businessId, company],
  );
  if (!rows[0]) throw new LoadError(`business ${input.businessId} not found`);
  if (rows[0].source_company !== company) {
    throw new LoadError(
      `GL company ${company} does not match business source company ${rows[0].source_company}`,
    );
  }
}

async function batchInsert(
  db: Db,
  prefix: string,
  rows: unknown[][],
  cols: number,
  tupleFn?: (base: number) => string,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += BATCH) {
    const chunk = rows.slice(offset, offset + BATCH);
    const values: unknown[] = [];
    const tuples = chunk.map((row, j) => {
      const base = j * cols;
      values.push(...row);
      if (tupleFn) return tupleFn(base);
      const ph = Array.from({ length: cols }, (_, k) => `$${base + k + 1}`);
      return `(${ph.join(', ')})`;
    });
    await db.query(prefix + tuples.join(', '), values);
  }
}

function buildAccounts(input: LoadInput): Map<string, AccountDraft> {
  const map = new Map<string, AccountDraft>();

  const add = (row: {
    account: string;
    account_number: string;
    account_name: string;
    root_type: GlRow['root_type'];
    account_type?: string;
  }) => {
    const existing = map.get(row.account);
    const draft: AccountDraft = {
      account: row.account,
      account_number: emptyToNull(row.account_number),
      name: row.account_name,
      root_type: row.root_type,
      account_type: row.account_type ? row.account_type : existing?.account_type ?? null,
      normal_balance: deriveNormalBalance(row.root_type),
    };
    if (existing && (existing.root_type !== draft.root_type || existing.name !== draft.name)) {
      throw new LoadError(`conflicting account metadata for ${row.account}`);
    }
    map.set(row.account, draft);
  };

  for (const row of [...input.gl.p1, ...input.gl.p2]) {
    add(row);
  }
  for (const row of [...input.tb.p1, ...input.tb.p2]) {
    add({ ...row, account_type: row.account_type });
  }

  return map;
}

function deriveEntryHeader(entryId: string, lines: GlRow[]) {
  const sorted = [...lines].sort((a, b) => a.line_no - b.line_no);
  const first = sorted[0]!;

  for (const line of sorted) {
    if (line.period !== first.period) throw new LoadError(`${entryId}: mixed periods`);
    if (line.posting_date !== first.posting_date) throw new LoadError(`${entryId}: mixed posting_date`);
    if (line.created_at !== first.created_at) throw new LoadError(`${entryId}: mixed created_at`);
  }

  const narration = sorted.map((l) => l.remarks).find((r) => r !== '') ?? null;
  const total_amount_cents = sorted.reduce((sum, l) => sum + l.debit, 0);

  return {
    entry_id: entryId,
    period: first.period as Period,
    posted_at: first.created_at,
    effective_date: first.posting_date,
    user: first.user,
    source: first.voucher_subtype,
    voucher_type: first.voucher_type,
    narration,
    line_count: sorted.length,
    total_amount_cents,
  };
}

async function insertTb(db: Db, datasetId: string, period: Period, rows: TbRow[]): Promise<void> {
  await batchInsert(
    db,
    `INSERT INTO trial_balance (dataset_id, period, account, opening_debit, opening_credit, period_debit, period_credit, closing_debit, closing_credit) VALUES `,
    rows.map((row) => [
      datasetId,
      period,
      row.account,
      centsToNumeric(row.opening_debit),
      centsToNumeric(row.opening_credit),
      centsToNumeric(row.period_debit),
      centsToNumeric(row.period_credit),
      centsToNumeric(row.closing_debit),
      centsToNumeric(row.closing_credit),
    ]),
    9,
  );
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

export async function markLoadFailed(
  db: Db,
  businessId: string,
  datasetId: string,
  message: string,
): Promise<void> {
  const report = [{
    check: 'load',
    ok: false,
    summary: message,
    metrics: {},
    failures: [],
  }];
  await db.query(
    `INSERT INTO datasets (dataset_id, business_id, status, source_files, reconciliation, is_current)
     VALUES ($1, $2, 'load_failed', '[]'::jsonb, $3::jsonb, false)
     ON CONFLICT (dataset_id) DO UPDATE SET
       status = 'load_failed',
       reconciliation = EXCLUDED.reconciliation,
       is_current = false
     WHERE datasets.business_id = EXCLUDED.business_id`,
    [datasetId, businessId, JSON.stringify(report)],
  );
}
