import type { Db } from '../db/client.js';
import { config } from '../config.js';
import type { Period } from '../config.js';
import { pairKey } from '../pair-key.js';
import { toCents } from '../money.js';

export interface RuleEmission {
  entryId: string;
  rule: string;
  score: number;
  inputs: Record<string, unknown>;
}

export async function runScoring(
  db: Db,
  datasetId: string,
): Promise<{ scored: number; byRule: Record<string, number> }> {
  await db.query('DELETE FROM scores WHERE dataset_id = $1', [datasetId]);

  const emissions: RuleEmission[] = [];
  emissions.push(...(await ruleRoundAmount(db, datasetId)));
  emissions.push(...(await ruleDateMismatch(db, datasetId)));
  emissions.push(...(await ruleOffHours(db, datasetId)));
  emissions.push(...(await ruleEntrySizeOutlier(db, datasetId)));
  emissions.push(...(await ruleUnusualUser(db, datasetId)));
  emissions.push(...(await ruleThresholdProximity(db, datasetId)));
  emissions.push(...(await rulePairRarity(db, datasetId)));
  emissions.push(...(await ruleNewPairEmergence(db, datasetId)));

  for (const e of emissions) {
    await db.query(
      `INSERT INTO scores (dataset_id, entry_id, rule, score, inputs) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (dataset_id, entry_id, rule)
       DO UPDATE SET score = EXCLUDED.score, inputs = EXCLUDED.inputs`,
      [datasetId, e.entryId, e.rule, e.score, JSON.stringify(e.inputs)],
    );
  }

  const byRule: Record<string, number> = {};
  for (const e of emissions) {
    byRule[e.rule] = (byRule[e.rule] ?? 0) + 1;
  }

  const { rows } = await db.query<{ n: string }>(
    'SELECT COUNT(DISTINCT entry_id)::text AS n FROM scores WHERE dataset_id = $1',
    [datasetId],
  );
  return { scored: Number(rows[0]?.n ?? 0), byRule };
}

async function ruleRoundAmount(db: Db, datasetId: string): Promise<RuleEmission[]> {
  const mod = config.rules.roundModulusCents;
  const { rows } = await db.query<{ entry_id: string; total_amount: string }>(
    `SELECT entry_id, total_amount::text FROM entries
     WHERE dataset_id = $1
       AND MOD(ROUND(total_amount * 100)::bigint, $2) = 0
       AND ROUND(total_amount * 100)::bigint >= $2`,
    [datasetId, mod],
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    rule: 'round_amount',
    score: 1,
    inputs: { amountCents: toCents(r.total_amount), modulusCents: mod },
  }));
}

async function ruleDateMismatch(db: Db, datasetId: string): Promise<RuleEmission[]> {
  const maxLag = config.rules.dateMismatchMaxLagDays;
  const { rows } = await db.query<{ entry_id: string; posted_at: Date; effective_date: string }>(
    `SELECT entry_id, posted_at, effective_date::text FROM entries
     WHERE dataset_id = $1 AND (posted_at::date - effective_date) > $2`,
    [datasetId, maxLag],
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    rule: 'date_mismatch',
    score: Math.min(1, (daysBetween(r.effective_date, r.posted_at) - maxLag) / 10),
    inputs: {
      postedAt: r.posted_at.toISOString(),
      effectiveDate: r.effective_date,
      lagDays: daysBetween(r.effective_date, r.posted_at),
    },
  }));
}

async function ruleOffHours(db: Db, datasetId: string): Promise<RuleEmission[]> {
  const { offHoursStart: start, offHoursEnd: end } = config.rules;
  const { rows } = await db.query<{ entry_id: string; posted_at: Date }>(
    `SELECT entry_id, posted_at FROM entries
     WHERE dataset_id = $1
       AND (EXTRACT(HOUR FROM posted_at) < $2
         OR EXTRACT(HOUR FROM posted_at) >= $3
         OR EXTRACT(DOW FROM posted_at) IN (0, 6))`,
    [datasetId, start, end],
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    rule: 'off_hours',
    score: 1,
    inputs: {
      postedAt: r.posted_at.toISOString(),
      hour: r.posted_at.getHours(),
      isWeekend: [0, 6].includes(r.posted_at.getDay()),
    },
  }));
}

