const businessId = import.meta.env.VITE_BUSINESS_ID ?? 'meridian';
const base = `/api/businesses/${businessId}`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? 'unknown', body.message ?? res.statusText);
  }
  return res.json();
}

const get = <T,>(path: string) => request<T>(path);
const send = <T,>(method: 'POST' | 'PATCH', path: string, body: unknown) =>
  request<T>(path, { method, body: JSON.stringify(body) });

export type Conclusion =
  | 'appropriate-recurring'
  | 'appropriate-adjustment'
  | 'appropriate-other'
  | 'requires-procedures'
  | 'set-aside';

export const conclusionLabels: Record<Conclusion, string> = {
  'appropriate-recurring': 'Appropriate, recurring',
  'appropriate-adjustment': 'Appropriate, adjustment',
  'appropriate-other': 'Appropriate, other',
  'requires-procedures': 'Requires further procedures',
  'set-aside': 'Set aside',
};

export interface SupersededDecision {
  decisionId: string;
  conclusion: Conclusion;
  basis: string;
  recordedBy: string | null;
  recordedAt: string;
  supersededAt: string;
  reason: string;
}

export interface Decision {
  decisionId: string;
  conclusion: Conclusion;
  basis: string;
  recordedBy: string | null;
  recordedAt: string;
}

export interface QueueItem {
  groupId: string;
  kind: 'group' | 'deviation' | 'individual';
  accountA: string;
  accountB: string;
  entryCount: number;
  entryIds: string[];
  rulesFired: string[];
  consistency: { score: number; detail: string[] };
  recurrence: { label: string; months: string[] };
  reviewStatus: 'open' | 'reviewed';
  parentGroupId: string | null;
  decision: Decision | null;
  supersededDecisions: SupersededDecision[];
}

export interface Queue {
  summary: { totalFlagged: number };
  items: QueueItem[];
}

/**
 * Not a superset of QueueItem: the detail endpoint omits `recurrence` and
 * `rulesFired`, which the list already carries, so the workbench reads those
 * from the selected item rather than refetching them.
 */
export interface GroupSheet {
  groupId: string;
  kind: QueueItem['kind'];
  accountA: string;
  accountB: string;
  entryCount: number;
  entryIds: string[];
  consistency: { score: number; detail: string[] };
  groupingBasis: { pair: string; detail: string[] };
  procedures: Array<{ label: string; done: number; total: number }>;
  excludedDeviations: Array<{ entryId: string; reasons: string[] }>;
  reviewStatus: QueueItem['reviewStatus'];
  decision: Decision | null;
  supersededDecisions: SupersededDecision[];
  canConclude: boolean;
}

export type Pipeline = Record<'ingested' | 'projected' | 'scored' | 'investigated' | 'grouped', boolean>;

export interface Period {
  period: string;
  entries: number;
  lines: number;
  tied: boolean;
}

export interface Exception {
  account: string;
  period: string;
  deltaCents: number;
  entryCount: number;
}

export interface LoadedStatus {
  dataset: string;
  pipeline: Pipeline;
  periods: Period[];
  exceptions: Exception[];
  grossDeltaCents: number;
  canConclude: boolean;
  override: { reason: string; at: string | null } | null;
}

/** A dataset that loaded, whether or not it ties. */
export type Loaded =
  | ({ status: 'reconciled' } & LoadedStatus)
  | ({ status: 'unreconciled' } & LoadedStatus);

export type Status = { status: 'empty' } | { status: 'load_failed'; dataset: string } | Loaded;

/** Amounts are integer cents everywhere except the graph. */
export interface EntryRow {
  entryId: string;
  period: string;
  effectiveDate: string;
  postedAt: string;
  user: string;
  lineCount: number;
  totalAmount: number;
  composite: number;
  rulesFired: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  rootType: string;
  volume: number;
}

export type GraphMode = 'diff' | 'p1' | 'p2';
export type EdgeStatus = 'NEW' | 'SHIFTED' | 'VANISHED' | 'STABLE';

interface EdgeEnds {
  id: string;
  source: string;
  target: string;
}

/** The diff carries how a pair changed; a single period carries only its weight. */
export interface DiffEdge extends EdgeEnds {
  status: EdgeStatus;
  p1Count: number;
  p2Count: number;
  volumeDelta: number;
}

export interface PeriodEdge extends EdgeEnds {
  count: number;
  totalAmount: number;
  rarity: number;
}

export type Graph =
  | { mode: 'diff'; nodes: GraphNode[]; edges: DiffEdge[] }
  | { mode: 'p1' | 'p2'; nodes: GraphNode[]; edges: PeriodEdge[] };

export interface Profile {
  entrySizeHistogram: Array<{ period: string; lines: number; count: number }>;
  byMonth: Array<{ month: string; entries: number; lines: number }>;
  topAccounts: Array<{ account: string; name: string; totalAmount: number; lineCount: number }>;
  flagCounts: Array<{ rule: string; group: string; count: number }>;
}

