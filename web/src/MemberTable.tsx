import { useRef, useState } from 'react';
import type { EntryRow } from './api';
import { deviationReasons } from './consistency';

interface MemberTableProps {
  members: EntryRow[];
  busy: boolean;
  moveTargets: number;
  onRemove: (entryIds: string[]) => void;
  onMove: (entryIds: string[]) => void;
  onSetAside: (entryIds: string[]) => void;
}

const visibleRows = 8;

export function MemberTable({
  members,
  busy,
  moveTargets,
  onRemove,
  onMove,
  onSetAside,
}: MemberTableProps) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const anchor = useRef<string | null>(null);

  const ordered = [...members].sort(
    (a, b) => deviationReasons(b, members).length - deviationReasons(a, members).length,
  );
  const shown = showAll ? ordered : ordered.slice(0, visibleRows);
  const allShownPicked = shown.length > 0 && shown.every((m) => picked.has(m.entryId));

  function toggle(entryId: string, extend: boolean) {
    const next = new Set(picked);
    const from = anchor.current;

    if (extend && from) {
      const a = ordered.findIndex((m) => m.entryId === from);
      const b = ordered.findIndex((m) => m.entryId === entryId);
      for (const m of ordered.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(m.entryId);
    } else {
      next.has(entryId) ? next.delete(entryId) : next.add(entryId);
      anchor.current = entryId;
    }
    setPicked(next);
  }

  function toggleAll() {
    setPicked(allShownPicked ? new Set() : new Set(shown.map((m) => m.entryId)));
  }

  const act = (run: (ids: string[]) => void) => () => {
    run([...picked]);
    setPicked(new Set());
  };

  return (
    <section className="sec">
      <div className="tpanel">
        <div className="tphead">
          <span className="tptitle">Members</span>
          <span className="tpn">{members.length}</span>
          <span style={{ marginLeft: 'auto' }} className="tphint">
            {members.filter((m) => deviationReasons(m, members).length > 0).length} deviating
          </span>
        </div>

        <table className="mtab">
          <thead>
            <tr>
              <th className="ck">
                <input
                  type="checkbox"
                  checked={allShownPicked}
                  ref={(el) => {
                    if (el) el.indeterminate = picked.size > 0 && !allShownPicked;
                  }}
                  onChange={toggleAll}
                  aria-label="Select all shown"
                />
              </th>
              <th>entry</th>
              <th>date</th>
              <th className="r">amount</th>
              <th>preparer</th>
              <th className="r">score</th>
              <th>deviates</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((member) => (
              <tr
                key={member.entryId}
                className={picked.has(member.entryId) ? 'selrow' : undefined}
                onClick={(e) => toggle(member.entryId, e.shiftKey)}
              >
                <td className="ck">
                  <input
                    type="checkbox"
                    checked={picked.has(member.entryId)}
                    onChange={() => {}}
                    aria-label={`Select ${member.entryId}`}
                  />
                </td>
                <td className="m">{member.entryId}</td>
                <td className="m dim">{member.effectiveDate}</td>
                <td className="amt">{money(member.totalAmount)}</td>
                <td className="m">{member.user}</td>
                <td className="amt dim">{member.composite.toFixed(2)}</td>
                <td>
                  {deviationReasons(member, members).map((reason, i) => (
                    <span className="dvlist" key={reason}>
                      {i > 0 && <i />}
                      {reason}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {members.length > visibleRows && (
          <div className="tpfoot">
            <button onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : `Show all ${members.length} entries`}
            </button>
          </div>
        )}
      </div>

      {picked.size > 0 && (
        <div className="selbar">
          <span className="n">{picked.size} selected</span>
          <button
            className="btn sm"
            disabled={busy || picked.size === members.length}
            title={picked.size === members.length ? 'A group cannot be emptied' : undefined}
            onClick={act(onRemove)}
          >
            Remove from group
          </button>
          <button
            className="btn q sm"
            disabled={busy || moveTargets === 0 || picked.size === members.length}
            title={moveTargets === 0 ? 'No other group on this pair' : undefined}
            onClick={act(onMove)}
          >
            Move to group
          </button>
          <button className="btn q sm" disabled={busy} onClick={act(onSetAside)}>
            Set aside
          </button>
        </div>
      )}
    </section>
  );
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
}