async function ruleEntrySizeOutlier(db: Db, datasetId: string): Promise<RuleEmission[]> {
  const p = config.rules.entrySizeOutlierPercentile;
  const { rows } = await db.query<{ entry_id: string; line_count: number; period: Period; p99: number }>(
    `WITH bounds AS (
       SELECT period, PERCENTILE_CONT($2) WITHIN GROUP (ORDER BY line_count) AS p99
       FROM entries WHERE dataset_id = $1 GROUP BY period
     )
     SELECT e.entry_id, e.line_count, e.period, b.p99::int
     FROM entries e
     JOIN bounds b ON b.period = e.period
     WHERE e.dataset_id = $1
       AND e.line_count >= b.p99`,
    [datasetId, p],
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    rule: 'entry_size_outlier',
    score: 1,
    inputs: { lineCount: r.line_count, percentile: p, threshold: r.p99 },
  }));
}

async function ruleUnusualUser(db: Db, datasetId: string): Promise<RuleEmission[]> {
  const minN = config.rules.unusualUserMinAccountEntries;
  const maxShare = config.rules.unusualUserMaxShare;
  const { rows } = await db.query<{
    entry_id: string;
    account: string;
    user: string;
    user_count: string;
    account_count: string;
  }>(
    `WITH acct AS (
       SELECT l.account, e.period, e."user", COUNT(DISTINCT e.entry_id)::float AS user_count
       FROM lines l
       JOIN entries e ON e.dataset_id = l.dataset_id AND e.entry_id = l.entry_id
       WHERE l.dataset_id = $1
       GROUP BY l.account, e.period, e."user"
     ),
     totals AS (
       SELECT account, period, SUM(user_count)::float AS account_count FROM acct GROUP BY account, period
     ),
     flagged AS (
       SELECT a.account, a.period, a."user", a.user_count, t.account_count
       FROM acct a
       JOIN totals t ON t.account = a.account AND t.period = a.period
       WHERE t.account_count >= $2 AND (a.user_count / t.account_count) < $3
     )
     SELECT DISTINCT e.entry_id, f.account, e."user", f.user_count::text, f.account_count::text
     FROM flagged f
     JOIN lines l ON l.dataset_id = $1 AND l.account = f.account
     JOIN entries e ON e.dataset_id = l.dataset_id AND e.entry_id = l.entry_id
                   AND e.period = f.period AND e."user" = f."user"`,
    [datasetId, minN, maxShare],
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    rule: 'unusual_user',
    score: 1,
    inputs: {
      account: r.account,
      user: r.user,
      userCount: Number(r.user_count),
      accountCount: Number(r.account_count),
      share: Number(r.user_count) / Number(r.account_count),
    },
  }));
}

async function ruleThresholdProximity(db: Db, datasetId: string): Promise<RuleEmission[]> {
  const out: RuleEmission[] = [];
  const { rows } = await db.query<{ entry_id: string; total_amount: string }>(
    `SELECT entry_id, total_amount::text FROM entries WHERE dataset_id = $1`,
    [datasetId],
  );
  for (const r of rows) {
    const cents = toCents(r.total_amount);
    for (const boundary of config.rules.thresholdBoundariesCents) {
      if (cents >= boundary) continue;
      const gap = boundary - cents;
      const gapPct = gap / boundary;
      if (gapPct <= config.rules.thresholdProximityPct) {
        out.push({
          entryId: r.entry_id,
          rule: 'threshold_proximity',
          score: 1 - gapPct / config.rules.thresholdProximityPct,
          inputs: { amountCents: cents, boundaryCents: boundary, gapPct },
        });
        break;
      }
    }
  }
  return out;
}

async function rulePairRarity(db: Db, datasetId: string): Promise<RuleEmission[]> {
  const out: RuleEmission[] = [];
  const { rows: entries } = await db.query<{ entry_id: string; period: Period }>(
    `SELECT entry_id, period FROM entries WHERE dataset_id = $1`,
    [datasetId],
  );
  for (const entry of entries) {
    const min = await rarestPairCount(db, datasetId, entry.entry_id, entry.period);
    if (min && min.count > 0) {
      out.push({
        entryId: entry.entry_id,
        rule: 'pair_rarity',
        score: Math.min(1, 1 / min.count),
        inputs: { pair: `${min.account_a}↔${min.account_b}`, count: min.count, period: entry.period },
      });
    }
  }
  return out;
}

