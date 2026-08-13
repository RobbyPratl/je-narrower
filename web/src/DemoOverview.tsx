import {
  itemState,
  pairLabel,
  type Loaded,
  type Queue,
  type QueueItem,
} from './api';
import { ruleLabel } from './Terminology';
import { attentionItems } from './reviewQueue';

export function DemoOverview({
  status,
  queue,
  canReviewNext,
  onReviewNext,
  onSelectItem,
}: {
  status: Loaded;
  queue: Queue;
  canReviewNext: boolean;
  onReviewNext: () => void;
  onSelectItem: (groupId: string) => void;
}) {
  const populationEntries = status.periods.reduce((sum, period) => sum + period.entries, 0);
  const rows = [
    summaryRow('Recurring patterns', queue.items.filter((item) => item.kind === 'group')),
    summaryRow('Isolated deviations', queue.items.filter((item) => item.kind === 'deviation')),
    summaryRow('Individual selections', queue.items.filter((item) => item.kind === 'individual')),
  ];
  const totals = summaryRow('Total', queue.items);
  const attention = attentionItems(queue.items);

  return (
    <div className="wb reviewsummary">
      <header className="wbhead summaryhead">
        <h2>Review summary</h2>
        <button className="btn primary sm" disabled={!canReviewNext} onClick={onReviewNext}>
          Review next open item
        </button>
      </header>

      <div className="fx summarybody">
        <section className="sec reviewfacts" aria-label="Population and review status">
          <Fact label="Population" value={`${populationEntries.toLocaleString()} entries`} detail={statusLabel(status)} />
          <Fact
            label="Selection"
            value={`${queue.summary.totalFlagged.toLocaleString()} entries`}
            detail="Selected for review"
          />
          <Fact
            label="Review"
            value={`${queue.items.length.toLocaleString()} items`}
            detail={`${totals.open} open · ${totals.reviewed} reviewed${totals.aside ? ` · ${totals.aside} set aside` : ''}`}
          />
        </section>

        <section className="sec">
          <div className="sech">
            <span className="lab">Worklist composition</span>
            <span className="dstat">
              {queue.summary.totalFlagged.toLocaleString()} selected entries organized into{' '}
              {queue.items.length.toLocaleString()} review items
            </span>
          </div>
          <div className="tpanel">
            <table className="mtab summarytable">
              <thead>
                <tr>
                  <th>Review type</th>
                  <th className="r">Items</th>
                  <th className="r">Entries</th>
                  <th className="r">Open</th>
                  <th className="r">Reviewed</th>
                  <th className="r">Set aside</th>
                </tr>
              </thead>
              <tbody>
                {[...rows, totals].map((row) => (
                  <tr className={row.label === 'Total' ? 'totalrow' : undefined} key={row.label}>
                    <td>{row.label}</td>
                    <td className="amt">{row.items}</td>
                    <td className="amt">{row.entries}</td>
                    <td className="amt">{row.open}</td>
                    <td className="amt">{row.reviewed}</td>
                    <td className="amt">{row.aside}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="sec">
          <div className="sech">
            <span className="lab">Needs attention</span>
            <span className="dstat">Ordered by follow-up status, deviation, then item size</span>
          </div>
          {attention.length === 0 ? (
            <div className="neutralstate">No open review items.</div>
          ) : (
            <div className="tpanel">
              <table className="mtab attentiontable">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Account combination</th>
                    <th>Type</th>
                    <th className="r">Entries</th>
                    <th>Reason</th>
                    <th><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {attention.map((item) => (
                    <tr key={item.groupId}>
                      <td><ReviewStatus item={item} /></td>
                      <td className="mono">{pairLabel(item)}</td>
                      <td>{kindLabel(item.kind)}</td>
                      <td className="amt">{item.entryCount}</td>
                      <td>{attentionReason(item, queue.items)}</td>
                      <td className="rowaction">
                        <button className="btn q sm" onClick={() => onSelectItem(item.groupId)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Fact({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="reviewfact">
      <span className="lab">{label}</span>
      <b className="mono">{value}</b>
      <span>{detail}</span>
    </div>
  );
}

function summaryRow(label: string, items: QueueItem[]) {
  return {
    label,
    items: items.length,
    entries: items.reduce((sum, item) => sum + item.entryCount, 0),
    open: items.filter((item) => itemState(item) === 'open').length,
    reviewed: items.filter((item) => itemState(item) === 'reviewed').length,
    aside: items.filter((item) => itemState(item) === 'aside').length,
  };
}

function statusLabel(status: Loaded): string {
  return status.status === 'reconciled' ? 'Reconciled to trial balance' : 'Reconciliation exceptions present';
}

function ReviewStatus({ item }: { item: QueueItem }) {
  if (item.decision?.conclusion === 'requires-procedures') {
    return <span className="textstatus signal">Requires further procedures</span>;
  }
  return <span className="textstatus">Open</span>;
}

function kindLabel(kind: QueueItem['kind']): string {
  if (kind === 'group') return 'Pattern';
  if (kind === 'deviation') return 'Deviation';
  return 'Individual';
}

function attentionReason(item: QueueItem, items: QueueItem[]): string {
  if (item.kind === 'group') {
    const deviations = items.filter((candidate) => candidate.parentGroupId === item.groupId).length;
    if (deviations > 0) return `${deviations} isolated ${deviations === 1 ? 'deviation' : 'deviations'}`;
  }
  if (item.kind === 'deviation') {
    const reason = item.consistency.detail[0]?.replace(/^deviates:\s*/i, '');
    if (reason) return sentence(reason);
  }
  return item.rulesFired.length > 0 ? ruleLabel(item.rulesFired[0]!) : item.recurrence.label;
}

function sentence(value: string): string {
  const text = value.charAt(0).toUpperCase() + value.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