export const fetchStatus = () => get<Status>('/status');
export const fetchGraph = (mode: GraphMode) => get<Graph>(`/graph?mode=${mode}`);
export const fetchProfile = () => get<Profile>('/profile');
export const fetchQueue = () => get<Queue>('/queue');
export const fetchGroup = (groupId: string) => get<GroupSheet>(`/queue/${groupId}`);

/**
 * The group sheet returns bare entry ids, so member detail comes from the entry
 * list filtered to one of the pair's accounts. That is a superset of the group.
 */
export const fetchEntriesForAccount = (account: string) =>
  get<{ rows: EntryRow[] }>(`/entries?account=${encodeURIComponent(account)}&limit=500`);

export interface EntryLine {
  lineId: string;
  lineNo: number;
  account: string;
  debit: number;
  credit: number;
  costCenter: string | null;
  memo: string | null;
}

export interface EntryDetail {
  entry: {
    entryId: string;
    period: string;
    effectiveDate: string;
    postedAt: string;
    user: string;
    source: string;
    narration: string | null;
    lineCount: number;
    totalAmount: number;
  };
  lines: EntryLine[];
  scores: Array<{ rule: string; score: number; inputs: Record<string, unknown> }>;
  composite: number;
  isDeviation: boolean;
}

export interface Citation {
  kind: 'entry' | 'line';
  ref: string;
}

export interface CaseFile {
  engine: {
    rules: Array<{ rule: string; group: string; score: number; inputs: Record<string, unknown>; weight: number }>;
    composite: number;
  };
  agent: {
    plan: Array<{ step: number; tool: string; reason: string; executed: boolean }>;
    findings: Array<{ text: string; citations: Citation[] }>;
  };
  verifier: { status: string; failures: unknown[]; checkedCitations: number };
  model: string;
}

export const fetchEntry = (entryId: string) => get<EntryDetail>(`/entries/${entryId}`);

/** An entry that was never investigated has no case file, which is not an error. */
export async function fetchCase(entryId: string): Promise<CaseFile | null> {
  try {
    return await get<CaseFile>(`/cases/${entryId}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export const reinvestigateEntry = (entryId: string) =>
  send<CaseFile>('POST', `/cases/${entryId}/reinvestigate`, { force: true });

export const updateMembers = (groupId: string, change: { add?: string[]; remove?: string[] }) =>
  send<{ group: GroupSheet; superseded: string | null }>('PATCH', `/queue/${groupId}/members`, change);

export const concludeGroup = (
  groupId: string,
  body: { conclusion: Conclusion; basis: string; entryIds: string[] },
) => send<{ decisionId: string }>('POST', `/decisions/group/${groupId}`, body);

/** Reopening supersedes the decision without replacing it, so the item goes back to open. */
export const reopenDecision = (decisionId: string, reason: string) =>
  send<{ decisionId: string }>('POST', `/decisions/${decisionId}/reopen`, { reason });

export const concludeEntry = (
  entryId: string,
  body: { conclusion: Conclusion; basis: string },
) => send<{ decisionId: string }>('POST', `/decisions/entry/${entryId}`, body);

/**
 * Accounts arrive as full ledger names ("5211 - Print and Stationery - MTC").
 * The worklist only has room for the code, and auditors read codes anyway; the
 * full names stay available for the workbench header.
 */
export function accountCode(account: string): string {
  return account.split(' - ')[0] ?? account;
}

/** The queue's `pair` field embeds a literal arrow, so compose the label instead. */
export function pairLabel(item: Pick<QueueItem, 'accountA' | 'accountB'>): string {
  return `${accountCode(item.accountA)} / ${accountCode(item.accountB)}`;
}

export function pairNames(item: Pick<QueueItem, 'accountA' | 'accountB'>): string {
  return `${accountName(item.accountA)} / ${accountName(item.accountB)}`;
}

function accountName(account: string): string {
  const parts = account.split(' - ');
  return parts.length > 1 ? parts[1]! : account;
}

/** Graph edges and queue items name the same accounts, in either order. */
export function isPair(item: Pick<QueueItem, 'accountA' | 'accountB'>, pair: [string, string]) {
  return (
    (item.accountA === pair[0] && item.accountB === pair[1]) ||
    (item.accountA === pair[1] && item.accountB === pair[0])
  );
}

export type ItemState = 'open' | 'aside' | 'concluded';

export function itemState(item: QueueItem): ItemState {
  if (!item.decision) return 'open';
  return item.decision.conclusion === 'set-aside' ? 'aside' : 'concluded';
}

/**
 * The queue summary counts entries in `totalFlagged` but groups in `reviewed`
 * and `open`, so those three never sum. Entry counts come from the items.
 */
export function entryCounts(items: QueueItem[]) {
  const counts = { open: 0, aside: 0, concluded: 0 };
  for (const item of items) counts[itemState(item)] += item.entryCount;
  return counts;
}
