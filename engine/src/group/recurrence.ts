import type { FlaggedEntry, Recurrence } from './types.js';

/** Monthly activity marks for the recurrence strip. */
export function buildRecurrence(entries: FlaggedEntry[]): Recurrence {
  const byMonth: Record<string, number> = {};
  for (const e of entries) {
    const month = e.effectiveDate.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }

  const activeMonths = Object.keys(byMonth).sort();
  const months = activeMonths.length === 0
    ? []
    : calendarMonths(activeMonths[0]!, activeMonths[activeMonths.length - 1]!);
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
  if (active >= span - 1 && span >= 6) return 'observed nearly every month';
  if (active >= 2) return 'observed in multiple months';
  return 'observed in one month';
}

function calendarMonths(first: string, last: string): string[] {
  const [firstYear, firstMonth] = first.split('-').map(Number) as [number, number];
  const [lastYear, lastMonth] = last.split('-').map(Number) as [number, number];
  const months: string[] = [];
  for (let year = firstYear, month = firstMonth; year < lastYear || (year === lastYear && month <= lastMonth);) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month++;
    if (month === 13) {
      month = 1;
      year++;
    }
  }
  return months;
}
