import { accountCode, conclusionLabels, itemState, pairLabel, type ItemState, type QueueItem } from './api';

const sections: Array<{ state: ItemState; title: string }> = [
  { state: 'open', title: 'Open' },
  { state: 'aside', title: 'Set aside' },
  { state: 'concluded', title: 'Concluded' },
];

interface WorklistProps {
  items: QueueItem[];
  selected: string | null;
  onSelect: (groupId: string) => void;
  pair: [string, string] | null;
  onClearPair: () => void;
}

export function Worklist({ items, selected, onSelect, pair, onClearPair }: WorklistProps) {
  return (
    <div className="wl">
      <div className="wlhead">
        <span className="wltitle">Worklist</span>
        {pair && (
          <button className="btn q sm" onClick={onClearPair}>
            Clear {accountCode(pair[0])} / {accountCode(pair[1])}
          </button>
        )}
      </div>
      <div className="wlscroll">
        {items.length === 0 && <div className="wlnone">Nothing flagged on this pair.</div>}
        {sections.map(({ state, title }) => {
          const rows = items.filter((item) => itemState(item) === state);
          if (rows.length === 0) return null;
          const entries = rows.reduce((sum, item) => sum + item.entryCount, 0);

          return (
            <div key={state}>
              <div className="wlsec">
                <span className="lab">{title}</span>
                <span className="n">{entries}</span>
              </div>
              {rows.map((item) => (
                <Row
                  key={item.groupId}
                  item={item}
                  state={state}
                  current={item.groupId === selected}
                  onSelect={onSelect}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
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
  const deviation = item.kind === 'deviation';
  const classes = ['it', deviation && 'dev', state === 'concluded' && 'done', state === 'aside' && 'aside']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      aria-current={current}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item.groupId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(item.groupId);
        }
      }}
    >
      <span className="g">{state === 'concluded' ? <span className="sdot" /> : deviation ? '!' : ''}</span>
      <span className="p">{pairLabel(item)}</span>
      <span className="c">{item.entryCount}</span>
      <span className="r">{summary(item, state)}</span>
    </div>
  );
}

function summary(item: QueueItem, state: ItemState): string {
  if (state === 'open') return item.recurrence.label;
  if (state === 'aside') return 'aside';
  // Concluded rows show the conclusion, which is the useful thing at a glance.
  return conclusionLabels[item.decision!.conclusion].replace('Appropriate, ', '');
}
