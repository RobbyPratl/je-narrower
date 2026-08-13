import type { Db } from '../db/client.js';
import { config } from '../config.js';
import type { Period } from '../config.js';
import { pairKey } from '../pair-key.js';
import { toCents } from '../money.js';

interface Side {
  account: string;
  cents: number;
}

export async function runProjection(
  db: Db,
  datasetId: string,
): Promise<{ pairs: Record<Period, number>; skipped: number }> {
  await db.query('DELETE FROM projection_skips WHERE dataset_id = $1', [datasetId]);
  await db.query('DELETE FROM pairs WHERE dataset_id = $1', [datasetId]);

  const { rows: entries } = await db.query<{
    entry_id: string;
    period: Period;
    effective_date: string;
    total_amount: string;
  }>(
    `SELECT entry_id, period, effective_date::text, total_amount::text
     FROM entries WHERE dataset_id = $1`,
    [datasetId],
  );

  const pairAcc = new Map<string, {
    period: Period;
    account_a: string;
    account_b: string;
    count: number;
    total_amount_cents: number;
    first_seen: string;
    last_seen: string;
  }>();

  let skipped = 0;

  for (const entry of entries) {
    const { rows: lines } = await db.query<{ account: string; debit: string; credit: string }>(
      `SELECT account, debit::text, credit::text
       FROM lines WHERE dataset_id = $1 AND entry_id = $2`,
      [datasetId, entry.entry_id],
    );

    const debits = aggregateSides(lines, 'debit');
    const credits = aggregateSides(lines, 'credit');
    const lineCount = debits.length + credits.length;

    if (config.projection.capLines && lineCount > config.projection.capLines) {
      await db.query(
        `INSERT INTO projection_skips (dataset_id, entry_id, period, line_count, cap)
         VALUES ($1, $2, $3, $4, $5)`,
        [datasetId, entry.entry_id, entry.period, lineCount, config.projection.capLines],
      );
      skipped++;
      continue;
    }

    const totalCents = toCents(entry.total_amount);
    if (totalCents === 0) continue;

    for (const d of debits) {
      for (const c of credits) {
        if (d.account === c.account) continue;
        const [account_a, account_b] = pairKey(d.account, c.account);
        const weightCents = Math.round((d.cents * c.cents) / totalCents);
        const key = `${entry.period}:${account_a}:${account_b}`;
        const existing = pairAcc.get(key);
        if (existing) {
          existing.count++;
          existing.total_amount_cents += weightCents;
          if (entry.effective_date < existing.first_seen) existing.first_seen = entry.effective_date;
          if (entry.effective_date > existing.last_seen) existing.last_seen = entry.effective_date;
        } else {
          pairAcc.set(key, {
            period: entry.period,
            account_a,
            account_b,
            count: 1,
            total_amount_cents: weightCents,
            first_seen: entry.effective_date,
            last_seen: entry.effective_date,
          });
        }
      }
    }
  }

  for (const p of pairAcc.values()) {
    await db.query(
      `INSERT INTO pairs
         (dataset_id, period, account_a, account_b, count, total_amount, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        datasetId,
        p.period,
        p.account_a,
        p.account_b,
        p.count,
        (p.total_amount_cents / 100).toFixed(2),
        p.first_seen,
        p.last_seen,
      ],
    );
  }

  const { rows: counts } = await db.query<{ period: Period; n: string }>(
    `SELECT period, COUNT(*)::text AS n
     FROM pairs WHERE dataset_id = $1 GROUP BY period`,
    [datasetId],
  );
  const byPeriod: Record<Period, number> = { P1: 0, P2: 0 };
  for (const r of counts) byPeriod[r.period] = Number(r.n);

  return { pairs: byPeriod, skipped };
}

function aggregateSides(
  lines: Array<{ account: string; debit: string; credit: string }>,
  side: 'debit' | 'credit',
): Side[] {
  const map = new Map<string, number>();
  for (const line of lines) {
    const cents = toCents(line[side]);
    if (cents <= 0) continue;
    map.set(line.account, (map.get(line.account) ?? 0) + cents);
  }
  return [...map.entries()].map(([account, cents]) => ({ account, cents }));
}

export async function runDiff(db: Db, datasetId: string): Promise<Record<string, number>> {
  await db.query('DELETE FROM pair_diff WHERE dataset_id = $1', [datasetId]);

  await db.query(
    `INSERT INTO pair_diff
       (dataset_id, account_a, account_b, status, p1_count, p2_count, p1_amount, p2_amount, volume_delta)
     SELECT
       $1,
       COALESCE(p1.account_a, p2.account_a),
       COALESCE(p1.account_b, p2.account_b),
       CASE
         WHEN COALESCE(p1.count, 0) = 0 THEN 'NEW'::pair_status
         WHEN COALESCE(p2.count, 0) = 0 THEN 'VANISHED'::pair_status
         WHEN ABS((p2.total_amount - p1.total_amount) / NULLIF(p1.total_amount, 0)) > $2 THEN 'SHIFTED'::pair_status
         ELSE 'STABLE'::pair_status
       END,
       COALESCE(p1.count, 0),
       COALESCE(p2.count, 0),
       COALESCE(p1.total_amount, 0),
       COALESCE(p2.total_amount, 0),
       CASE WHEN COALESCE(p1.total_amount, 0) = 0 THEN NULL
            ELSE (p2.total_amount - p1.total_amount) / p1.total_amount END
     FROM (SELECT * FROM pairs WHERE dataset_id = $1 AND period = 'P1') p1
     FULL OUTER JOIN (SELECT * FROM pairs WHERE dataset_id = $1 AND period = 'P2') p2
       ON p1.account_a = p2.account_a AND p1.account_b = p2.account_b`,
    [datasetId, config.diff.shiftedTolerance],
  );

  const { rows } = await db.query<{ status: string; n: string }>(
    `SELECT status::text, COUNT(*)::text AS n
     FROM pair_diff WHERE dataset_id = $1 GROUP BY status`,
    [datasetId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}
