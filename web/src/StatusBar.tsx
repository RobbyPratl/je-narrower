import { entryCounts, type LoadedStatus, type QueueItem, type Status } from './api';

const Dot = () => <span className="dot" />;

export type Panels = { profile: boolean; graph: boolean };

export function StatusBar({
  status,
  items,
  panels,
  onPanel,
  onExport,
}: {
  status: Status;
  items: QueueItem[];
  panels: Panels;
  onPanel: (panel: keyof Panels) => void;
  onExport: () => void;
}) {
  if (status.status === 'empty' || status.status === 'load_failed') {
    return (
      <div className="status">
        <span className="m">No population loaded</span>
      </div>
    );
  }

  if (status.status === 'unreconciled') return <Unreconciled status={status} />;

  const counts = entryCounts(items);
  const total = counts.open + counts.aside + counts.concluded;
  const entries = status.periods.reduce((sum, p) => sum + p.entries, 0);

  return (
    <div className="status">
      <span className="m k">{status.dataset}</span>
      <Dot />
      <span className="sdot" />
      <span className="m">reconciled</span>
      <Dot />
      <span className="m mono">{entries.toLocaleString()} entries</span>
      <Dot />
      <span className="m mono">{total.toLocaleString()} flagged</span>
      {status.override && (
        <>
          <Dot />
          <span className="m" style={{ color: 'var(--verified)' }}>
            override recorded
          </span>
        </>
      )}

      <span className="counts">
        <Count value={counts.concluded} label="concluded" tone="done" />
        <Count value={counts.open} label="open" />
        <Count value={counts.aside} label="set aside" tone="aside" />
        <span className="pbar">
          <i className="d" style={{ width: `${pct(counts.concluded, total)}%` }} />
          <i className="a" style={{ width: `${pct(counts.aside, total)}%` }} />
        </span>
        <span className="tg">
          <button aria-pressed={panels.profile} onClick={() => onPanel('profile')}>
            Profile
          </button>
          <button aria-pressed={panels.graph} onClick={() => onPanel('graph')}>
            Graph
          </button>
        </span>
        <button className="btn" onClick={onExport} disabled={items.length === 0}>
          Export workpaper
        </button>
      </span>
    </div>
  );
}

function Count({ value, label, tone }: { value: number; label: string; tone?: 'done' | 'aside' }) {
  return (
    <span className={tone ? `cnt ${tone}` : 'cnt'}>
      <b>{value}</b>
      <span>{label}</span>
    </span>
  );
}

function Unreconciled({ status }: { status: LoadedStatus }) {
  return (
    <div className="status bad">
      <div className="exc">
        <h2>Population unreconciled</h2>
        <div className="sum">
          Gross difference <span className="mono">{money(status.grossDeltaCents)}</span> across{' '}
          {status.exceptions.length} accounts. This is stamped on every conclusion recorded while it
          stands; nothing is blocked.
        </div>
        <table className="mono">
          <tbody>
            {status.exceptions.map((e) => (
              <tr key={`${e.account}:${e.period}`}>
                <td>{e.account}</td>
                <td>{e.period}</td>
                <td style={e.deltaCents < 0 ? { color: 'var(--signal)' } : undefined}>
                  {signedMoney(e.deltaCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const pct = (n: number, total: number) => (total === 0 ? 0 : (n / total) * 100);

function money(cents: number): string {
  return (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

// Accounting convention: negatives in parentheses, not a minus sign.
function signedMoney(cents: number): string {
  return cents < 0 ? `(${money(cents)})` : money(cents);
}
