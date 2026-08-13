import { config } from '../config.js';
import type { ConsistencyResult, FlaggedEntry } from './types.js';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

function modeUser(entries: FlaggedEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.user, (counts.get(e.user) ?? 0) + 1);
  let best = entries[0]?.user ?? '';
  let bestN = 0;
  for (const [user, n] of counts) {
    if (n > bestN) {
      best = user;
      bestN = n;
    }
  }
  return best;
}

function maxAmountDeviationPct(entries: FlaggedEntry[], med: number): number {
  if (med <= 0) return 0;
  let max = 0;
  for (const e of entries) {
    max = Math.max(max, Math.abs(e.amountCents - med) / med);
  }
  return max;
}

function monthEndShare(entries: FlaggedEntry[]): number {
  if (entries.length === 0) return 0;
  const window = config.group.monthEndWindowDays;
  let hits = 0;
  for (const e of entries) {
    const d = new Date(`${e.effectiveDate}T00:00:00`);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const day = d.getDate();
    if (day >= lastDay - window) hits++;
  }
  return hits / entries.length;
}

function lineCountLabel(entries: FlaggedEntry[]): string {
  const counts = new Set(entries.map((e) => e.lineCount));
  if (counts.size === 1) return `entry size: ${entries[0]!.lineCount} lines throughout`;
  return `entry size: ${counts.size} distinct line counts`;
}

/** Simple agreement metrics + human-readable detail lines. */
export function computeConsistency(entries: FlaggedEntry[]): ConsistencyResult {
  if (entries.length === 0) {
    return { score: 0, detail: [] };
  }

  const med = median(entries.map((e) => e.amountCents));
  const mode = modeUser(entries);
  const preparerShare = entries.filter((e) => e.user === mode).length / entries.length;
  const maxDevPct = maxAmountDeviationPct(entries, med);
  const bandPct = 1 / config.group.amountBandRatio;
  const amountTight = Math.max(0, 1 - maxDevPct / bandPct);
  const monthEnd = monthEndShare(entries);

  const detail: string[] = [];

  if (maxDevPct <= bandPct) {
    const pct = Math.round(maxDevPct * 100);
    detail.push(`amounts within ${pct}% of group median`);
  } else {
    detail.push('amounts differ across members');
  }

  const preparerCount = new Set(entries.map((e) => e.user)).size;
  if (preparerCount === 1) {
    detail.push(`single preparer (${mode})`);
  } else {
    detail.push(`${preparerCount} preparers`);
  }

  if (monthEnd >= 0.8) {
    detail.push('posted within 2 days of month end');
  } else if (monthEnd >= 0.5) {
    detail.push('mixed posting timing');
  }

  detail.push(lineCountLabel(entries));

  const score = Number((preparerShare * 0.5 + amountTight * 0.5).toFixed(4));

  return { score, detail };
}

export function deviationReasons(
  entry: FlaggedEntry,
  med: number,
  mode: string,
): string[] {
  const reasons: string[] = [];
  if (med > 0 && entry.amountCents > med * config.group.deviationAmountRatio) {
    const mult = (entry.amountCents / med).toFixed(1);
    reasons.push(`amount ${mult}× group median`);
  }
  if (entry.user !== mode) {
    reasons.push(`different preparer (${entry.user})`);
  }
  return reasons;
}

export { median, modeUser };
