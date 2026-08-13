import { itemCounts, selectedEntryCount, type Loaded, type QueueItem, type Status } from './api';

export type Panels = { profile: boolean; graph: boolean };

export function StatusBar({
  status,
  items,
  panels,
  overviewActive,
  onOverview,
  onPanel,
  onExport,
}: {
  status: Status;
  items: QueueItem[];
  panels: Panels;
  overviewActive: boolean;
  onOverview: () => void;
  onPanel: (panel: keyof Panels) => void;
  onExport: () => void;
}) {
  if (status.status === 'empty' || status.status === 'load_failed') {
    return (
      <header className="appbar">
        <div className="brand"><b>Journal entry review</b><span>No population loaded</span></div>
      </header>
    );
  }

  const counts = itemCounts(items);
  const entries = status.periods.reduce((sum, period) => sum + period.entries, 0);
  const selected = selectedEntryCount(items);

  return (
    <>
      <header className="appbar">
        <div className="brand">
          <b>Journal entry review</b>
          <span>{status.dataset}</span>
        </div>
        <nav className="appnav" aria-label="Workspace">
          <button aria-current={overviewActive ? 'page' : undefined} onClick={onOverview}>Review queue</button>
          <button aria-pressed={panels.profile} onClick={() => onPanel('profile')}>Population</button>
          <button aria-pressed={panels.graph} onClick={() => onPanel('graph')}>Account flows</button>
        </nav>
        <div className="appactions">
          <button className="btn" onClick={onExport} disabled={items.length === 0}>Export workpaper</button>
        </div>
      </header>

      <div className="contextbar">
        <span className={status.status === 'reconciled' ? 'statuslabel success' : 'statuslabel warning'}>
          {status.status === 'reconciled' ? 'Reconciled' : 'Reconciliation exceptions'}
        </span>
        <span>{periodRange(status)}</span>
        <span><b className="mono">{entries.toLocaleString()}</b> population entries</span>
        <span><b className="mono">{selected.toLocaleString()}</b> selected entries</span>
        {status.override && <span className="verifiedtext">Override recorded</span>}
        <div className="contextcounts">
          <Count value={counts.open} label="open" />
          <Count value={counts.reviewed} label="reviewed" />
          <Count value={counts.aside} label="set aside" />
        </div>
      </div>

      {status.status === 'unreconciled' && <Unreconciled status={status} />}
    </>
  );
}

function Count({ value, label }: { value: number; label: string }) {
  return <span><b className="mono">{value}</b> {label}</span>;
}

function Unreconciled({ status }: { status: Loaded }) {
  return (
    <div className="exceptionbar">
      <b>Population is not reconciled.</b>
      <span>
        Gross difference {money(status.grossDeltaCents)} across {status.exceptions.length} accounts.
        Conclusions remain available and will retain this population status.
      </span>
    </div>
  );
}

function periodRange(status: Loaded): string {
  const periods = status.periods.map((period) => period.period).sort();
  if (periods.length === 0) return 'No period';
  const first = periods[0]!;
  const last = periods.at(-1)!;
  return first === last ? first : `${first} to ${last}`;
}

function money(cents: number): string {
  const value = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
  return cents < 0 ? `(${value})` : value;
}
