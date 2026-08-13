import type { FlaggedEntry, Recurrence } from './types.js';

/** Monthly activity marks for the recurrence strip. */
export function buildRecurrence(entries: FlaggedEntry[]): Recurrence {
  const byMonth: Record<string, number> = {};
  for (const e of entries) {
    const month = e.effectiveDate.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }

  const months = Object.keys(byMonth).sort();
  const trimmed = months.length > 12 ? months.slice(-12) : months;

  return {
    months: trimmed,
    marks: trimmed.map((m) => byMonth[m] ?? 0),
    byMonth,
  };
}

export function recurrenceLabel(recurrence: Recurrence): string {
  if (recurrence.months.length === 0) return 'no dated entries';
  const span = recurrence.months.length;
  const active = recurrence.marks.filter((m) => m > 0).length;
  if (active >= span - 1 && span >= 6) return 'monthly cadence';
  if (active >= 2) return 'recurring across periods';
  return 'sparse occurrence';
}
