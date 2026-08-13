import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { PopulationStamp } from '@je-narrower/shared';
import { ApiError, type PopulationContext } from '../dataset.js';
import { withTransaction, type Db } from '../db/client.js';
import { buildPopulationStamp } from '../investigate/entry.js';
import { buildStatus } from '../api/status.js';
import { queryQueueGroup } from '../group/queue.js';

export const CONCLUSIONS = [
  'appropriate-recurring',
  'appropriate-adjustment',
  'appropriate-other',
  'requires-procedures',
  // Parking an item is a decision too: it carries a reason and timestamp, and
  // it can be superseded. Modelling it as a conclusion rather
  // than a fourth review_status keeps the whole reopen/supersede path.
  'set-aside',
] as const;

export type Conclusion = (typeof CONCLUSIONS)[number];

export interface GroupDecisionInput {
  conclusion: Conclusion;
  basis: string;
  recordedBy?: string;
  entryIds: string[];
  excludedDeviations?: string[];
}

export interface EntryDecisionInput {
  conclusion: Conclusion;
  basis: string;
  recordedBy?: string;
}

function newDecisionId(): string {
  return `dec-${randomUUID().slice(0, 8)}`;
}

export async function requireCanConclude(pool: pg.Pool, context: PopulationContext): Promise<void> {
  const status = await buildStatus(pool, context.businessId);
  if (status.status === 'empty' || status.status === 'load_failed') {
    throw new ApiError(404, 'no_dataset', 'no dataset loaded');
  }
  if (!status.canConclude) {
    throw new ApiError(403, 'population_incomplete', 'conclusions require reconciled population or override', {
      grossDeltaCents: status.grossDeltaCents,
    });
  }
}

async function loadGroup(pool: pg.Pool, context: PopulationContext, groupId: string) {
  const { rows } = await pool.query<{
    group_id: string;
    kind: string;
    review_status: string;
    account_a: string;
    account_b: string;
    consistency_detail: string[];
    recurrence: unknown;
    parent_group_id: string | null;
  }>(
    `SELECT group_id, kind, review_status::text, account_a, account_b,
            consistency_detail, recurrence, parent_group_id
     FROM review_groups WHERE dataset_id = $1 AND group_id = $2`,
    [context.datasetId, groupId],
  );
  return rows[0] ?? null;
}

async function loadGroupEntryIds(pool: pg.Pool, context: PopulationContext, groupId: string): Promise<string[]> {
  const { rows } = await pool.query<{ entry_id: string }>(
    `SELECT entry_id FROM group_members WHERE dataset_id = $1 AND group_id = $2 ORDER BY entry_id`,
    [context.datasetId, groupId],
  );
  return rows.map((r) => r.entry_id);
}

