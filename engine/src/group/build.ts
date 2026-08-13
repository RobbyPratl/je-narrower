import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import { pairKey } from '../pair-key.js';
import { compositeSubquery } from '../scoring/run.js';
import { updatePipeline } from '../dataset.js';
import type { PopulationContext } from '../dataset.js';
import { computeConsistency } from './consistency.js';
import { splitDeviations } from './deviations.js';
import { buildRecurrence } from './recurrence.js';
import type { FlaggedEntry, GroupBuildResult } from './types.js';

function newGroupId(): string {
  return `grp-${randomUUID().slice(0, 8)}`;
}

export async function loadFlaggedEntries(
  pool: Db,
  context: PopulationContext,
  entryIds?: string[],
): Promise<FlaggedEntry[]> {
  const sql = compositeSubquery('$1');
  const { rows } = await pool.query<{
    entry_id: string;
    period: string;
    user: string;
    total_amount: string;
    line_count: number;
    effective_date: string;
    posted_at: Date;
    narration: string | null;
    rules_fired: string[];
  }>(
    `WITH composite AS (${sql})
     SELECT e.entry_id, e.period::text, e."user", e.total_amount::text, e.line_count,
            e.effective_date::text, e.posted_at, e.narration,
            COALESCE((SELECT array_agg(DISTINCT s.rule) FROM scores s
                      WHERE s.dataset_id = e.dataset_id AND s.entry_id = e.entry_id), '{}') AS rules_fired
     FROM entries e
     JOIN composite c ON c.dataset_id = e.dataset_id AND c.entry_id = e.entry_id
     WHERE e.dataset_id = $1 AND c.composite >= $2
       ${entryIds ? 'AND e.entry_id = ANY($3)' : ''}`,
    entryIds
      ? [context.datasetId, config.scoring.flagThreshold, entryIds]
      : [context.datasetId, config.scoring.flagThreshold],
  );

  const entries: FlaggedEntry[] = [];
  for (const row of rows) {
    const pair = await primaryPair(pool, context, row.entry_id, row.period);
    if (!pair) continue;
    entries.push({
      entryId: row.entry_id,
      period: row.period,
      user: row.user,
      amountCents: Math.round(parseFloat(row.total_amount) * 100),
      lineCount: row.line_count,
      effectiveDate: row.effective_date,
      postedAt: row.posted_at,
      narration: row.narration,
      rulesFired: row.rules_fired,
      accountA: pair[0],
      accountB: pair[1],
    });
  }
  return entries;
}

async function primaryPair(
  pool: Db,
  context: PopulationContext,
  entryId: string,
  period: string,
): Promise<[string, string] | null> {
  const { rows } = await pool.query<{ inputs: { pair?: string } }>(
    `SELECT inputs FROM scores
     WHERE dataset_id = $1 AND entry_id = $2 AND rule IN ('pair_rarity', 'new_pair_emergence')
     ORDER BY CASE rule WHEN 'new_pair_emergence' THEN 0 ELSE 1 END`,
    [context.datasetId, entryId],
  );
  for (const row of rows) {
    const pair = row.inputs?.pair;
    if (!pair) continue;
    const parts = pair.split('↔');
    if (parts.length === 2) return pairKey(parts[0]!, parts[1]!);
  }

  const { rows: lines } = await pool.query<{ account: string; debit: string; credit: string }>(
    `SELECT account, debit::text, credit::text FROM lines WHERE dataset_id = $1 AND entry_id = $2`,
    [context.datasetId, entryId],
  );
  const debits = lines.filter((l) => parseFloat(l.debit) > 0).map((l) => l.account);
  const credits = lines.filter((l) => parseFloat(l.credit) > 0).map((l) => l.account);
  if (debits.length === 0 || credits.length === 0) return null;

  let best: [string, string] | null = null;
  let bestCount = Infinity;
  for (const d of debits) {
    for (const c of credits) {
      if (d === c) continue;
      const [a, b] = pairKey(d, c);
      const { rows: counts } = await pool.query<{ count: number }>(
        `SELECT count FROM pairs WHERE dataset_id = $1 AND period = $2 AND account_a = $3 AND account_b = $4`,
        [context.datasetId, period, a, b],
      );
      const count = counts[0]?.count ?? 0;
      if (count < bestCount) {
        bestCount = count;
        best = [a, b];
      }
    }
  }
  if (best) return best;
  return pairKey(debits[0]!, credits[0]!);
}

