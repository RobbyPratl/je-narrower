import type pg from 'pg';
import { pairKey } from '../pair-key.js';
import type { Period } from '../config.js';
import type { PopulationContext } from '../dataset.js';

export interface CitationRef {
  kind: 'line' | 'entry';
  ref: string;
}

export interface ToolResult {
  data: unknown;
  refs: CitationRef[];
}

export const TOOL_SAMPLE_LIMIT = 15;

export async function getEntryLines(pool: pg.Pool, context: PopulationContext, entryId: string): Promise<ToolResult> {
  const { rows: entry } = await pool.query(
    `SELECT entry_id, period::text, posted_at::text, effective_date::text, "user", source,
            voucher_type, narration, line_count, total_amount::text
     FROM entries WHERE dataset_id = $1 AND entry_id = $2`,
    [context.datasetId, entryId],
  );
  const { rows: lines } = await pool.query(
    `SELECT line_id, line_no, account, debit::text, credit::text, party_type, party, cost_center, memo
     FROM lines WHERE dataset_id = $1 AND entry_id = $2 ORDER BY line_no
     LIMIT $3`,
    [context.datasetId, entryId, TOOL_SAMPLE_LIMIT],
  );
  const sampleLines = lines.slice(0, TOOL_SAMPLE_LIMIT);
  const refs: CitationRef[] = [{ kind: 'entry', ref: entryId }];
  for (const l of sampleLines) refs.push({ kind: 'line', ref: l.line_id });
  const totalLines = Number(entry[0]?.line_count ?? lines.length);
  return {
    data: {
      entry: entry[0] ?? null,
      lines: sampleLines,
      lineSummary: { total: totalLines, returned: sampleLines.length, omitted: Math.max(0, totalLines - sampleLines.length) },
    },
    refs,
  };
}

export async function getPairHistory(
  pool: pg.Pool,
  context: PopulationContext,
  accountA: string,
  accountB: string,
  period: Period,
): Promise<ToolResult> {
  const [a, b] = pairKey(accountA, accountB);
  const [{ rows: summary }, { rows }] = await Promise.all([
    pool.query(
      `WITH matching_entries AS (
         SELECT l.entry_id
         FROM lines l
         WHERE l.dataset_id = $1 AND l.account = ANY(ARRAY[$3, $4]::text[])
         GROUP BY l.entry_id
         HAVING (
           BOOL_OR(l.account = $3 AND l.debit > 0)
           AND BOOL_OR(l.account = $4 AND l.credit > 0)
         ) OR (
           BOOL_OR(l.account = $3 AND l.credit > 0)
           AND BOOL_OR(l.account = $4 AND l.debit > 0)
         )
       )
       SELECT COUNT(*)::int AS occurrence_count,
              COALESCE(SUM(e.total_amount), 0)::text AS total_amount,
              COALESCE(AVG(e.total_amount), 0)::text AS average_amount,
              COALESCE(MIN(e.total_amount), 0)::text AS minimum_amount,
              COALESCE(MAX(e.total_amount), 0)::text AS maximum_amount,
              MIN(e.effective_date)::text AS first_seen,
              MAX(e.effective_date)::text AS last_seen
       FROM entries e
       JOIN matching_entries m ON m.entry_id = e.entry_id
       WHERE e.dataset_id = $1 AND e.period = $2`,
      [context.datasetId, period, a, b],
    ),
    pool.query(
    `WITH matching_entries AS (
       SELECT l.entry_id
       FROM lines l
       WHERE l.dataset_id = $1 AND l.account = ANY(ARRAY[$3, $4]::text[])
       GROUP BY l.entry_id
       HAVING (
         BOOL_OR(l.account = $3 AND l.debit > 0)
         AND BOOL_OR(l.account = $4 AND l.credit > 0)
       ) OR (
         BOOL_OR(l.account = $3 AND l.credit > 0)
         AND BOOL_OR(l.account = $4 AND l.debit > 0)
       )
     )
     SELECT e.entry_id, e.effective_date::text, e.total_amount::text, e."user"
     FROM entries e
     JOIN matching_entries m ON m.entry_id = e.entry_id
     WHERE e.dataset_id = $1 AND e.period = $2
     ORDER BY e.effective_date DESC, e.entry_id
     LIMIT $5`,
      [context.datasetId, period, a, b, TOOL_SAMPLE_LIMIT],
    ),
  ]);
  const occurrences = rows.slice(0, TOOL_SAMPLE_LIMIT);
  return {
    data: { pair: `${a}↔${b}`, period, summary: summary[0] ?? null, recentOccurrences: occurrences },
    refs: occurrences.map((r) => ({ kind: 'entry' as const, ref: r.entry_id })),
  };
}

export async function getPairDiff(pool: pg.Pool, context: PopulationContext, accountA: string, accountB: string): Promise<ToolResult> {
  const [a, b] = pairKey(accountA, accountB);
  const { rows } = await pool.query(
    `SELECT status::text, p1_count, p2_count, p1_amount::text, p2_amount::text, volume_delta::text
     FROM pair_diff WHERE dataset_id = $1 AND account_a = $2 AND account_b = $3`,
    [context.datasetId, a, b],
  );
  return { data: rows[0] ?? null, refs: [] };
}

