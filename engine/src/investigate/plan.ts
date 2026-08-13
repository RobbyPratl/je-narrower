import { config } from '../config.js';

export interface PlanStep {
  tool: string;
  reason: string;
  args: Record<string, unknown>;
}

const RULE_PRIORITY: Record<string, number> = {
  new_pair_emergence: 10,
  pair_rarity: 9,
  entry_size_outlier: 8,
  unusual_user: 7,
  off_hours: 6,
  date_mismatch: 5,
  threshold_proximity: 4,
  round_amount: 3,
};

function pairFromInputs(inputs: Record<string, unknown>): [string, string] | null {
  const pair = inputs.pair as string | undefined;
  if (!pair) return null;
  const parts = pair.split('↔');
  if (parts.length !== 2) return null;
  return [parts[0]!, parts[1]!];
}

export function buildPlan(
  entryId: string,
  period: string,
  user: string,
  rules: Array<{ rule: string; inputs: Record<string, unknown> }>,
): PlanStep[] {
  const sorted = [...rules].sort(
    (a, b) => (RULE_PRIORITY[b.rule] ?? 0) - (RULE_PRIORITY[a.rule] ?? 0),
  );

  const steps: PlanStep[] = [];
  const seen = new Set<string>();

  const add = (tool: string, reason: string, args: Record<string, unknown>) => {
    const key = `${tool}:${JSON.stringify(args)}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ tool, reason, args });
  };

  for (const { rule, inputs } of sorted) {
    if (rule === 'new_pair_emergence') {
      const pair = pairFromInputs(inputs);
      if (pair) {
        add('get_pair_diff', 'Emergence rule fired — compare pair across periods', {
          account_a: pair[0],
          account_b: pair[1],
        });
        add('get_account_context', 'Context on first account in emergent pair', { account: pair[0] });
        add('get_account_context', 'Context on second account in emergent pair', { account: pair[1] });
        add('get_similar_entries', 'Look for historical entries with same account pattern', { entry_id: entryId });
      }
    } else if (rule === 'pair_rarity') {
      const pair = pairFromInputs(inputs);
      if (pair) {
        add('get_pair_history', 'Rare pairing — inspect occurrence history', {
          account_a: pair[0],
          account_b: pair[1],
          period,
        });
        add('get_similar_entries', 'Find entries with similar account sets', { entry_id: entryId });
      }
    } else if (rule === 'off_hours' || rule === 'unusual_user') {
      add('get_user_activity', 'Poster activity pattern for the period', { user, period });
    } else if (rule === 'entry_size_outlier') {
      add('get_entry_lines', 'Large entry — inspect all lines', { entry_id: entryId });
    }
  }

  if (!steps.some((s) => s.tool === 'get_entry_lines')) {
    add('get_entry_lines', 'Baseline line detail for flagged entry', { entry_id: entryId });
  }

  return steps.slice(0, config.agent.maxToolCalls);
}

export function ruleGroup(rule: string): 'population' | 'parametric' {
  const population = new Set([
    'pair_rarity',
    'new_pair_emergence',
    'threshold_proximity',
    'entry_size_outlier',
  ]);
  return population.has(rule) ? 'population' : 'parametric';
}

export function ruleWeight(rule: string): number {
  const weights = config.composite.weights as Record<string, number>;
  return weights[rule] ?? 0;
}