async function ruleNewPairEmergence(db: Db, datasetId: string): Promise<RuleEmission[]> {
  const out: RuleEmission[] = [];
  const { rows: entries } = await db.query<{ entry_id: string }>(
    `SELECT entry_id FROM entries WHERE dataset_id = $1 AND period = 'P2'`,
    [datasetId],
  );
  for (const entry of entries) {
    const pairs = await entryPairs(db, datasetId, entry.entry_id);
    let best: { score: number; inputs: Record<string, unknown> } | null = null;
    for (const [a, b] of pairs) {
      const { rows } = await db.query<{
        status: string;
        p1_count: number;
        p2_count: number;
        volume_delta: string | null;
      }>(
        `SELECT status::text, p1_count, p2_count, volume_delta::text
         FROM pair_diff
         WHERE dataset_id = $1 AND account_a = $2 AND account_b = $3`,
        [datasetId, a, b],
      );
      const diff = rows[0];
      if (!diff) continue;
      let score = 0;
      if (diff.status === 'NEW') score = 1;
      else if (diff.status === 'SHIFTED') score = Math.min(0.5, Math.abs(Number(diff.volume_delta ?? 0)));
      else continue;
      if (!best || score > best.score) {
        best = {
          score,
          inputs: {
            pair: `${a}↔${b}`,
            status: diff.status,
            p1Count: diff.p1_count,
            p2Count: diff.p2_count,
            volumeDelta: diff.volume_delta ? Number(diff.volume_delta) : null,
          },
        };
      }
    }
    if (best) {
      out.push({ entryId: entry.entry_id, rule: 'new_pair_emergence', score: best.score, inputs: best.inputs });
    }
  }
  return out;
}

async function rarestPairCount(db: Db, datasetId: string, entryId: string, period: Period) {
  const pairs = await entryPairs(db, datasetId, entryId);
  let best: { account_a: string; account_b: string; count: number } | null = null;
  for (const [a, b] of pairs) {
    const { rows } = await db.query<{ count: number }>(
      `SELECT count FROM pairs
       WHERE dataset_id = $1 AND period = $2 AND account_a = $3 AND account_b = $4`,
      [datasetId, period, a, b],
    );
    const count = rows[0]?.count ?? 0;
    if (!best || count < best.count) best = { account_a: a, account_b: b, count };
  }
  return best;
}

async function entryPairs(db: Db, datasetId: string, entryId: string): Promise<[string, string][]> {
  const { rows: lines } = await db.query<{ account: string; debit: string; credit: string }>(
    `SELECT account, debit::text, credit::text
     FROM lines WHERE dataset_id = $1 AND entry_id = $2`,
    [datasetId, entryId],
  );
  const debits = new Set<string>();
  const credits = new Set<string>();
  for (const l of lines) {
    if (toCents(l.debit) > 0) debits.add(l.account);
    if (toCents(l.credit) > 0) credits.add(l.account);
  }
  const pairs: [string, string][] = [];
  for (const d of debits) {
    for (const c of credits) {
      pairs.push(pairKey(d, c));
    }
  }
  return pairs;
}

function daysBetween(dateStr: string, posted: Date): number {
  const eff = new Date(`${dateStr}T00:00:00`);
  const post = new Date(posted.toISOString().slice(0, 10) + 'T00:00:00');
  return Math.round((post.getTime() - eff.getTime()) / 86_400_000);
}

export async function countFlagged(db: Db, datasetId: string): Promise<number> {
  const sql = compositeSqlSubquery('$1');
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (${sql}) sub WHERE composite >= $2`,
    [datasetId, config.scoring.flagThreshold],
  );
  return Number(rows[0]?.n ?? 0);
}

function compositeSqlSubquery(datasetPlaceholder: string): string {
  const weights = config.composite.weights as Record<string, number>;
  const sumW = Object.values(weights).reduce((a, b) => a + b, 0);
  const parts = Object.entries(weights).map(
    ([rule, w]) => `COALESCE(MAX(CASE WHEN rule = '${rule}' THEN score END), 0) * ${w}`,
  );
  return `SELECT dataset_id, entry_id, (${parts.join(' + ')}) / ${sumW} AS composite
          FROM scores WHERE dataset_id = ${datasetPlaceholder} GROUP BY dataset_id, entry_id`;
}

export { compositeSqlSubquery as compositeSubquery };
