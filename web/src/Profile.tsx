import { useQuery } from '@tanstack/react-query';
import { accountCode, fetchProfile, type Profile as ProfileData } from './api';
import { ruleLabel } from './Terminology';

export function Profile({ totalSelected }: { totalSelected: number }) {
  const { data } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  if (!data) return <div className="profile" data-open="1" aria-busy="true" />;

  const sizes = groupByLines(data.entrySizeHistogram);
  const entries = data.byMonth.reduce((sum, month) => sum + month.entries, 0);
  const topAccount = [...data.topAccounts].sort((a, b) => b.totalAmount - a.totalAmount)[0];
  const topCriterion = [...data.flagCounts].sort((a, b) => b.count - a.count)[0];

  return (
    <div className="profile" data-open="1" aria-label="Population profile">
      <div className="profiletitle">
        <span className="lab">Population profile</span>
        <span>Context for the loaded journal-entry population</span>
      </div>
      <ProfileFact
        label="Period covered"
        value={monthRange(data.byMonth.map((month) => month.month))}
        detail={`${entries.toLocaleString()} entries`}
      />
      <ProfileFact
        label="Entry size"
        value={`Median ${weightedMedian(sizes)} lines`}
        detail={`${sizes[0]?.lines ?? 0} to ${sizes.at(-1)?.lines ?? 0} lines observed`}
      />
      <ProfileFact
        label="Highest-volume account"
        value={topAccount ? accountCode(topAccount.account) : 'Not available'}
        detail={topAccount ? topAccount.name : 'No account activity'}
      />
      <ProfileFact
        label="Most common criterion"
        value={topCriterion ? ruleLabel(topCriterion.rule) : 'Not available'}
        detail={topCriterion ? `${topCriterion.count.toLocaleString()} entries · ${totalSelected.toLocaleString()} selected overall` : 'No selections'}
      />
    </div>
  );
}

function ProfileFact({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="profilefact">
      <span className="lab">{label}</span>
      <b>{value}</b>
      <span>{detail}</span>
    </div>
  );
}

function groupByLines(histogram: ProfileData['entrySizeHistogram']) {
  const totals = new Map<number, number>();
  for (const row of histogram) totals.set(row.lines, (totals.get(row.lines) ?? 0) + row.count);
  return [...totals.entries()]
    .map(([lines, count]) => ({ lines, count }))
    .sort((a, b) => a.lines - b.lines);
}

function weightedMedian(sizes: Array<{ lines: number; count: number }>): number {
  const half = sizes.reduce((sum, size) => sum + size.count, 0) / 2;
  let seen = 0;
  for (const size of sizes) {
    seen += size.count;
    if (seen >= half) return size.lines;
  }
  return sizes.at(-1)?.lines ?? 0;
}

function monthRange(months: string[]): string {
  if (months.length === 0) return 'No periods';
  const label = (month: string) =>
    new Date(`${month}-01T00:00:00`).toLocaleString('en-GB', { month: 'short' });
  const first = months[0]!;
  const last = months.at(-1)!;
  return `${label(first)} to ${label(last)} ${last.slice(0, 4)}`;
}
