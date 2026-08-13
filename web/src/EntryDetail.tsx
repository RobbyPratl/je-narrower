import { Fragment } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountCode, fetchCase, fetchEntry, reinvestigateEntry, type CaseFile, type Citation, type EntryRow } from './api';
import { combinedScoreHelp, HelpTip, RuleTerm } from './Terminology';

/**
 * Deviations and individuals are one entry, so the evidence is the entry itself
 * rather than a membership. Sections are ordered by how checkable they are:
 * deterministic scores, then the source rows, then what the agent retrieved.
 */
export function EntryDetail({ entryId, peers }: { entryId: string; peers: EntryRow[] }) {
  const queryClient = useQueryClient();
  const { data: detail } = useQuery({
    queryKey: ['entry', entryId],
    queryFn: () => fetchEntry(entryId),
  });
  const { data: caseFile } = useQuery({
    queryKey: ['case', entryId],
    queryFn: () => fetchCase(entryId),
  });
  const llm = useMutation({
    mutationFn: () => reinvestigateEntry(entryId),
    onSuccess: (next) => queryClient.setQueryData(['case', entryId], next),
  });

  if (!detail) return null;
  const { entry, lines } = detail;
  const balanced = sum(lines.map((l) => l.debit)) === sum(lines.map((l) => l.credit));

  return (
    <>
      <section className="sec">
        <div className="sech">
          <span className="lab">Selection criteria</span>
        </div>
        <dl className="kv">
          {detail.scores.map((rule) => (
            <Fragment key={rule.rule}>
              <dt><RuleTerm rule={rule.rule} /></dt>
              <dd>{rule.score.toFixed(2)}</dd>
            </Fragment>
          ))}
          <dt className="strong">
            Combined selection score <HelpTip label="Combined selection score">{combinedScoreHelp}</HelpTip>
          </dt>
          <dd>{detail.composite.toFixed(2)}</dd>
        </dl>
        {detail.scores.map((rule) => (
          <div className="ruleinputs" key={rule.rule}>
            <span className="dim">{rule.rule.replaceAll('_', ' ')}</span>
            {Object.entries(rule.inputs)
              .filter(([, value]) => value !== null && value !== '')
              .map(([key, value]) => (
                <span key={key}>
                  <span className="dim">{key}</span> {formatInput(value)}
                </span>
              ))}
          </div>
        ))}
      </section>

      <section className="sec">
        <div className="sech">
          <span className="lab">Source facts</span>
        </div>
        <div className="fact">
          posted {formatDateTime(entry.postedAt)} by {entry.user}
        </div>
        <div className="fact">
          {entry.narration ? `narration "${entry.narration}"` : 'no narration'}
        </div>
        <div className="fact">
          {lines.length} lines, {balanced ? 'balanced' : 'not balanced'}
        </div>

        <div className="tpanel" style={{ marginTop: 'var(--sp3)' }}>
          <table className="mtab">
            <thead>
              <tr>
                <th>account</th>
                <th className="r">debit</th>
                <th className="r">credit</th>
                <th>memo</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.lineId}>
                  <td className="m">{line.account}</td>
                  <td className="amt">{line.debit ? money(line.debit) : ''}</td>
                  <td className="amt">{line.credit ? money(line.credit) : ''}</td>
                  <td className="dim">{line.memo ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {peers.length > 2 && <Distribution entry={entry.totalAmount} peers={peers} />}

      {caseFile && (
        <>
          <section className="sec">
            <div className="sech">
              <span className="lab">Investigation note</span>
              <span className="dstat" title={caseFile.model}>{generationLabel(caseFile)}</span>
            </div>
            <div className="plan">
              {caseFile.agent.plan.map((step) => (
                <span key={step.step}>
                  {step.step > 1 && <i className="seprule" />}
                  {step.tool}
                </span>
              ))}
            </div>
            {caseFile.agent.findings.map((finding) => (
              <div className="fact" key={finding.text}>
                {finding.text}
                {finding.citations.map((citation) => (
                  <Cite key={citation.ref + citation.kind} citation={citation} />
                ))}
              </div>
            ))}
            {(isDemoCase(caseFile) || isFailedLlmCase(caseFile)) && (
              <div className="llmtry">
                <button className="btn sm" disabled={llm.isPending} onClick={() => llm.mutate()}>
                  {llm.isPending
                    ? 'Generating…'
                    : isFailedLlmCase(caseFile)
                      ? 'Retry configured LLM'
                      : 'Generate with configured LLM'}
                </button>
                <span>{isDemoCase(caseFile) ? 'The saved demo note will be replaced.' : 'The failed attempt will be replaced.'}</span>
              </div>
            )}
            {llm.error && <div className="warnline">{llm.error.message}</div>}
          </section>

          <section className="sec">
            <div className="sech">
              <span className="lab">Citation check</span>
            </div>
            <div className="ver">
              <div>
                <span className={caseFile.verifier.status === 'passed' ? 'sdot' : 'sdot mute'} />
                {caseFile.verifier.checkedCitations} citations resolved
              </div>
              {caseFile.verifier.failures.length > 0 && (
                <div className="un">{caseFile.verifier.failures.length} could not be resolved</div>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}

function isDemoCase(caseFile: CaseFile): boolean {
  return caseFile.model.startsWith('demo:') || caseFile.model.startsWith('mock:');
}

function isFailedLlmCase(caseFile: CaseFile): boolean {
  return !isDemoCase(caseFile)
    && !caseFile.model.startsWith('template:')
    && caseFile.agent.findings.length === 0;
}

function generationLabel(caseFile: CaseFile): string {
  if (isDemoCase(caseFile)) return 'Demo data';
  if (caseFile.model.startsWith('template:')) return 'Rule generated';
  return caseFile.agent.findings.length > 0 ? 'LLM generated' : 'LLM attempt failed';
}

/** The account's amounts, with this entry marked. "Far out on the right" is a shape. */
function Distribution({ entry, peers }: { entry: number; peers: EntryRow[] }) {
  const amounts = peers.map((p) => p.totalAmount);
  const max = Math.max(...amounts, entry);
  const buckets = new Array(14).fill(0);
  for (const amount of amounts) {
    buckets[Math.min(13, Math.floor((amount / max) * 14))]!++;
  }
  const tallest = Math.max(...buckets);

  return (
    <section className="sec">
      <div className="sech">
        <span className="lab">Amount distribution</span>
        <span className="dstat">{peers.length} entries on this account</span>
      </div>
      <div className="dist">
        <div className="plot">
          {buckets.map((count, i) => (
            <i key={i} style={{ height: `${tallest ? (count / tallest) * 100 : 0}%` }} />
          ))}
          <span className="mk" style={{ left: `${(entry / max) * 100}%` }} />
        </div>
        <div className="cap">
          <span>{money(Math.min(...amounts))}</span>
          <span style={{ color: 'var(--signal)' }}>this entry {money(entry)}</span>
          <span>{money(max)}</span>
        </div>
      </div>
    </section>
  );
}

function Cite({ citation }: { citation: Citation }) {
  return (
    <span className="cite" title={`${citation.kind} ${citation.ref}`}>
      {citation.kind === 'line' ? 'line' : 'entry'}
    </span>
  );
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatInput(value: unknown): string {
  if (typeof value === 'number') return String(value);
  return String(value)
    .split('\u2194')
    .map((part) => accountCode(part))
    .join(' / ');
}
