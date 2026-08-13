import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchQueue, fetchStatus, isPair, itemState } from './api';
import { StatusBar } from './StatusBar';
import { Export } from './Export';
import { Graph } from './Graph';
import { Profile } from './Profile';
import { Worklist } from './Worklist';
import { Workbench } from './Workbench';

export function App() {
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [panels, setPanels] = useState({ profile: false, graph: false });
  const [pair, setPair] = useState<[string, string] | null>(null);

  const status = useQuery({ queryKey: ['status'], queryFn: fetchStatus });
  const queue = useQuery({ queryKey: ['queue'], queryFn: fetchQueue });

  if (status.error) return <Failure message={status.error.message} />;
  if (queue.error) return <Failure message={queue.error.message} />;
  if (!status.data || !queue.data) return null;

  const items = queue.data.items;
  const shown = pair ? items.filter((item) => isPair(item, pair)) : items;

  // Recording should hand you the next thing to do rather than leaving you
  // on an item you just finished.
  function advance() {
    const from = items.findIndex((i) => i.groupId === selected);
    const next =
      items.slice(from + 1).find((i) => itemState(i) === 'open') ??
      items.find((i) => itemState(i) === 'open' && i.groupId !== selected);
    setSelected(next?.groupId ?? null);
  }

  return (
    <div className="app">
      <StatusBar
        status={status.data}
        items={items}
        panels={panels}
        onPanel={(name) => setPanels({ ...panels, [name]: !panels[name] })}
        onExport={() => setExporting(true)}
      />
      {panels.profile && <Profile totalFlagged={queue.data.summary.totalFlagged} />}
      <div className="body">
        <Worklist
          items={shown}
          selected={selected}
          onSelect={setSelected}
          pair={pair}
          onClearPair={() => setPair(null)}
        />
        <Workbench
          item={items.find((i) => i.groupId === selected) ?? null}
          items={items}
          onConcluded={advance}
        />
      </div>
      {panels.graph && <Graph onPickPair={setPair} />}
      {exporting && status.data.status !== 'empty' && status.data.status !== 'load_failed' && (
        <Export items={items} status={status.data} onClose={() => setExporting(false)} />
      )}
    </div>
  );
}

function Failure({ message }: { message: string }) {
  return (
    <div className="app">
      <div className="blank">
        <div className="h">The engine did not respond</div>
        <div className="s">{message}. Start it with `pnpm serve` and reload.</div>
      </div>
    </div>
  );
}
