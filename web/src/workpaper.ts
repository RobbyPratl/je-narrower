/**
 * The workpaper is the deliverable, so the mapping from queue state to rows
 * lives apart from the dialog that offers it.
 */
import { conclusionLabels, pairLabel, type Loaded, type QueueItem } from './api';
import type { Cell, Sheet } from './xlsx';

const ruleColumns = [
  'round_amount',
  'off_hours',
  'pair_rarity',
  'new_pair_emergence',
  'threshold_proximity',
  'entry_size_outlier',
];

export function workpaperSheets(items: QueueItem[], status: Loaded): Sheet[] {
  const entries = status.periods.reduce((sum, p) => sum + p.entries, 0);
  const stamp = `${status.status === 'reconciled' ? 'Reconciled' : 'Unreconciled'}, ${entries} entries`;
  const hashes = status.override ? `override: ${status.override.reason}` : '';

  const workpaper: Cell[][] = [
    ['Journal entry testing workpaper'],
    ['Population', `${status.dataset}. ${stamp}`],
    ['Override', hashes],
    ['Exported', stampTime(new Date().toISOString())],
    [],
    ['Item', 'Accounts', 'Entries', 'Recurrence', ...ruleColumns, 'Conclusion', 'Basis', 'By', 'At'],
  ];

  for (const item of items) {
    workpaper.push([
      pairLabel(item),
      `${item.accountA} / ${item.accountB}`,
      item.entryCount,
      item.recurrence.label,
      ...ruleColumns.map((rule) => (item.rulesFired.includes(rule) ? 'X' : '')),
      item.decision ? conclusionLabels[item.decision.conclusion] : 'open',
      item.decision?.basis ?? '',
      item.decision?.recordedBy ?? '',
      item.decision ? stampTime(item.decision.recordedAt) : '',
    ]);
  }

  const history: Cell[][] = [
    ['Superseded conclusions'],
    ['A conclusion is replaced, never deleted.'],
    [],
    ['Item', 'Conclusion', 'Basis', 'By', 'Recorded', 'Superseded', 'What changed'],
  ];

  for (const item of items) {
    for (const prior of item.supersededDecisions) {
      history.push([
        pairLabel(item),
        conclusionLabels[prior.conclusion],
        prior.basis,
        prior.recordedBy ?? '',
        stampTime(prior.recordedAt),
        stampTime(prior.supersededAt),
        prior.reason,
      ]);
    }
  }

  return [
    { name: 'Workpaper', rows: workpaper, widths: [16, 46, 10, 18, 13, 13, 13, 16, 16, 16, 24, 80, 16, 18] },
    { name: 'Superseded', rows: history, widths: [16, 24, 60, 16, 18, 18, 44] },
  ];
}

/** Excel has no timezone, so write a plain local-looking stamp rather than raw ISO. */
function stampTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
