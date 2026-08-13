import { useMemo, useState } from 'react';
import {
  accountCode,
  conclusionLabels,
  itemState,
  pairLabel,
  type ItemState,
  type QueueItem,
} from './api';

interface WorklistProps {
  items: QueueItem[];
  selected: string | null;
  onSelect: (groupId: string) => void;
  pair: [string, string] | null;
  onClearPair: () => void;
}

export function Worklist({ items, selected, onSelect, pair, onClearPair }: WorklistProps) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<ItemState | 'all'>('all');
  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return items.filter((item) => {
      if (state !== 'all' && itemState(item) !== state) return false;
      if (!term) return true;
      return [
        item.accountA,
        item.accountB,
        ...item.entryIds,
        ...item.rulesFired,
        kindLabel(item.kind),
      ].some((value) => value.toLowerCase().includes(term));
    });
  }, [items, query, state]);

  return (
    <aside className="wl" aria-label="Review queue">
      <div className="wlhead">
        <div className="wlheading">
          <span className="wltitle">Review queue</span>
          <span>{rows.length} of {items.length} items</span>
        </div>
        {pair && (
          <button className="btn q sm" onClick={onClearPair}>
            Clear account combination filter
          </button>
        )}
      </div>
      {pair && <div className="activefilter">Account combination: {accountCode(pair[0])} / {accountCode(pair[1])}</div>}
      <div className="wltools">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search account, entry or criterion"
          aria-label="Search review queue"
        />
        <select
          value={state}
          onChange={(event) => setState(event.target.value as ItemState | 'all')}
          aria-label="Filter by review status"
        >
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="reviewed">Reviewed</option>
          <option value="aside">Set aside</option>
        </select>
      </div>
      <div className="wlcolumns" aria-hidden="true">
        <span>Account combination / status</span>
        <span>Type</span>
        <span>Entries</span>
      </div>
      <div className="wlscroll">
        {rows.length === 0 && <div className="wlnone">No review items match the current filters.</div>}
        {rows.map((item) => (
          <Row
            key={item.groupId}
            item={item}
            state={itemState(item)}
            current={item.groupId === selected}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
}

function Row({
  item,
  state,
  current,
  onSelect,
}: {
  item: QueueItem;
  state: ItemState;
  current: boolean;
  onSelect: (groupId: string) => void;
}) {
  return (
    <div
      className="it"
      aria-current={current}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item.groupId)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(item.groupId);
        }
      }}
    >
      <span className="itbody">
        <span className="p">{pairLabel(item)}</span>
        <span className={`rowstate ${state}`}>{stateLabel(item, state)} · {activityLabel(item)}</span>
      </span>
      <span className="ittype">{kindLabel(item.kind)}</span>
      <span className="c">{item.entryCount}</span>
    </div>
  );
}

function stateLabel(item: QueueItem, state: ItemState): string {
  if (state === 'open') return 'Open';
  if (state === 'aside') return 'Set aside';
  return conclusionLabels[item.decision!.conclusion].replace('Appropriate, ', 'Reviewed: ');
}

function activityLabel(item: QueueItem): string {
  const months = item.recurrence.months;
  if (months.length === 0) return 'No activity period';
  if (months.length === 1) return `Active ${monthLabel(months[0]!)}`;
  return `Active in ${months.length} months`;
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

function kindLabel(kind: QueueItem['kind']): string {
  if (kind === 'group') return 'Pattern';
  if (kind === 'deviation') return 'Deviation';
  return 'Individual';
}
