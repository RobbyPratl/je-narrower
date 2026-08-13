import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  concludeEntry,
  concludeGroup,
  conclusionLabels,
  fetchEntriesForAccount,
  fetchGroup,
  fetchStatus,
  pairLabel,
  pairNames,
  reopenDecision,
  updateMembers,
  type Conclusion,
  type Decision,
  type SupersededDecision,
  type EntryRow,
  type GroupSheet,
  type QueueItem,
  type Status,
} from './api';
import { MemberTable } from './MemberTable';
import { GroupPicker, Reason } from './Dialogs';
import { basisDetail, consistencyScore } from './consistency';
import { EntryDetail } from './EntryDetail';
import { HelpTip, patternConsistencyHelp, RuleTerm } from './Terminology';

const conclusions = Object.keys(conclusionLabels).filter(
  (c) => c !== 'set-aside',
) as Conclusion[];

type Ask =
  | { kind: 'aside'; entryIds: string[] }
  | { kind: 'move'; entryIds: string[] }
  | { kind: 'reopen'; decisionId: string };

export function Workbench({
  item,
  items,
  onSelectItem,
  onReviewRecorded,
}: {
  item: QueueItem | null;
  items: QueueItem[];
  onSelectItem: (groupId: string) => void;
  onReviewRecorded: () => void;
}) {
  const queryClient = useQueryClient();
  const groupId = item?.groupId ?? null;
  const workbench = useRef<HTMLDivElement>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const basisField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    workbench.current?.scrollTo({ top: 0 });
  }, [groupId]);

  const { data: sheet } = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => fetchGroup(groupId!),
    enabled: groupId !== null,
  });

  const { data: status } = useQuery({ queryKey: ['status'], queryFn: fetchStatus });

  const { data: entries } = useQuery({
    queryKey: ['entries', item?.accountA],
    queryFn: () => fetchEntriesForAccount(item!.accountA),
    enabled: item !== null,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['queue'] }),
      queryClient.invalidateQueries({ queryKey: ['group', groupId] }),
    ]);

  const members = useMutation({
    mutationFn: (change: Parameters<typeof updateMembers>[1]) => updateMembers(groupId!, change),
    onSuccess: refresh,
  });

  // Parking members is a removal plus a decision on each entry: the entry leaves
  // the group as its own item, and that item carries the reason.
  const setAside = useMutation({
    mutationFn: async ({ entryIds, reason }: { entryIds: string[]; reason: string }) => {
      await updateMembers(groupId!, { remove: entryIds });
      await Promise.all(
        entryIds.map((entryId) => concludeEntry(entryId, { conclusion: 'set-aside', basis: reason })),
      );
    },
    onSuccess: refresh,
  });

  const move = useMutation({
    mutationFn: ({ target, entryIds }: { target: string; entryIds: string[] }) =>
      updateMembers(target, { add: entryIds }),
    onSuccess: refresh,
  });

  const reopen = useMutation({
    mutationFn: ({ decisionId, reason }: { decisionId: string; reason: string }) =>
      reopenDecision(decisionId, reason),
    onSuccess: refresh,
  });

  // Only multi-entry groups take a group decision; deviations and individuals
  // record their disposition through the entry route.
  const conclude = useMutation({
    mutationFn: (body: { conclusion: Conclusion; basis: string; entryIds: string[] }) =>
      item?.kind === 'group'
        ? concludeGroup(groupId!, body)
        : concludeEntry(body.entryIds[0]!, { conclusion: body.conclusion, basis: body.basis }),
    onSuccess: async () => {
      await refresh();
      onReviewRecorded();
    },
  });

  if (!item) {
    return (
      <div className="wb">
        <div className="blank">
          <div className="h">Nothing selected</div>
          <div className="s">Pick an item from the worklist to start reviewing it.</div>
        </div>
      </div>
    );
  }

  const memberRows = sheet
    ? sheet.entryIds
        .map((id) => entries?.rows.find((row) => row.entryId === id))
        .filter((row) => row !== undefined)
    : [];
  const failure = members.error ?? conclude.error ?? setAside.error ?? move.error ?? reopen.error;
  const busy = members.isPending || setAside.isPending || move.isPending;
  // The engine only accepts entries into a group on the same account pair.
  const moveTargets = items.filter(
    (other) =>
      other.kind === 'group' &&
      other.groupId !== item.groupId &&
      other.accountA === item.accountA &&
      other.accountB === item.accountB,
  );
  // Recomputed locally so the screen responds to a removal at once; the
  // engine value replaces it as soon as the PATCH returns.
  const liveScore = memberRows.length > 0 ? consistencyScore(memberRows) : item.consistency.score;
  const liveBasis = memberRows.length > 0 ? basisDetail(memberRows) : [];

  return (
    <div className="wb" ref={workbench}>
      <div className="wbhead">
        <div className="recordheading">
          <div>
            <span className="recordkicker">{kindLabel(item.kind)} review item</span>
            <h2><span className="paircode mono">{pairLabel(item)}</span></h2>
            <p>{pairNames(item)}</p>
          </div>
          <div className="recordcount"><b className="mono">{item.entryCount}</b>{item.entryCount === 1 ? 'entry' : 'entries'}</div>
        </div>
        <div className="recordmeta">
          <span><b>Status</b>{item.decision ? 'Reviewed' : 'Open'}</span>
          {item.kind === 'group' ? (
            <>
              <span><b>Pattern consistency <HelpTip label="Pattern consistency">{patternConsistencyHelp}</HelpTip></b>{liveScore.toFixed(2)}</span>
              <span><b>Activity</b>{activityLabel(item)}</span>
            </>
          ) : (
            <span><b>Selection criteria</b>{item.rulesFired.length}</span>
          )}
        </div>
      </div>
      <nav className="recordnav" aria-label="Review item sections">
        <a href="#review-overview">Overview</a>
        <a href="#review-evidence">Evidence</a>
        <a href="#review-investigation">Investigation</a>
        <a href="#review-decision">Conclusion</a>
      </nav>

      {sheet && (
        <div className="fx">
          {sheet.decision && (
            <RecordedDecision
              decision={sheet.decision}
              onRevise={() => basisField.current?.focus()}
              onReopen={() => setAsk({ kind: 'reopen', decisionId: sheet.decision!.decisionId })}
            />
          )}
          {sheet.supersededDecisions.map((prior) => (
            <Superseded key={prior.decisionId} prior={prior} />
          ))}
          {failure && <div className="warnline">{failure.message}</div>}
          {item.kind === 'group' && (
            <PatternSummary item={item} sheet={sheet} onSelectItem={onSelectItem} />
          )}

          {item.kind === 'group' ? (
            <>
              {sheet.decision && (
                <div className="warnline">
                  Changing membership will supersede the conclusion recorded{' '}
                  {formatRecordedAt(sheet.decision.recordedAt)}.
                </div>
              )}

              <MemberTable
                members={memberRows}
                busy={busy}
                moveTargets={moveTargets.length}
                onRemove={(entryIds) => members.mutate({ remove: entryIds })}
                onSetAside={(entryIds) => setAsk({ kind: 'aside', entryIds })}
                onMove={(entryIds) => setAsk({ kind: 'move', entryIds })}
              />

              {item.rulesFired.length > 0 && (
                <section className="sec">
                  <div className="sech">
                    <span className="lab">Selection criteria</span>
                  </div>
                  <div className="rulist criterialist">
                    {item.rulesFired.map((rule, i) => (
                      <span key={rule}>
                        {i > 0 && <i className="seprule" />}
                        <RuleTerm rule={rule} />
                      </span>
                    ))}
                  </div>
                </section>
              )}

              <section className="sec">
                <div className="sech">
                  <span className="lab">Grouping basis</span>
                </div>
                <Separated
                  items={liveBasis.length > 0 ? liveBasis : sheet.groupingBasis.detail}
                  className="basisline"
                />
              </section>

              <section className="sec" id="review-investigation">
                <div className="sech">
                  <span className="lab">Investigation coverage</span>
                </div>
                <div className="proc">
                  {sheet.procedures.map((p) => (
                    <div className="prow" key={p.label}>
                      <span>{p.label}</span>
                      <span className={p.done < p.total ? 'v part' : 'v'}>
                        {p.done}/{p.total}
                      </span>
                      <span className="lk" />
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <EntryDetail entryId={sheet.entryIds[0]!} peers={entries?.rows ?? []} />
          )}

          <Conclude
            // Remount when the recorded decision changes: revising starts from
            // what was recorded, reopening starts from a fresh draft.
            key={`${sheet.groupId}:${sheet.decision?.decisionId ?? 'open'}`}
            sheet={sheet}
            members={memberRows}
            removed={item.entryCount - memberRows.length}
            busy={conclude.isPending}
            stamp={status ? populationStamp(status) : null}
            fieldRef={basisField}
            onRecord={(conclusion, basis) =>
              conclude.mutate({ conclusion, basis, entryIds: sheet.entryIds })
            }
          />
        </div>
      )}

      {ask?.kind === 'aside' && (
        <Reason
          title={`Set aside ${ask.entryIds.length} ${ask.entryIds.length === 1 ? 'entry' : 'entries'}`}
          action="Set aside"
          placeholder="awaiting the supplier invoice from the client"
          busy={setAside.isPending}
          onSubmit={(reason) => {
            setAside.mutate({ entryIds: ask.entryIds, reason });
            setAsk(null);
          }}
          onClose={() => setAsk(null)}
        />
      )}

      {ask?.kind === 'reopen' && (
        <Reason
          title="Reopen this item"
          action="Reopen"
          placeholder="new information from the client"
          busy={reopen.isPending}
          onSubmit={(reason) => {
            reopen.mutate({ decisionId: ask.decisionId, reason });
            setAsk(null);
          }}
          onClose={() => setAsk(null)}
        />
      )}

      {ask?.kind === 'move' && (
        <GroupPicker
          targets={moveTargets}
          count={ask.entryIds.length}
          onPick={(target) => {
            move.mutate({ target, entryIds: ask.entryIds });
            setAsk(null);
          }}
          onClose={() => setAsk(null)}
        />
      )}
    </div>
  );
}

function PatternSummary({
  item,
  sheet,
  onSelectItem,
}: {
  item: QueueItem;
  sheet: GroupSheet;
  onSelectItem: (groupId: string) => void;
}) {
  const activeMonths = item.recurrence.months.length;
  const deviationCount = sheet.excludedDeviations.reduce(
    (sum, deviation) => sum + deviation.entryIds.length,
    0,
  );

  return (
    <section className="sec patternsummary" id="review-overview" aria-label="Isolated deviations">
      <div className="sech">
        <span className="lab">Isolated deviations</span>
        <span className="dstat">
          {item.entryCount} pattern members · {activeMonths} active {activeMonths === 1 ? 'month' : 'months'} ·{' '}
          {deviationCount} {deviationCount === 1 ? 'deviation' : 'deviations'}
        </span>
      </div>
      {sheet.excludedDeviations.length === 0 ? (
        <div className="neutralstate">No deviations were isolated from this pattern.</div>
      ) : (
        <div className="tpanel">
          <table className="mtab deviationtable">
            <thead>
              <tr>
                <th>Entry</th>
                <th>Reason</th>
                <th><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {sheet.excludedDeviations.map((deviation) => (
                <tr key={deviation.groupId}>
                  <td className="mono signaltext">{deviation.entryIds.join(', ')}</td>
                  <td>
                    {deviation.reasons.length > 0
                      ? sentence(deviation.reasons.map(plainDeviationReason).join('; '))
                      : 'Isolated for separate review.'}
                  </td>
                  <td className="rowaction">
                    <button className="btn q sm" onClick={() => onSelectItem(deviation.groupId)}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function sentence(text: string): string {
  const value = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function kindLabel(kind: QueueItem['kind']): string {
  if (kind === 'group') return 'Pattern';
  if (kind === 'deviation') return 'Deviation';
  return 'Individual selection';
}

function activityLabel(item: QueueItem): string {
  const months = item.recurrence.months;
  if (months.length === 0) return 'No active months';
  if (months.length === 1) {
    return new Date(`${months[0]}-01T00:00:00`).toLocaleString('en-US', {
      month: 'short',
      year: 'numeric',
    });
  }
  return `${months.length} active months`;
}

function plainDeviationReason(reason: string): string {
  return reason.replace(/^deviates:\s*/i, '');
}

/** What the population looked like when the conclusion was written. */
function populationStamp(status: Status): string {
  if (status.status === 'empty' || status.status === 'load_failed') return 'no population loaded';
  const entries = status.periods.reduce((sum, period) => sum + period.entries, 0);
  return `${status.dataset}, ${status.status}, ${entries.toLocaleString()} entries`;
}

function Conclude({
  sheet,
  members,
  removed,
  busy,
  stamp,
  fieldRef,
  onRecord,
}: {
  sheet: GroupSheet;
  members: EntryRow[];
  removed: number;
  busy: boolean;
  stamp: string | null;
  fieldRef: React.RefObject<HTMLTextAreaElement | null>;
  onRecord: (conclusion: Conclusion, basis: string) => void;
}) {
  const recorded = sheet.decision;
  const [basis, setBasis] = useState(recorded?.basis ?? '');
  const [conclusion, setConclusion] = useState<Conclusion | null>(recorded?.conclusion ?? null);

  // Membership drives the wording, so a draft the auditor has not touched is
  // rewritten when the group changes. Anything they typed is left alone.
  const drafted = draftBasis(sheet, members, removed);
  const [touched, setTouched] = useState(recorded !== null);
  useEffect(() => {
    if (!touched) setBasis(drafted);
  }, [drafted, touched]);

  const record = (chosen: Conclusion) => {
    if (!basis.trim()) return;
    onRecord(chosen, basis.trim());
  };

  useEffect(() => {
    function commit(e: KeyboardEvent) {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      if (busy || !conclusion || !basis.trim()) return;
      e.preventDefault();
      onRecord(conclusion, basis.trim());
    }
    window.addEventListener('keydown', commit);
    return () => window.removeEventListener('keydown', commit);
  }, [busy, conclusion, basis, onRecord]);

  return (
    <section className="sec" id="review-decision">
      <div className="sech">
        <span className="lab">{recorded ? 'Basis' : 'Draft basis'}</span>
        {touched && <span className="dstat">Edited</span>}
      </div>

      <div className="paper">
        <textarea
          ref={fieldRef}
          className="dtext"
          value={basis}
          rows={6}
          onChange={(e) => {
            setTouched(true);
            setBasis(e.target.value);
          }}
          aria-label="Basis"
        />
        <div className="dstamp">
          {stamp}
          <Cites entryIds={sheet.entryIds} />
        </div>
      </div>

      <div className="sech" style={{ marginTop: 'var(--sp5)' }}>
        <span className="lab">Conclusion</span>
      </div>
      <div className="concl">
        {conclusions.map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="conclusion"
              checked={conclusion === value}
              onChange={() => setConclusion(value)}
            />
            {conclusionLabels[value]}
          </label>
        ))}
      </div>

      <div className="acts">
        <button className="btn q" disabled={busy || !basis.trim()} onClick={() => record('set-aside')}>
          Set aside
        </button>
        <button
          className="btn go"
          disabled={busy || !conclusion || !basis.trim()}
          onClick={() => conclusion && record(conclusion)}
        >
          {recorded ? 'Replace conclusion' : 'Record conclusion'}
        </button>
        <span className="hint">cmd + enter</span>
      </div>
    </section>
  );
}

function draftBasis(sheet: GroupSheet, members: EntryRow[], removed: number): string {
  const count = members.length || sheet.entryIds.length;
  const detail = members.length > 0 ? basisDetail(members) : sheet.groupingBasis.detail;

  const sentences = [
    count === 1
      ? `This entry uses account combination ${pairLabel(sheet)}.`
      : `These ${count} entries share account combination ${pairLabel(sheet)}.`,
    `${capitalise(detail.join(', '))}.`,
    'Line detail, prior-period comparison and preparer history were obtained for each entry.',
  ];
  if (removed > 0) {
    sentences.push(
      `${removed} ${removed === 1 ? 'entry was' : 'entries were'} removed from this group as ${
        removed === 1 ? 'a deviation' : 'deviations'
      } and ${removed === 1 ? 'is' : 'are'} reviewed separately.`,
    );
  }
  return sentences.join(' ');
}

/** The draft describes these entries, so a reviewer can check it against them. */
function Cites({ entryIds }: { entryIds: string[] }) {
  const shown = entryIds.slice(0, 4);
  return (
    <span className="cites">
      {shown.map((entryId) => (
        <span className="cite" key={entryId} title={entryId}>
          {entryId.split('-').slice(-2).join('-')}
        </span>
      ))}
      {entryIds.length > shown.length && <span className="dim">+{entryIds.length - shown.length}</span>}
    </span>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Separated({ items, className }: { items: string[]; className: string }) {
  return (
    <span className={className}>
      {items.map((text, i) => (
        <span key={text}>
          {i > 0 && <i className="seprule" />}
          {text}
        </span>
      ))}
    </span>
  );
}

function Superseded({ prior }: { prior: SupersededDecision }) {
  return (
    <div className="cb sup struck">
      <div className="top">
        <span className="decisionstate">Superseded</span>
        <b>{conclusionLabels[prior.conclusion]}</b>
        <span>superseded, {prior.reason}</span>
        <span className="who">
          {prior.recordedBy ?? 'unattributed'}, {formatRecordedAt(prior.recordedAt)}
        </span>
      </div>
    </div>
  );
}

function RecordedDecision({
  decision,
  onRevise,
  onReopen,
}: {
  decision: Decision;
  onRevise: () => void;
  onReopen: () => void;
}) {
  // Set aside is parked, not reviewed, so it reads muted rather than verified.
  const parked = decision.conclusion === 'set-aside';
  return (
    <div className={parked ? 'cb sup' : 'cb'}>
      <div className="top">
        <span className="decisionstate">{parked ? 'Set aside' : 'Reviewed'}</span>
        <b>{conclusionLabels[decision.conclusion]}</b>
        <span className="who">
          {decision.recordedBy ?? 'unattributed'}, {formatRecordedAt(decision.recordedAt)}
        </span>
        <button className="btn q sm" onClick={onRevise}>
          Revise
        </button>
        <button className="btn q sm" onClick={onReopen}>
          Reopen
        </button>
      </div>
      <div className="q">{decision.basis}</div>
    </div>
  );
}

function formatRecordedAt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