function pairLabel(a: string, b: string): string {
  return `${a}↔${b}`;
}

export async function runGrouping(pool: pg.Pool, context: PopulationContext): Promise<GroupBuildResult> {
  await pool.query('DELETE FROM group_members WHERE dataset_id = $1', [context.datasetId]);
  await pool.query('DELETE FROM review_groups WHERE dataset_id = $1', [context.datasetId]);

  const flagged = await loadFlaggedEntries(pool, context);
  const buckets = new Map<string, FlaggedEntry[]>();

  for (const entry of flagged) {
    const key = pairLabel(entry.accountA, entry.accountB);
    const list = buckets.get(key) ?? [];
    list.push(entry);
    buckets.set(key, list);
  }

  let groups = 0;
  let deviations = 0;
  let individuals = 0;

  for (const [, cluster] of buckets) {
    if (cluster.length < config.group.minGroupSize) {
      for (const entry of cluster) {
        await writeIndividual(pool, context, entry);
        individuals++;
      }
      continue;
    }

    const { members, deviations: devs } = splitDeviations(cluster);
    if (members.length === 0) {
      for (const { entry } of devs) {
        await writeIndividual(pool, context, entry);
        individuals++;
      }
      continue;
    }

    const consistency = computeConsistency(members);
    const recurrence = buildRecurrence(members);
    const groupId = newGroupId();

    await pool.query(
      `INSERT INTO review_groups
         (dataset_id, group_id, kind, account_a, account_b, consistency_score, consistency_detail, recurrence)
       VALUES ($1, $2, 'group', $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        context.datasetId,
        groupId,
        members[0]!.accountA,
        members[0]!.accountB,
        consistency.score,
        JSON.stringify(consistency.detail),
        JSON.stringify(recurrence),
      ],
    );

    for (const entry of members) {
      await pool.query(
        `INSERT INTO group_members (dataset_id, group_id, entry_id, is_deviation) VALUES ($1, $2, $3, false)`,
        [context.datasetId, groupId, entry.entryId],
      );
    }
    groups++;

    for (const { entry, reasons } of devs) {
      const devId = newGroupId();
      await pool.query(
        `INSERT INTO review_groups
           (dataset_id, group_id, kind, account_a, account_b, consistency_score, consistency_detail, recurrence, parent_group_id)
         VALUES ($1, $2, 'deviation', $3, $4, 0, $5::jsonb, $6::jsonb, $7)`,
        [
          context.datasetId,
          devId,
          entry.accountA,
          entry.accountB,
          JSON.stringify(reasons.map((r) => `deviates: ${r}`)),
          JSON.stringify(buildRecurrence([entry])),
          groupId,
        ],
      );
      await pool.query(
        `INSERT INTO group_members (dataset_id, group_id, entry_id, is_deviation) VALUES ($1, $2, $3, true)`,
        [context.datasetId, devId, entry.entryId],
      );
      deviations++;
    }
  }

  await updatePipeline(pool, context, { grouped: true });

  return {
    groups,
    deviations,
    individuals,
    totalFlagged: flagged.length,
  };
}

async function writeIndividual(pool: pg.Pool, context: PopulationContext, entry: FlaggedEntry) {
  const groupId = newGroupId();
  const consistency = computeConsistency([entry]);
  await pool.query(
    `INSERT INTO review_groups
       (dataset_id, group_id, kind, account_a, account_b, consistency_score, consistency_detail, recurrence)
     VALUES ($1, $2, 'individual', $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      context.datasetId,
      groupId,
      entry.accountA,
      entry.accountB,
      consistency.score,
      JSON.stringify(consistency.detail),
      JSON.stringify(buildRecurrence([entry])),
    ],
  );
  await pool.query(
    `INSERT INTO group_members (dataset_id, group_id, entry_id, is_deviation) VALUES ($1, $2, $3, false)`,
    [context.datasetId, groupId, entry.entryId],
  );
}
