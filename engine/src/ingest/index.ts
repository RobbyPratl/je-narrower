import path from 'node:path';
import type pg from 'pg';
import { withTransaction } from '../db/client.js';
import { load, LoadError, markLoadFailed, type LoadInput } from './load.js';
import { ParseError, parseGlContent, parseGlFile, parseTbContent, parseTbFile } from './parse.js';
import { runReconciliation } from './reconcile/index.js';
import type { ReconciliationState, SourceFile } from '../types.js';

export interface IngestOptions {
  businessId: string;
  datasetId: string;
  glFiles: [string, string];
  tbFiles: [string, string];
  repoRoot?: string;
}

export interface IngestResult extends ReconciliationState {
  businessId: string;
  datasetId: string;
  status: 'reconciled' | 'unreconciled';
  summary: {
    entries: { P1: number; P2: number };
    lines: { P1: number; P2: number };
    accounts: number;
    checksPassed: number;
    checksFailed: number;
  };
}

function resolve(repoRoot: string | undefined, p: string): string {
  if (path.isAbsolute(p)) return p;
  if (repoRoot) return path.join(repoRoot, p);
  return path.resolve(p);
}

export async function runIngest(pool: pg.Pool, opts: IngestOptions): Promise<IngestResult> {
  const root = opts.repoRoot ?? process.cwd();
  const [glP1, glP2, tbP1, tbP2] = await Promise.all([
    parseGlFile(resolve(root, opts.glFiles[0])),
    parseGlFile(resolve(root, opts.glFiles[1])),
    parseTbFile(resolve(root, opts.tbFiles[0])),
    parseTbFile(resolve(root, opts.tbFiles[1])),
  ]);

  return runIngestParsed(pool, {
    businessId: opts.businessId,
    datasetId: opts.datasetId,
    gl: { p1: glP1.rows, p2: glP2.rows },
    tb: { p1: tbP1.rows, p2: tbP2.rows },
    sourceFiles: [
      { file: path.basename(opts.glFiles[0]), sha256: glP1.sha256, rows: glP1.rows.length },
      { file: path.basename(opts.glFiles[1]), sha256: glP2.sha256, rows: glP2.rows.length },
      { file: path.basename(opts.tbFiles[0]), sha256: tbP1.sha256, rows: tbP1.rows.length },
      { file: path.basename(opts.tbFiles[1]), sha256: tbP2.sha256, rows: tbP2.rows.length },
    ],
  });
}

export async function runIngestFromUpload(
  pool: pg.Pool,
  opts: {
    businessId: string;
    datasetId: string;
    files: { glP1: Buffer; glP2: Buffer; tbP1: Buffer; tbP2: Buffer };
    names: { glP1: string; glP2: string; tbP1: string; tbP2: string };
  },
): Promise<IngestResult> {
  const glP1 = parseGlContent(opts.names.glP1, opts.files.glP1.toString('utf8'));
  const glP2 = parseGlContent(opts.names.glP2, opts.files.glP2.toString('utf8'));
  const tbP1 = parseTbContent(opts.names.tbP1, opts.files.tbP1.toString('utf8'));
  const tbP2 = parseTbContent(opts.names.tbP2, opts.files.tbP2.toString('utf8'));

  return runIngestParsed(pool, {
    businessId: opts.businessId,
    datasetId: opts.datasetId,
    gl: { p1: glP1.rows, p2: glP2.rows },
    tb: { p1: tbP1.rows, p2: tbP2.rows },
    sourceFiles: [
      { file: opts.names.glP1, sha256: glP1.sha256, rows: glP1.rows.length },
      { file: opts.names.glP2, sha256: glP2.sha256, rows: glP2.rows.length },
      { file: opts.names.tbP1, sha256: tbP1.sha256, rows: tbP1.rows.length },
      { file: opts.names.tbP2, sha256: tbP2.sha256, rows: tbP2.rows.length },
    ],
  });
}

export async function runIngestParsed(
  pool: pg.Pool,
  input: {
    businessId: string;
    datasetId: string;
    gl: LoadInput['gl'];
    tb: LoadInput['tb'];
    sourceFiles: SourceFile[];
  },
): Promise<IngestResult> {
  const loadInput: LoadInput = {
    businessId: input.businessId,
    datasetId: input.datasetId,
    gl: input.gl,
    tb: input.tb,
    sourceFiles: input.sourceFiles,
  };

  try {
    await withTransaction(pool, async (db) => {
      await load(db, loadInput);
    });
  } catch (err) {
    if (err instanceof LoadError) {
      const client = await pool.connect();
      try {
        await markLoadFailed(client, input.businessId, input.datasetId, err.message);
      } finally {
        client.release();
      }
    }
    throw err;
  }

  const reconciliation = await withTransaction(pool, async (db) =>
    runReconciliation(db, input.businessId, input.datasetId),
  );

  const counts = await buildSummary(pool, input.datasetId);
  const status = reconciliation.reconciled ? 'reconciled' : 'unreconciled';

  return {
    businessId: input.businessId,
    datasetId: input.datasetId,
    status,
    summary: {
      ...counts,
      checksPassed: reconciliation.report.filter((r) => r.ok).length,
      checksFailed: reconciliation.report.filter((r) => !r.ok).length,
    },
    ...reconciliation,
  };
}

async function buildSummary(pool: pg.Pool, datasetId: string) {
  const [entries, lines, accounts] = await Promise.all([
    pool.query<{ period: string; n: string }>(
      `SELECT period::text, COUNT(*)::text AS n
       FROM entries WHERE dataset_id = $1 GROUP BY period`,
      [datasetId],
    ),
    pool.query<{ period: string; n: string }>(
      `SELECT e.period::text, COUNT(*)::text AS n
       FROM lines l
       JOIN entries e ON e.dataset_id = l.dataset_id AND e.entry_id = l.entry_id
       WHERE l.dataset_id = $1
       GROUP BY e.period`,
      [datasetId],
    ),
    pool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM accounts WHERE dataset_id = $1',
      [datasetId],
    ),
  ]);

  const entryMap = Object.fromEntries(entries.rows.map((r) => [r.period, Number(r.n)]));
  const lineMap = Object.fromEntries(lines.rows.map((r) => [r.period, Number(r.n)]));

  return {
    entries: { P1: entryMap.P1 ?? 0, P2: entryMap.P2 ?? 0 },
    lines: { P1: lineMap.P1 ?? 0, P2: lineMap.P2 ?? 0 },
    accounts: Number(accounts.rows[0]?.n ?? 0),
  };
}

export { ParseError, LoadError };
