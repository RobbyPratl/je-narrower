import type { EntryRow } from './api';

/**
 * Mirrors engine/src/group/consistency.ts so removing a member updates the
 * screen immediately instead of waiting on a round trip. The engine stays the
 * authority: whatever it returns after a PATCH overwrites what we showed.
 * These thresholds are engine/src/config.ts `group`.
 */
const amountBandRatio = 2;
const deviationAmountRatio = 3;
const monthEndWindowDays = 2;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

export function modePreparer(entries: EntryRow[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.user, (counts.get(e.user) ?? 0) + 1);

  let best = entries[0]?.user ?? '';
  let bestN = 0;
  for (const [user, n] of counts) {
    if (n > bestN) [best, bestN] = [user, n];
  }
  return best;
}

export function deviationReasons(entry: EntryRow, entries: EntryRow[]): string[] {
  const med = median(entries.map((e) => e.totalAmount));
  const mode = modePreparer(entries);
  const reasons: string[] = [];

  if (med > 0 && entry.totalAmount > med * deviationAmountRatio) {
    reasons.push(`${(entry.totalAmount / med).toFixed(1)}x median`);
  }
  if (entry.user !== mode) {
    reasons.push('other preparer');
  }
  return reasons;
}

export function consistencyScore(entries: EntryRow[]): number {
  if (entries.length === 0) return 0;

  const med = median(entries.map((e) => e.totalAmount));
  const mode = modePreparer(entries);
  const preparerShare = entries.filter((e) => e.user === mode).length / entries.length;

  const band = 1 / amountBandRatio;
  const maxDeviation = med <= 0
    ? 0
    : Math.max(...entries.map((e) => Math.abs(e.totalAmount - med) / med));
  const amountTight = Math.max(0, 1 - maxDeviation / band);

  return Number((preparerShare * 0.5 + amountTight * 0.5).toFixed(4));
}

/** The wording the engine uses for `groupingBasis.detail`, recomputed locally. */
export function basisDetail(entries: EntryRow[]): string[] {
  if (entries.length === 0) return [];

  const med = median(entries.map((e) => e.totalAmount));
  const preparers = new Set(entries.map((e) => e.user));
  const band = 1 / amountBandRatio;
  const maxDeviation = med <= 0
    ? 0
    : Math.max(...entries.map((e) => Math.abs(e.totalAmount - med) / med));

  const detail = [
    maxDeviation <= band
      ? `amounts within ${Math.round(maxDeviation * 100)}% of group median`
      : 'amounts differ across members',
    preparers.size === 1 ? `single preparer (${modePreparer(entries)})` : `${preparers.size} preparers`,
  ];

  const onCycle = entries.filter((e) => nearMonthEnd(e.effectiveDate)).length / entries.length;
  if (onCycle >= 0.8) detail.push('posted within 2 days of month end');
  else if (onCycle >= 0.5) detail.push('mixed posting timing');

  const lineCounts = new Set(entries.map((e) => e.lineCount));
  detail.push(
    lineCounts.size === 1
      ? `entry size: ${entries[0]!.lineCount} lines throughout`
      : `entry size: ${lineCounts.size} distinct line counts`,
  );

  return detail;
}

function nearMonthEnd(effectiveDate: string): boolean {
  const date = new Date(`${effectiveDate}T00:00:00`);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return date.getDate() >= lastDay - monthEndWindowDays;
}
