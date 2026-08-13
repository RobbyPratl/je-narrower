import type { ReactNode } from 'react';

const rules: Record<string, { label: string; description: string }> = {
  round_amount: {
    label: 'Round-number amount',
    description: 'Entry total is an exact multiple of the configured $1,000 criterion.',
  },
  date_mismatch: {
    label: 'Posting-date lag',
    description: 'Posting date is more than two days after the effective date.',
  },
  off_hours: {
    label: 'Outside normal posting hours',
    description: 'Posted before 07:00, at or after 20:00, or on a weekend.',
  },
  entry_size_outlier: {
    label: 'Unusually many lines',
    description: 'Line count is at or above the 99th percentile for its period.',
  },
  unusual_user: {
    label: 'Infrequent preparer',
    description: 'The preparer posted under 5% of entries to an account with at least 10 entries in the period.',
  },
  threshold_proximity: {
    label: 'Amount just below threshold',
    description: 'Entry total is within 2% below a configured review threshold.',
  },
  pair_rarity: {
    label: 'Infrequent account combination',
    description: 'The least-common debit/credit account combination on the entry occurred only a small number of times in the period.',
  },
  new_pair_emergence: {
    label: 'New or changed account combination',
    description: 'An account combination is new in the current period, or its frequency changed materially from the comparison period.',
  },
};

const investigationSteps: Record<string, string> = {
  get_entry_lines: 'Inspected journal-entry lines',
  get_pair_history: 'Reviewed account-combination history',
  get_pair_diff: 'Compared the account combination across periods',
  get_similar_entries: 'Found similar historical entries',
  get_user_activity: 'Reviewed preparer activity',
  get_account_context: 'Reviewed account activity',
};

export const patternConsistencyHelp =
  'Internal grouping aid: 50% is the share posted by the most common preparer and 50% is amount similarity to the group median. It is not an audit conclusion.';

export const combinedScoreHelp =
  'Weighted sum of the selection-criterion scores, used to order entries for review. It is not a probability of fraud or an audit conclusion.';

export function ruleLabel(rule: string): string {
  return rules[rule]?.label ?? rule.replaceAll('_', ' ');
}

export function ruleDescription(rule: string): string {
  return rules[rule]?.description ?? 'Application-defined journal-entry selection criterion.';
}

export function investigationStepLabel(tool: string): string {
  return investigationSteps[tool] ?? tool.replaceAll('_', ' ');
}

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="help" tabIndex={0} aria-label={`${label}: ${String(children)}`}>
      Definition
      <span role="tooltip">{children}</span>
    </span>
  );
}

export function RuleTerm({ rule }: { rule: string }) {
  return (
    <span className="ruleterm">
      {ruleLabel(rule)} <HelpTip label={ruleLabel(rule)}>{ruleDescription(rule)}</HelpTip>
    </span>
  );
}
