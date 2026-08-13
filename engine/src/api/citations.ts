import type pg from 'pg';
import { toCents } from '../money.js';
import type { PopulationContext } from '../dataset.js';

interface CitationLineRow {
  line_id: string;
  line_no: number;
  account: string;
  debit: string;
  credit: string;
  memo: string | null;
}

interface LineCitationRow extends CitationLineRow {
  entry_id: string;
  period: string;
  effective_date: string;
  narration: string | null;
  user: string;
}

interface EntryCitationRow {
  entry_id: string;
  period: string;
  effective_date: string;
  posted_at: Date;
  narration: string | null;
  user: string;
  total_amount: string;
  source: string;
  line_count: number;
}

function mapLine(row: CitationLineRow) {
  return {
    lineId: row.line_id,
    lineNo: row.line_no,
    account: row.account,
    debit: toCents(row.debit),
    credit: toCents(row.credit),
    memo: row.memo,
  };
}

export async function resolveCitation(pool: pg.Pool, context: PopulationContext, kind: string, ref: string) {
  if (kind === 'line') {
    const { rows } = await pool.query<LineCitationRow>(
      `SELECT l.line_id, l.line_no, l.account, l.debit::text, l.credit::text, l.memo,
              e.entry_id, e.period::text, e.effective_date::text, e.narration, e."user"
       FROM lines l JOIN entries e ON e.dataset_id = l.dataset_id AND e.entry_id = l.entry_id
       WHERE l.dataset_id = $1 AND l.line_id = $2`,
      [context.datasetId, ref],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      kind: 'line' as const,
      ref,
      line: { ...mapLine(row), entryId: row.entry_id },
      entry: {
        entryId: row.entry_id,
        period: row.period,
        effectiveDate: row.effective_date,
        narration: row.narration,
        user: row.user,
      },
    };
  }

  if (kind === 'entry') {
    const { rows: entry } = await pool.query<EntryCitationRow>(
      `SELECT entry_id, period::text, effective_date::text, posted_at, narration, "user",
              total_amount::text, source, line_count
       FROM entries WHERE dataset_id = $1 AND entry_id = $2`,
      [context.datasetId, ref],
    );
    const e = entry[0];
    if (!e) return null;
    const { rows: lines } = await pool.query<CitationLineRow>(
      `SELECT line_id, line_no, account, debit::text, credit::text, memo
       FROM lines WHERE dataset_id = $1 AND entry_id = $2 ORDER BY line_no`,
      [context.datasetId, ref],
    );
    return {
      kind: 'entry' as const,
      ref,
      entry: {
        entryId: e.entry_id,
        period: e.period,
        effectiveDate: e.effective_date,
        postedAt: e.posted_at.toISOString(),
        narration: e.narration,
        user: e.user,
        totalAmount: toCents(e.total_amount),
        source: e.source,
        lineCount: e.line_count,
      },
      lines: lines.map(mapLine),
    };
  }

  return null;
}