export async function findActiveDecision(pool: Db, context: PopulationContext, targetKind: string, targetId: string) {
  const { rows } = await pool.query<{ decision_id: string; conclusion: string }>(
    `SELECT decision_id, conclusion FROM decisions
     WHERE dataset_id = $1 AND target_kind = $2 AND target_id = $3
     ORDER BY recorded_at DESC, decision_id DESC LIMIT 1`,
    [context.datasetId, targetKind, targetId],
  );
  return rows[0] && rows[0].conclusion !== 'reopened' ? rows[0].decision_id : null;
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

function setsEqual(a: string[], b: string[]): boolean {
  const sa = sorted(a);
  const sb = sorted(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

async function loadDeviationEntryIds(pool: pg.Pool, context: PopulationContext, parentGroupId: string): Promise<string[]> {
  const { rows } = await pool.query<{ entry_id: string }>(
    `SELECT gm.entry_id
     FROM review_groups rg
     JOIN group_members gm ON gm.dataset_id = rg.dataset_id AND gm.group_id = rg.group_id
     WHERE rg.dataset_id = $1 AND rg.parent_group_id = $2`,
    [context.datasetId, parentGroupId],
  );
  return rows.map((r) => r.entry_id);
}

async function buildRulesByEntry(pool: pg.Pool, context: PopulationContext, entryIds: string[]) {
  const { rows } = await pool.query<{ entry_id: string; rule: string; score: string; inputs: unknown }>(
    `SELECT entry_id, rule, score::text, inputs FROM scores
     WHERE dataset_id = $1 AND entry_id = ANY($2::text[])`,
    [context.datasetId, entryIds],
  );
  const byEntry: Record<string, Array<{ rule: string; score: number; inputs: unknown }>> = {};
  for (const row of rows) {
    const list = byEntry[row.entry_id] ?? [];
    list.push({ rule: row.rule, score: Number(row.score), inputs: row.inputs });
    byEntry[row.entry_id] = list;
  }
  return byEntry;
}

async function stampReviewOnEntries(
  pool: pg.Pool,
  context: PopulationContext,
  entryIds: string[],
  note: string,
  populationReconciled: boolean,
) {
  const now = new Date().toISOString();
  const review = {
    status: 'reviewed',
    note,
    reviewedAt: now,
    populationReconciledAtReview: populationReconciled,
  };
  for (const entryId of entryIds) {
    await pool.query(
      `UPDATE cases SET
         review_status = 'reviewed',
         review_note = $3,
         reviewed_at = $4,
         review_population_reconciled = $5,
         case_file = jsonb_set(case_file, '{review}', $6::jsonb)
       WHERE dataset_id = $1 AND entry_id = $2`,
      [context.datasetId, entryId, note, now, populationReconciled, JSON.stringify(review)],
    );
  }
}

async function reopenReviewOnEntries(pool: Db, context: PopulationContext, entryIds: string[]) {
  const review = {
    status: 'open',
    note: null,
    reviewedAt: null,
    populationReconciledAtReview: null,
  };
  for (const entryId of entryIds) {
    await pool.query(
      `UPDATE cases SET
         review_status = 'open',
         review_note = NULL,
         reviewed_at = NULL,
         review_population_reconciled = NULL,
         case_file = jsonb_set(case_file, '{review}', $3::jsonb)
       WHERE dataset_id = $1 AND entry_id = $2`,
      [context.datasetId, entryId, JSON.stringify(review)],
    );
  }
}

export async function recordGroupDecision(
  pool: pg.Pool,
  context: PopulationContext,
  groupId: string,
  input: GroupDecisionInput,
) {
  if (!CONCLUSIONS.includes(input.conclusion)) {
    throw new ApiError(400, 'invalid_request', `invalid conclusion: ${input.conclusion}`);
  }
  if (!input.basis?.trim()) {
    throw new ApiError(400, 'invalid_request', 'basis required');
  }

  await requireCanConclude(pool, context);

  const group = await loadGroup(pool, context, groupId);
  if (!group) throw new ApiError(404, 'not_found', 'group not found');
  if (group.kind !== 'group') {
    throw new ApiError(409, 'invalid_target', 'use entry decision route for deviations and individuals');
  }
  // Concluding again supersedes the prior decision instead of failing. The old
  // record stays queryable; only the pointer moves.
  const supersedes = await findActiveDecision(pool, context, 'group', groupId);

  const memberIds = await loadGroupEntryIds(pool, context, groupId);
  if (!setsEqual(input.entryIds, memberIds)) {
    throw new ApiError(422, 'stale_group', 'entry list does not match current group membership', {
      expected: memberIds,
      received: input.entryIds,
    });
  }

  const deviationIds = await loadDeviationEntryIds(pool, context, groupId);
  const excluded = input.excludedDeviations ?? [];
  for (const id of excluded) {
    if (!deviationIds.includes(id)) {
      throw new ApiError(422, 'stale_group', `excluded deviation not in group: ${id}`, {
        expected: deviationIds,
        received: excluded,
      });
    }
  }

  const sheet = await queryQueueGroup(pool, context, groupId);
  const population = await buildPopulationStamp(pool, context);
  const rulesByEntry = await buildRulesByEntry(pool, context, input.entryIds);
  const procedures = sheet?.procedures ?? [];

  const record = {
    targetKind: 'group' as const,
    targetId: groupId,
    pair: `${group.account_a}↔${group.account_b}`,
    groupingBasis: sheet?.groupingBasis ?? {
      pair: `${group.account_a}↔${group.account_b}`,
      detail: group.consistency_detail,
      recurrence: group.recurrence,
    },
    conclusion: input.conclusion,
    basis: input.basis.trim(),
    recordedBy: input.recordedBy?.trim() || null,
    entryIds: sorted(input.entryIds),
    excludedDeviations: sorted(excluded),
    rulesByEntry,
    procedures,
    supersedes,
  };

  const decisionId = newDecisionId();
  const recordedAt = new Date();

  await pool.query(
    `INSERT INTO decisions
       (dataset_id, decision_id, target_kind, target_id, conclusion, basis, entry_ids, record, population, supersedes_id)
     VALUES ($1, $2, 'group', $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
    [
      context.datasetId,
      decisionId,
      groupId,
      input.conclusion,
      input.basis.trim(),
      JSON.stringify(record.entryIds),
      JSON.stringify(record),
      JSON.stringify(population),
      supersedes,
    ],
  );

  await pool.query(`UPDATE review_groups SET review_status = 'reviewed' WHERE dataset_id = $1 AND group_id = $2`, [context.datasetId, groupId]);
  await stampReviewOnEntries(pool, context, input.entryIds, input.basis.trim(), population.reconciled);

  return {
    decisionId,
    recordedAt: recordedAt.toISOString(),
    population,
    entriesAffected: input.entryIds.length,
  };
}

export async function recordEntryDecision(
  pool: pg.Pool,
  context: PopulationContext,
  entryId: string,
  input: EntryDecisionInput,
) {
  if (!CONCLUSIONS.includes(input.conclusion)) {
    throw new ApiError(400, 'invalid_request', `invalid conclusion: ${input.conclusion}`);
  }
  if (!input.basis?.trim()) {
    throw new ApiError(400, 'invalid_request', 'basis required');
  }

  await requireCanConclude(pool, context);

  const { rows: membership } = await pool.query<{ group_id: string; kind: string; review_status: string }>(
    `SELECT rg.group_id, rg.kind, rg.review_status::text
     FROM group_members gm
     JOIN review_groups rg ON rg.dataset_id = gm.dataset_id AND rg.group_id = gm.group_id
     WHERE gm.dataset_id = $1 AND gm.entry_id = $2`,
    [context.datasetId, entryId],
  );
  const group = membership[0];
  if (!group) throw new ApiError(404, 'not_found', 'entry not in review queue');

  if (group.kind === 'group') {
    const memberIds = await loadGroupEntryIds(pool, context, group.group_id);
    if (memberIds.length > 1) {
      throw new ApiError(409, 'invalid_target', 'multi-entry groups require group decision route', {
        groupId: group.group_id,
      });
    }
  }

  const supersedes = await findActiveDecision(pool, context, 'entry', entryId);

  const population = await buildPopulationStamp(pool, context);
  const rulesByEntry = await buildRulesByEntry(pool, context, [entryId]);

  const record = {
    targetKind: 'entry' as const,
    targetId: entryId,
    groupId: group.group_id,
    groupKind: group.kind,
    conclusion: input.conclusion,
    basis: input.basis.trim(),
    recordedBy: input.recordedBy?.trim() || null,
    entryIds: [entryId],
    rulesByEntry,
    supersedes,
  };

  const decisionId = newDecisionId();
  const recordedAt = new Date();

  await pool.query(
    `INSERT INTO decisions
       (dataset_id, decision_id, target_kind, target_id, conclusion, basis, entry_ids, record, population, supersedes_id)
     VALUES ($1, $2, 'entry', $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
    [
      context.datasetId,
      decisionId,
      entryId,
      input.conclusion,
      input.basis.trim(),
      JSON.stringify([entryId]),
      JSON.stringify(record),
      JSON.stringify(population),
      supersedes,
    ],
  );

  await pool.query(
    `UPDATE review_groups SET review_status = 'reviewed' WHERE dataset_id = $1 AND group_id = $2`,
    [context.datasetId, group.group_id],
  );
  await stampReviewOnEntries(pool, context, [entryId], input.basis.trim(), population.reconciled);

  return {
    decisionId,
    recordedAt: recordedAt.toISOString(),
    population,
    entriesAffected: 1,
  };
}

export async function reopenDecision(
  pool: pg.Pool,
  context: PopulationContext,
  decisionId: string,
  reason: string,
) {
  if (!reason?.trim()) {
    throw new ApiError(400, 'invalid_request', 'reason required');
  }

  const population = await buildPopulationStamp(pool, context);
  return withTransaction(pool, (db) => reopenDecisionRecord(db, context, decisionId, reason, population));
}

async function reopenDecisionRecord(
  pool: Db,
  context: PopulationContext,
  decisionId: string,
  reason: string,
  population: PopulationStamp,
) {
  const prior = await getDecision(pool, context, decisionId);
  if (!prior) throw new ApiError(404, 'not_found', 'decision not found');

  const entryIds = prior.entryIds as string[];

  const record = {
    targetKind: prior.targetKind,
    targetId: prior.targetId,
    conclusion: 'reopened' as const,
    basis: reason.trim(),
    entryIds,
    supersedes: decisionId,
    priorConclusion: prior.conclusion,
  };

  const newId = newDecisionId();
  const recordedAt = new Date();

  await pool.query(
    `INSERT INTO decisions
       (dataset_id, decision_id, target_kind, target_id, conclusion, basis, entry_ids, record, population, supersedes_id)
     VALUES ($1, $2, $3, $4, 'reopened', $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
    [
      context.datasetId,
      newId,
      prior.targetKind,
      prior.targetId,
      reason.trim(),
      JSON.stringify(entryIds),
      JSON.stringify(record),
      JSON.stringify(population),
      decisionId,
    ],
  );

  const targetGroupId =
    prior.targetKind === 'group'
      ? prior.targetId
      : (prior.record as { groupId?: string }).groupId;

  if (targetGroupId) {
    await pool.query(
      `UPDATE review_groups SET review_status = 'open' WHERE dataset_id = $1 AND group_id = $2`,
      [context.datasetId, targetGroupId],
    );
  }

  await reopenReviewOnEntries(pool, context, entryIds);

  return {
    decisionId: newId,
    recordedAt: recordedAt.toISOString(),
    supersedes: decisionId,
    population,
  };
}

export async function supersedeDecision(
  pool: Db,
  context: PopulationContext,
  decisionId: string,
  reason: string,
  population: PopulationStamp,
): Promise<string> {
  return (await reopenDecisionRecord(pool, context, decisionId, reason, population)).decisionId;
}

export async function getDecision(pool: Db, context: PopulationContext, decisionId: string) {
  const { rows } = await pool.query<{
    decision_id: string;
    target_kind: string;
    target_id: string;
    conclusion: string;
    basis: string;
    entry_ids: string[];
    record: Record<string, unknown>;
    population: PopulationStamp;
    recorded_at: Date;
    supersedes_id: string | null;
  }>(`SELECT * FROM decisions WHERE dataset_id = $1 AND decision_id = $2`, [context.datasetId, decisionId]);

  const row = rows[0];
  if (!row) return null;

  return {
    decisionId: row.decision_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    conclusion: row.conclusion,
    basis: row.basis,
    entryIds: row.entry_ids,
    record: row.record,
    population: row.population,
    recordedAt: row.recorded_at.toISOString(),
    supersedesId: row.supersedes_id,
  };
}
