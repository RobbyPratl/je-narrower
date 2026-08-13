import { config } from '../config.js';
import type { FlaggedEntry } from './types.js';
import { deviationReasons, median, modeUser } from './consistency.js';

export interface SplitResult {
  members: FlaggedEntry[];
  deviations: Array<{ entry: FlaggedEntry; reasons: string[] }>;
}

/** Pull outliers out before forming a review group. */
export function splitDeviations(entries: FlaggedEntry[]): SplitResult {
  if (entries.length < config.group.minGroupSize) {
    return { members: [], deviations: entries.map((e) => ({ entry: e, reasons: ['too few to group'] })) };
  }

  const med = median(entries.map((e) => e.amountCents));
  const mode = modeUser(entries);

  const deviations: SplitResult['deviations'] = [];
  const members: FlaggedEntry[] = [];

  for (const entry of entries) {
    const reasons = deviationReasons(entry, med, mode);
    if (reasons.length > 0) {
      deviations.push({ entry, reasons });
    } else {
      members.push(entry);
    }
  }

  if (members.length < config.group.minGroupSize) {
    return {
      members: [],
      deviations: entries.map((e) => ({
        entry: e,
        reasons: deviationReasons(e, med, mode).length > 0
          ? deviationReasons(e, med, mode)
          : ['group too small after split'],
      })),
    };
  }

  return { members, deviations };
}
