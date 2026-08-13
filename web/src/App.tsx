import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchQueue, fetchStatus, isPair, itemState } from './api';
import { StatusBar } from './StatusBar';
import { Export } from './Export';
import { Graph } from './Graph';
import { Profile } from './Profile';
import { Worklist } from './Worklist';
import { Workbench } from './Workbench';
import { DemoOverview } from './DemoOverview';
import { firstOpenItem } from './reviewQueue';

export function App() {
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [panels, setPanels] = useState({ profile: false, graph: false });
  const [pair, setPair] = useState<[string, string] | null>(null);

  const status = useQuery({ queryKey: ['status'], queryFn: fetchStatus });
  const queue = useQuery({ queryKey: ['queue'], queryFn: fetchQueue });

  if (status.error) return <Failure message={status.error.message} />;
  if (queue.error) return <Failure message={queue.error.message} />;
  if (!status.data || !queue.data) return <LoadingWorkspace />;

  const items = queue.data.items;
  const shown = pair ? items.filter((item) => isPair(item, pair)) : items;
  const nextOpen = firstOpenItem(items);

  function selectFromStory(groupId: string) {
    setPair(null);
    setSelected(groupId);
  }

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
        overviewActive={selected === null}
        onOverview={() => {
          setPair(null);
          setSelected(null);
        }}
        onPanel={(name) => setPanels({ ...panels, [name]: !panels[name] })}
        onExport={() => setExporting(true)}
      />
      {panels.profile && <Profile totalSelected={queue.data.summary.totalFlagged} />}
      <div className="body">
        <Worklist
          items={shown}
          selected={selected}
          onSelect={setSelected}
          pair={pair}
          onClearPair={() => setPair(null)}
        />
        {selected === null && status.data.status !== 'empty' && status.data.status !== 'load_failed' ? (
          <DemoOverview
            status={status.data}
            queue={queue.data}
            canReviewNext={nextOpen !== null}
            onReviewNext={() => nextOpen && selectFromStory(nextOpen.groupId)}
            onSelectItem={selectFromStory}
          />
        ) : (
          <Workbench
            item={items.find((i) => i.groupId === selected) ?? null}
            items={items}
            onSelectItem={selectFromStory}
            onReviewRecorded={advance}
          />
        )}
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
        <div className="s">{message}. Start the local service with <code>pnpm serve</code> and reload.</div>
      </div>
    </div>
  );
}

function LoadingWorkspace() {
  return (
    <div className="app" aria-busy="true">
      <div className="appbar">
        <div className="brand"><b>Journal entry review</b><span>Loading engagement…</span></div>
      </div>
      <div className="body">
        <div className="wl loadrail">
          <div className="wlhead"><span className="wltitle">Worklist</span></div>
          <div className="loadlines" aria-hidden="true"><i /><i /><i /><i /></div>
        </div>
        <div className="wb loadstate">
          <span className="lab">Review workspace</span>
          <span>Loading review queue…</span>
        </div>
      </div>
    </div>
  );
}
