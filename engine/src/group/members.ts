import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError, type PopulationContext } from '../dataset.js';
import { withTransaction, type Db } from '../db/client.js';
import { findActiveDecision, supersedeDecision } from '../decisions/record.js';
import { buildPopulationStamp } from '../investigate/entry.js';
import { loadFlaggedEntries } from './build.js';
import { computeConsistency, deviationReasons, median, modeUser } from './consistency.js';
import { buildRecurrence } from './recurrence.js';
import { queryQueueGroup } from './queue.js';
import type { FlaggedEntry } from './types.js';

export interface MemberChange {
  add?: string[];
  remove?: string[];
}

interface GroupRow {
  group_id: string;
  kind: string;
  review_status: string;
  account_a: string;
  account_b: string;
}

interface SourceMembership {
  entry_id: string;
  group_id: string;
  kind: string;
}

/**
 * Edit a group without losing removed entries or decision history. The complete
 * membership change, recomputation, and supersession is one transaction.
 */
export async function updateGroupMembers(
  pool: pg.Pool,
  context: PopulationContext,
  groupId: string,
  change: MemberChange,
) {
  const add = unique(change.add ?? []);
  const remove = unique(change.remove ?? []);
  if (add.length === 0 && remove.length === 0) {
    throw new ApiError(400, 'invalid_request', 'add or remove required');
  }

  const overlap = add.filter((entryId) => remove.includes(entryId));
  if (overlap.length) {
    throw new ApiError(400, 'invalid_request', 'an entry cannot be added and removed together', { entryIds: overlap });
  }

  const population = await buildPopulationStamp(pool, context);
  const result = await withTransaction(pool, async (db) => {
    const group = await loadGroup(db, context, groupId, true);
    if (!group) throw new ApiError(404, 'not_found', 'group not found');
    if (group.kind !== 'group') {
      throw new ApiError(409, 'invalid_target', 'membership editing is only supported for groups');
    }

    const current = await memberIds(db, context, groupId, true);
    for (const entryId of remove) {
      if (!current.includes(entryId)) {
        throw new ApiError(422, 'stale_group', `entry not in group: ${entryId}`, { expected: current });
      }
    }

    const effectiveAdd = add.filter((entryId) => !current.includes(entryId));
    const next = current.filter((entryId) => !remove.includes(entryId)).concat(effectiveAdd);
    if (next.length === 0) {
      throw new ApiError(422, 'invalid_request', 'a group cannot be emptied; delete is not supported');
    }

    const sources = await sourceMemberships(db, context, groupId, effectiveAdd);
    validateSources(effectiveAdd, sources);

    const requestedEntries = unique([...next, ...remove]);
    const entries = await loadFlaggedEntries(db, context, requestedEntries);
    const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
    const missing = requestedEntries.filter((entryId) => !byId.has(entryId));
    if (missing.length) {
      throw new ApiError(422, 'invalid_request', 'all members must be flagged entries', { entryIds: missing });
    }

    const wrongPair = effectiveAdd.filter((entryId) => {
      const entry = byId.get(entryId)!;
      return entry.accountA !== group.account_a || entry.accountB !== group.account_b;
    });
    if (wrongPair.length) {
      throw new ApiError(422, 'invalid_request', 'added entries must have the same account pair as the group', {
        pair: `${group.account_a}↔${group.account_b}`,
        entryIds: wrongPair,
      });
    }

    await removeMembers(db, context, groupId, remove);
    await moveMembers(db, context, groupId, effectiveAdd);

    const nextEntries = next.map((entryId) => byId.get(entryId)!);
    await recompute(db, context, groupId, nextEntries);
    for (const entryId of remove) {
      await promoteToIndividual(db, context, byId.get(entryId)!, groupId, nextEntries);
    }

    const reason = membershipReason(effectiveAdd, remove);
    const supersededDecisions: string[] = [];
    const targetDecision = await findActiveDecision(db, context, 'group', groupId);
    if (targetDecision) {
      supersededDecisions.push(targetDecision);
      await supersedeDecision(db, context, targetDecision, reason, population);
    }

    for (const entryId of effectiveAdd) {
      const sourceDecision = await findActiveDecision(db, context, 'entry', entryId);
      if (!sourceDecision) continue;
      supersededDecisions.push(sourceDecision);
      await supersedeDecision(db, context, sourceDecision, reason, population);
    }

    await db.query(
      `UPDATE review_groups SET review_status = 'open' WHERE dataset_id = $1 AND group_id = $2`,
      [context.datasetId, groupId],
    );
    await deleteEmptySources(db, context, sources);

    return { superseded: targetDecision, supersededDecisions };
  });

  return { group: await queryQueueGroup(pool, context, groupId), ...result };
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function validateSources(entryIds: string[], sources: SourceMembership[]): void {
  for (const entryId of entryIds) {
    const memberships = sources.filter((source) => source.entry_id === entryId);
    if (memberships.length > 1) {
      throw new ApiError(409, 'ambiguous_membership', `entry belongs to multiple queue items: ${entryId}`);
    }
    if (memberships[0]?.kind === 'group') {
      throw new ApiError(409, 'invalid_target', `remove entry from its current group before adding it: ${entryId}`, {
        groupId: memberships[0].group_id,
      });
    }
  }
}

function membershipReason(add: string[], remove: string[]): string {
  const parts: string[] = [];
  if (remove.length) parts.push(`removed ${remove.join(', ')}`);
  if (add.length) parts.push(`added ${add.join(', ')}`);
  return `membership changed: ${parts.join('; ')}`;
}

async function removeMembers(db: Db, context: PopulationContext, groupId: string, remove: string[]) {
  if (remove.length === 0) return;
  await db.query(
    `DELETE FROM group_members WHERE dataset_id = $1 AND group_id = $2 AND entry_id = ANY($3::text[])`,
    [context.datasetId, groupId, remove],
  );
}

async function moveMembers(db: Db, context: PopulationContext, groupId: string, add: string[]) {
  if (add.length === 0) return;
  await db.query(
    `DELETE FROM group_members WHERE dataset_id = $1 AND group_id <> $2 AND entry_id = ANY($3::text[])`,
    [context.datasetId, groupId, add],
  );
  await db.query(
    `INSERT INTO group_members (dataset_id, group_id, entry_id, is_deviation)
     SELECT $1, $2, entry_id, false FROM unnest($3::text[]) AS entry_id
     ON CONFLICT DO NOTHING`,
    [context.datasetId, groupId, add],
  );
}

async function recompute(db: Db, context: PopulationContext, groupId: string, entries: FlaggedEntry[]) {
  const consistency = computeConsistency(entries);
  const recurrence = buildRecurrence(entries);
  await db.query(
    `UPDATE review_groups
     SET consistency_score = $3, consistency_detail = $4::jsonb, recurrence = $5::jsonb
     WHERE dataset_id = $1 AND group_id = $2`,
    [
      context.datasetId,
      groupId,
      consistency.score,
      JSON.stringify(consistency.detail),
      JSON.stringify(recurrence),
    ],
  );
}

async function promoteToIndividual(
  db: Db,
  context: PopulationContext,
  entry: FlaggedEntry,
  fromGroupId: string,
  siblings: FlaggedEntry[],
) {
  const reasons = deviationReasons(
    entry,
    median(siblings.map((sibling) => sibling.amountCents)),
    modeUser(siblings),
  );
  const newId = `grp-${randomUUID().slice(0, 8)}`;

  await db.query(
    `INSERT INTO review_groups
       (dataset_id, group_id, kind, account_a, account_b, consistency_score, consistency_detail, recurrence, parent_group_id)
     VALUES ($1, $2, 'individual', $3, $4, 0, $5::jsonb, $6::jsonb, $7)`,
    [
      context.datasetId,
      newId,
      entry.accountA,
      entry.accountB,
      JSON.stringify(reasons.map((reason) => `deviates: ${reason}`)),
      JSON.stringify(buildRecurrence([entry])),
      fromGroupId,
    ],
  );
  await db.query(
    `INSERT INTO group_members (dataset_id, group_id, entry_id, is_deviation) VALUES ($1, $2, $3, false)`,
    [context.datasetId, newId, entry.entryId],
  );
}

async function deleteEmptySources(db: Db, context: PopulationContext, sources: SourceMembership[]) {
  const groupIds = unique(sources.map((source) => source.group_id));
  if (groupIds.length === 0) return;
  await db.query(
    `DELETE FROM review_groups rg
     WHERE rg.dataset_id = $1 AND rg.group_id = ANY($2::text[])
       AND rg.kind IN ('individual', 'deviation')
       AND NOT EXISTS (
         SELECT 1 FROM group_members gm
         WHERE gm.dataset_id = rg.dataset_id AND gm.group_id = rg.group_id
       )`,
    [context.datasetId, groupIds],
  );
}

async function sourceMemberships(
  db: Db,
  context: PopulationContext,
  targetGroupId: string,
  entryIds: string[],
): Promise<SourceMembership[]> {
  if (entryIds.length === 0) return [];
  const { rows } = await db.query<SourceMembership>(
    `SELECT gm.entry_id, gm.group_id, rg.kind
     FROM group_members gm
     JOIN review_groups rg ON rg.dataset_id = gm.dataset_id AND rg.group_id = gm.group_id
     WHERE gm.dataset_id = $1 AND gm.group_id <> $2 AND gm.entry_id = ANY($3::text[])
     FOR UPDATE OF gm, rg`,
    [context.datasetId, targetGroupId, entryIds],
  );
  return rows;
}

async function memberIds(
  db: Db,
  context: PopulationContext,
  groupId: string,
  lock = false,
): Promise<string[]> {
  const { rows } = await db.query<{ entry_id: string }>(
    `SELECT entry_id FROM group_members
     WHERE dataset_id = $1 AND group_id = $2 ORDER BY entry_id${lock ? ' FOR UPDATE' : ''}`,
    [context.datasetId, groupId],
  );
  return rows.map((row) => row.entry_id);
}

async function loadGroup(
  db: Db,
  context: PopulationContext,
  groupId: string,
  lock = false,
): Promise<GroupRow | null> {
  const { rows } = await db.query<GroupRow>(
    `SELECT group_id, kind, review_status::text, account_a, account_b
     FROM review_groups WHERE dataset_id = $1 AND group_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [context.datasetId, groupId],
  );
  return rows[0] ?? null;
}
