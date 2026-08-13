import type pg from 'pg';
import { compositeSubquery } from '../scoring/run.js';
import { getEntryGroup } from '../group/queue.js';
import { toCents } from '../money.js';
import type { PopulationContext } from '../dataset.js';

interface EntryListParams {
  period?: string;
  account?: string;
  minScore?: number;
  rule?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

interface EntryListRow {
  entry_id: string;
  period: string;
  effective_date: string;
  posted_at: Date;
  user: string;
  source: string;
  line_count: number;
  total_amount: string;
  composite: number;
  rules_fired: string[];
}

interface EntryRow {
  entry_id: string;
  period: string;
  effective_date: string;
  posted_at: Date;
  user: string;
  source: string;
  voucher_type: string;
  narration: string | null;
  line_count: number;
  total_amount: string;
  composite: number;
}

interface EntryLineRow {
  line_id: string;
  line_no: number;
  account: string;
  debit: string;
  credit: string;
  party_type: string | null;
  party: string | null;
  cost_center: string | null;
  memo: string | null;
}

interface ScoreRow {
  rule: string;
  score: number;
  inputs: unknown;
}

interface GraphNodeRow {
  id: string;
  label: string;
  root_type: string;
  volume: number;
}

interface DiffEdgeRow {
  account_a: string;
  account_b: string;
  status: string;
  p1_count: number;
  p2_count: number;
  volume_delta: number | null;
}

interface PeriodEdgeRow {
  account_a: string;
  account_b: string;
  count: number;
  total_amount: number;
}

function mapGraphNode(row: GraphNodeRow) {
  return { id: row.id, label: row.label, rootType: row.root_type, volume: row.volume };
}

function pairId(row: { account_a: string; account_b: string }): string {
  return `${row.account_a}↔${row.account_b}`;
}

export async function buildProfile(pool: pg.Pool, context: PopulationContext) {
  const [histogram, byMonth, topAccounts, flagCounts] = await Promise.all([
    pool.query<{ period: string; lines: number; count: string }>(
      `SELECT period::text, line_count AS lines, COUNT(*)::text AS count
       FROM entries WHERE dataset_id = $1 GROUP BY period, line_count ORDER BY period, line_count`,
      [context.datasetId],
    ),
    pool.query<{ month: string; entries: string; lines: string }>(
      `SELECT to_char(e.effective_date, 'YYYY-MM') AS month,
              COUNT(DISTINCT e.entry_id)::text AS entries,
              COUNT(l.line_id)::text AS lines
       FROM entries e
       LEFT JOIN lines l ON l.dataset_id = e.dataset_id AND l.entry_id = e.entry_id
       WHERE e.dataset_id = $1 GROUP BY 1 ORDER BY 1`,
      [context.datasetId],
    ),
    pool.query<{ account: string; name: string; total_amount: string; line_count: string }>(
      `SELECT l.account, a.name, SUM(l.debit + l.credit)::text AS total_amount, COUNT(*)::text AS line_count
       FROM lines l JOIN accounts a ON a.dataset_id = l.dataset_id AND a.account = l.account
       WHERE l.dataset_id = $1
       GROUP BY l.account, a.name
       ORDER BY SUM(l.debit + l.credit) DESC LIMIT 10`,
      [context.datasetId],
    ),
    pool.query<{ rule: string; count: string }>(
      `SELECT rule, COUNT(DISTINCT entry_id)::text AS count FROM scores
       WHERE dataset_id = $1 GROUP BY rule ORDER BY rule`,
      [context.datasetId],
    ),
  ]);

  return {
    entrySizeHistogram: histogram.rows.map((r) => ({
      period: r.period,
      lines: r.lines,
      count: Number(r.count),
    })),
    byMonth: byMonth.rows.map((r) => ({
      month: r.month,
      entries: Number(r.entries),
      lines: Number(r.lines),
    })),
    topAccounts: topAccounts.rows.map((r) => ({
      account: r.account,
      name: r.name,
      totalAmount: toCents(r.total_amount),
      lineCount: Number(r.line_count),
    })),
    flagCounts: flagCounts.rows.map((r) => ({
      rule: r.rule,
      group: r.rule.includes('pair') || r.rule.includes('threshold') || r.rule.includes('entry_size')
        ? 'population'
        : 'parametric',
      count: Number(r.count),
    })),
  };
}

export async function queryEntries(
  pool: pg.Pool,
  context: PopulationContext,
  params: EntryListParams,
) {
  const compositeSql = compositeSubquery('$1');
  const where: string[] = ['e.dataset_id = $1'];
  const values: unknown[] = [context.datasetId];
  let i = 2;

  if (params.period) {
    where.push(`e.period = $${i++}`);
    values.push(params.period);
  }
  if (params.account) {
    where.push(`EXISTS (SELECT 1 FROM lines l WHERE l.dataset_id = e.dataset_id AND l.entry_id = e.entry_id AND l.account = $${i++})`);
    values.push(params.account);
  }
  if (params.rule) {
    where.push(`EXISTS (SELECT 1 FROM scores s2 WHERE s2.dataset_id = e.dataset_id AND s2.entry_id = e.entry_id AND s2.rule = $${i++})`);
    values.push(params.rule);
  }
  if (params.minScore != null) {
    where.push(`COALESCE(c.composite, 0) >= $${i++}`);
    values.push(params.minScore);
  }

  const sortCol = params.sort === 'date' ? 'e.effective_date' : params.sort === 'amount' ? 'e.total_amount' : 'c.composite';
  const sortDir = params.order === 'asc' ? 'ASC' : 'DESC';
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query<EntryListRow>(
    `WITH composite AS (${compositeSql})
     SELECT e.entry_id, e.period::text, e.effective_date::text, e.posted_at, e."user", e.source,
            e.line_count, ROUND(e.total_amount * 100)::bigint AS total_amount,
            COALESCE(c.composite, 0)::float AS composite,
            COALESCE((SELECT json_agg(rule) FROM scores s
                      WHERE s.dataset_id = e.dataset_id AND s.entry_id = e.entry_id), '[]'::json) AS rules_fired
     FROM entries e
     LEFT JOIN composite c ON c.dataset_id = e.dataset_id AND c.entry_id = e.entry_id
     ${whereSql}
     ORDER BY ${sortCol} ${sortDir} NULLS LAST
     LIMIT $${i++} OFFSET $${i++}`,
    [...values, limit, offset],
  );

  const { rows: totalRows } = await pool.query<{ n: string }>(
    `WITH composite AS (${compositeSql})
     SELECT COUNT(*)::text AS n FROM entries e
     LEFT JOIN composite c ON c.dataset_id = e.dataset_id AND c.entry_id = e.entry_id ${whereSql}`,
    values,
  );

  return {
    total: Number(totalRows[0]?.n ?? 0),
    rows: rows.map((r) => ({
      entryId: r.entry_id,
      period: r.period,
      effectiveDate: r.effective_date,
      postedAt: r.posted_at,
      user: r.user,
      source: r.source,
      lineCount: r.line_count,
      totalAmount: Number(r.total_amount),
      composite: Number(r.composite),
      rulesFired: r.rules_fired,
      caseStatus: null,
      reviewStatus: 'open',
    })),
  };
}

export async function getEntry(pool: pg.Pool, context: PopulationContext, entryId: string) {
  const compositeSql = compositeSubquery('$1');
  const { rows } = await pool.query<EntryRow>(
    `WITH composite AS (${compositeSql})
     SELECT e.*, COALESCE(c.composite, 0)::float AS composite
     FROM entries e LEFT JOIN composite c ON c.dataset_id = e.dataset_id AND c.entry_id = e.entry_id
     WHERE e.dataset_id = $1 AND e.entry_id = $2`,
    [context.datasetId, entryId],
  );
  const entry = rows[0];
  if (!entry) return null;

  const [lines, scores, membership] = await Promise.all([
    pool.query<EntryLineRow>(`SELECT * FROM lines WHERE dataset_id = $1 AND entry_id = $2 ORDER BY line_no`, [context.datasetId, entryId]),
    pool.query<ScoreRow>(`SELECT rule, score::float, inputs FROM scores WHERE dataset_id = $1 AND entry_id = $2`, [context.datasetId, entryId]),
    getEntryGroup(pool, context, entryId),
  ]);

  return {
    entry: {
      entryId: entry.entry_id,
      period: entry.period,
      effectiveDate: entry.effective_date,
      postedAt: entry.posted_at,
      user: entry.user,
      source: entry.source,
      voucherType: entry.voucher_type,
      narration: entry.narration,
      lineCount: entry.line_count,
      totalAmount: toCents(entry.total_amount),
    },
    lines: lines.rows.map((l) => ({
      lineId: l.line_id,
      lineNo: l.line_no,
      account: l.account,
      debit: toCents(l.debit),
      credit: toCents(l.credit),
      partyType: l.party_type,
      party: l.party,
      costCenter: l.cost_center,
      memo: l.memo,
    })),
    scores: scores.rows.map((s) => ({
      rule: s.rule,
      score: s.score,
      inputs: s.inputs,
    })),
    composite: entry.composite,
    groupId: membership?.group_id ?? null,
    isDeviation: membership?.is_deviation ?? false,
  };
}

export async function queryGraph(
  pool: pg.Pool,
  context: PopulationContext,
  params: { mode?: string },
) {
  const mode = params.mode ?? 'diff';

  if (mode === 'diff') {
    const { rows: edges } = await pool.query<DiffEdgeRow>(
      `SELECT account_a, account_b, status::text, p1_count, p2_count, volume_delta::float
       FROM pair_diff WHERE dataset_id = $1`,
      [context.datasetId],
    );
    const { rows: nodes } = await pool.query<GraphNodeRow>(
      `SELECT a.account AS id, a.name AS label, a.root_type,
              COALESCE(SUM(p.total_amount), 0)::float AS volume
       FROM accounts a
       LEFT JOIN pairs p ON p.dataset_id = a.dataset_id AND (p.account_a = a.account OR p.account_b = a.account)
       WHERE a.dataset_id = $1
       GROUP BY a.account, a.name, a.root_type`,
      [context.datasetId],
    );
    return {
      mode: 'diff',
      nodes: nodes.map(mapGraphNode),
      edges: edges.map((e) => ({
        id: pairId(e),
        source: e.account_a,
        target: e.account_b,
        status: e.status,
        p1Count: e.p1_count,
        p2Count: e.p2_count,
        volumeDelta: e.volume_delta,
      })),
    };
  }

  const period = mode === 'p2' ? 'P2' : 'P1';
  const { rows: edges } = await pool.query<PeriodEdgeRow>(
    `SELECT account_a, account_b, count, total_amount::float FROM pairs WHERE dataset_id = $1 AND period = $2`,
    [context.datasetId, period],
  );
  const maxCount = Math.max(...edges.map((e) => e.count), 1);
  const { rows: nodes } = await pool.query<GraphNodeRow>(
    `SELECT a.account AS id, a.name AS label, a.root_type,
            COALESCE(SUM(p.total_amount), 0)::float AS volume
     FROM accounts a
     LEFT JOIN pairs p ON p.dataset_id = a.dataset_id
       AND (p.account_a = a.account OR p.account_b = a.account) AND p.period = $2
     WHERE a.dataset_id = $1
     GROUP BY a.account, a.name, a.root_type`,
    [context.datasetId, period],
  );

  return {
    mode: period === 'P1' ? 'p1' : 'p2',
    nodes: nodes.map(mapGraphNode),
    edges: edges.map((e) => ({
      id: pairId(e),
      source: e.account_a,
      target: e.account_b,
      count: e.count,
      totalAmount: e.total_amount,
      rarity: 1 / e.count / (1 / maxCount),
    })),
  };
}