export async function getSimilarEntries(pool: pg.Pool, context: PopulationContext, entryId: string, limit = 10): Promise<ToolResult> {
  const sampleLimit = Math.max(0, Math.min(TOOL_SAMPLE_LIMIT, limit));
  const { rows: accounts } = await pool.query<{ account: string }>(
    `SELECT DISTINCT account FROM lines WHERE dataset_id = $1 AND entry_id = $2`,
    [context.datasetId, entryId],
  );
  const accts = accounts.map((a) => a.account);
  const { rows } = await pool.query(
    `WITH candidate_accounts AS (
       SELECT l.entry_id,
              COUNT(DISTINCT l.account)::int AS account_count,
              COUNT(DISTINCT l.account) FILTER (WHERE l.account = ANY($3::text[]))::int AS overlap_count
       FROM lines l
       WHERE l.dataset_id = $1
       GROUP BY l.entry_id
     )
     SELECT e.entry_id, e.period::text, e.effective_date::text, e.total_amount::text
     FROM entries e
     JOIN candidate_accounts c ON c.entry_id = e.entry_id
     WHERE e.dataset_id = $1 AND e.entry_id <> $2
       AND c.overlap_count = LEAST($4, c.account_count)
     ORDER BY e.effective_date DESC
     LIMIT $5`,
    [context.datasetId, entryId, accts, accts.length, sampleLimit],
  );
  const similar = rows.slice(0, sampleLimit);
  return {
    data: { entryId, similar },
    refs: [{ kind: 'entry', ref: entryId }, ...similar.map((r) => ({ kind: 'entry' as const, ref: r.entry_id }))],
  };
}

export async function getUserActivity(pool: pg.Pool, context: PopulationContext, user: string, period: Period): Promise<ToolResult> {
  const [{ rows: summary }, { rows }, { rows: byAccount }, { rows: bySource }] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS entry_count,
              COALESCE(SUM(total_amount), 0)::text AS total_amount,
              COALESCE(AVG(total_amount), 0)::text AS average_amount,
              COALESCE(MIN(total_amount), 0)::text AS minimum_amount,
              COALESCE(MAX(total_amount), 0)::text AS maximum_amount,
              MIN(effective_date)::text AS first_seen,
              MAX(effective_date)::text AS last_seen
       FROM entries WHERE dataset_id = $1 AND "user" = $2 AND period = $3`,
      [context.datasetId, user, period],
    ),
    pool.query(
    `SELECT entry_id, effective_date::text, total_amount::text, source
     FROM entries WHERE dataset_id = $1 AND "user" = $2 AND period = $3
     ORDER BY effective_date DESC, entry_id LIMIT $4`,
      [context.datasetId, user, period, TOOL_SAMPLE_LIMIT],
    ),
    pool.query(
    `SELECT l.account, COUNT(DISTINCT e.entry_id)::int AS entry_count
     FROM entries e JOIN lines l ON l.dataset_id = e.dataset_id AND l.entry_id = e.entry_id
     WHERE e.dataset_id = $1 AND e."user" = $2 AND e.period = $3
     GROUP BY l.account ORDER BY entry_count DESC, l.account LIMIT 10`,
      [context.datasetId, user, period],
    ),
    pool.query(
      `SELECT source, COUNT(*)::int AS entry_count
       FROM entries WHERE dataset_id = $1 AND "user" = $2 AND period = $3
       GROUP BY source ORDER BY entry_count DESC, source LIMIT 10`,
      [context.datasetId, user, period],
    ),
  ]);
  const recentEntries = rows.slice(0, TOOL_SAMPLE_LIMIT);
  return {
    data: {
      user,
      period,
      summary: summary[0] ?? null,
      recentEntries,
      topAccounts: byAccount.slice(0, 10),
      topSources: bySource.slice(0, 10),
    },
    refs: recentEntries.map((r) => ({ kind: 'entry' as const, ref: r.entry_id })),
  };
}

export async function getAccountContext(pool: pg.Pool, context: PopulationContext, account: string): Promise<ToolResult> {
  const { rows: acct } = await pool.query(
    `SELECT account, account_number, name, root_type, account_type, normal_balance
     FROM accounts WHERE dataset_id = $1 AND account = $2`,
    [context.datasetId, account],
  );
  const { rows: byPeriod } = await pool.query(
    `SELECT e.period::text, COUNT(DISTINCT e.entry_id)::int AS entry_count,
            SUM(e.total_amount)::text AS total_amount
     FROM entries e JOIN lines l ON l.dataset_id = e.dataset_id AND l.entry_id = e.entry_id
     WHERE e.dataset_id = $1 AND l.account = $2 GROUP BY e.period`,
    [context.datasetId, account],
  );
  const { rows: counterparties } = await pool.query(
    `SELECT CASE WHEN p.account_a = $2 THEN p.account_b ELSE p.account_a END AS counterparty,
            SUM(p.count)::int AS pair_count
     FROM pairs p WHERE p.dataset_id = $1 AND (p.account_a = $2 OR p.account_b = $2)
     GROUP BY 1 ORDER BY pair_count DESC LIMIT 10`,
    [context.datasetId, account],
  );
  return {
    data: { account: acct[0] ?? null, byPeriod, counterparties },
    refs: [],
  };
}

export type ToolName =
  | 'get_entry_lines'
  | 'get_pair_history'
  | 'get_pair_diff'
  | 'get_similar_entries'
  | 'get_user_activity'
  | 'get_account_context';

export async function runTool(
  pool: pg.Pool,
  context: PopulationContext,
  tool: ToolName,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (tool) {
    case 'get_entry_lines':
      return getEntryLines(pool, context, String(args.entry_id));
    case 'get_pair_history':
      return getPairHistory(pool, context, String(args.account_a), String(args.account_b), args.period as Period);
    case 'get_pair_diff':
      return getPairDiff(pool, context, String(args.account_a), String(args.account_b));
    case 'get_similar_entries':
      return getSimilarEntries(pool, context, String(args.entry_id), Number(args.limit ?? 10));
    case 'get_user_activity':
      return getUserActivity(pool, context, String(args.user), args.period as Period);
    case 'get_account_context':
      return getAccountContext(pool, context, String(args.account));
    default:
      return { data: null, refs: [] };
  }
}
