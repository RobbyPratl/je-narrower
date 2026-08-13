import { useQuery } from '@tanstack/react-query';
import { fetchProfile, type Profile as ProfileData } from './api';

/**
 * The shape of the population before any of it is flagged. Four cards, each a
 * bar row and a caption; the numbers come from the profile, none are asserted.
 */
export function Profile({ totalFlagged }: { totalFlagged: number }) {
  const { data } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  if (!data) return <div className="profile" data-open="1" />;

  return (
    <div className="profile" data-open="1">
      {cards(data, totalFlagged).map((card) => (
        <div className="pcard" key={card.title}>
          <div className="lab">{card.title}</div>
          <div className="bars">
            {card.bars.map((bar, i) => (
              <i key={i} className={bar.tone ?? ''} style={{ height: `${bar.height}%` }} />
            ))}
          </div>
          <div className="pcap mono">
            <b>{card.lead}</b> <span>{card.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

interface Bar {
  height: number;
  tone?: 'dim' | 'sig';
}

interface Card {
  title: string;
  bars: Bar[];
  lead: string;
  detail: string;
}

function cards(profile: ProfileData, totalFlagged: number): Card[] {
  const sizes = groupByLines(profile.entrySizeHistogram);
  const entries = profile.byMonth.reduce((sum, m) => sum + m.entries, 0);
  const flags = [...profile.flagCounts].sort((a, b) => b.count - a.count);

  return [
    {
      title: 'Entry size',
      bars: scale(sizes.map((s) => s.count)),
      lead: `median ${weightedMedian(sizes)} lines`,
      detail: `${sizes[0]!.lines} to ${sizes[sizes.length - 1]!.lines} lines`,
    },
    {
      title: 'Entries by month',
      bars: scale(profile.byMonth.map((m) => m.entries)),
      lead: monthRange(profile.byMonth.map((m) => m.month)),
      detail: `${entries.toLocaleString()} entries`,
    },
    {
      title: 'Top accounts',
      bars: scale(profile.topAccounts.map((a) => a.totalAmount)),
      lead: `${profile.topAccounts.length} accounts`,
      detail: 'by amount posted',
    },
    {
      title: 'Flags by rule',
      bars: scale(flags.map((f) => f.count), 'sig'),
      lead: `${totalFlagged.toLocaleString()} in the queue`,
      detail: `${flags.length} rules fired`,
    },
  ];
}

/** The histogram is split by period; the population is both periods together. */
function groupByLines(histogram: ProfileData['entrySizeHistogram']) {
  const totals = new Map<number, number>();
  for (const row of histogram) totals.set(row.lines, (totals.get(row.lines) ?? 0) + row.count);
  return [...totals.entries()]
    .map(([lines, count]) => ({ lines, count }))
    .sort((a, b) => a.lines - b.lines);
}

function weightedMedian(sizes: Array<{ lines: number; count: number }>): number {
  const half = sizes.reduce((sum, s) => sum + s.count, 0) / 2;
  let seen = 0;
  for (const size of sizes) {
    seen += size.count;
    if (seen >= half) return size.lines;
  }
  return sizes[sizes.length - 1]!.lines;
}

function scale(values: number[], tone?: 'sig'): Bar[] {
  const max = Math.max(1, ...values);
  return values.map((value) => ({ height: Math.max(4, (value / max) * 100), tone }));
}

function monthRange(months: string[]): string {
  const label = (month: string) =>
    new Date(`${month}-01T00:00:00`).toLocaleString('en-GB', { month: 'short' });
  const first = months[0]!;
  const last = months[months.length - 1]!;
  return `${label(first)} to ${label(last)} ${last.slice(0, 4)}`;
}
