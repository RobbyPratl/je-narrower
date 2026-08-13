import { Fragment } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountCode, fetchCase, fetchEntry, reinvestigateEntry, type CaseFile, type Citation, type EntryRow } from './api';
import {
  combinedScoreHelp,
  HelpTip,
  investigationStepLabel,
  ruleDescription,
  RuleTerm,
} from './Terminology';

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
  const { data: caseFile, isLoading: caseLoading, error: caseError } = useQuery({
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
      <section className="sec" id="review-overview">
        <div className="sech">
          <span className="lab">Selection criteria</span>
          <span className="dstat">{detail.scores.length} {detail.scores.length === 1 ? 'criterion' : 'criteria'}</span>
        </div>
        <div className="criteria">
          {detail.scores.map((rule) => (
            <div className="criterion" key={rule.rule}>
              <div><RuleTerm rule={rule.rule} /></div>
              <p>{criterionEvidence(rule.rule, rule.inputs)}</p>
            </div>
          ))}
        </div>
        <details className="technical">
          <summary>Technical scoring details</summary>
          <dl className="kv">
            {detail.scores.map((rule) => (
              <Fragment key={rule.rule}>
                <dt>{rule.rule}</dt>
                <dd>{rule.score.toFixed(4)}</dd>
              </Fragment>
            ))}
            <dt className="strong">
              Combined selection score <HelpTip label="Combined selection score">{combinedScoreHelp}</HelpTip>
            </dt>
            <dd>{detail.composite.toFixed(4)}</dd>
          </dl>
          {detail.scores.map((rule) => (
            <div className="ruleinputs" key={rule.rule}>
              <span className="dim">{rule.rule}</span>
              {Object.entries(rule.inputs)
                .filter(([, value]) => value !== null && value !== '')
                .map(([key, value]) => (
                  <span key={key}>
                    <span className="dim">{key}</span> {formatInput(value)}
                  </span>
                ))}
            </div>
          ))}
        </details>
      </section>

      <section className="sec" id="review-evidence">
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
                <th>Account</th>
                <th className="r">Debit</th>
                <th className="r">Credit</th>
                <th>Memo</th>
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

      <section className="sec" id="review-investigation">
        <div className="sech">
          <span className="lab">Investigation note</span>
          {generationLabel(caseFile, caseLoading) && (
            <span className="dstat" title={caseFile?.model}>{generationLabel(caseFile, caseLoading)}</span>
          )}
          <button className="btn primary sm" disabled={llm.isPending || caseLoading} onClick={() => llm.mutate()}>
            {generationAction(caseFile, llm.isPending)}
          </button>
        </div>
        {caseLoading ? (
          <div className="neutralstate">Checking for an existing investigation note…</div>
        ) : caseError ? (
          <div className="warnline">{caseError.message}</div>
        ) : caseFile ? (
          <>
            <div className="trace">
              <span className="lab">Evidence reviewed</span>
              <div className="plan">
                {caseFile.agent.plan.map((step, index) => (
                  <span className={step.executed ? 'planstep' : 'planstep incomplete'} key={step.step} title={step.tool}>
                    {index > 0 && <i className="seprule" />}
                    {investigationStepLabel(step.tool)}
                    {!step.executed && <em>Not completed</em>}
                  </span>
                ))}
              </div>
            </div>
            {caseFile.agent.findings.map((finding) => (
              <div className="fact" key={finding.text}>
                {finding.text}
                {finding.citations.map((citation) => (
                  <Cite key={citation.ref + citation.kind} citation={citation} />
                ))}
              </div>
            ))}
          </>
        ) : (
          <div className="neutralstate">
            No investigation note has been generated for this entry. Generate one from the current
            entry, account-combination history and preparer activity.
          </div>
        )}
        {llm.error && <div className="warnline">{llm.error.message}</div>}
      </section>

      {caseFile && (
        <section className="sec">
          <div className="sech">
            <span className="lab">Citation verification</span>
          </div>
          <div className="ver">
            <div>
              <b>{caseFile.verifier.status === 'passed' ? 'Passed' : 'Review required'}</b>
              {caseFile.verifier.checkedCitations} citations resolved
            </div>
            {caseFile.verifier.failures.length > 0 && (
              <div className="un">{caseFile.verifier.failures.length} could not be resolved</div>
            )}
          </div>
        </section>
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

function generationLabel(caseFile: CaseFile | null | undefined, loading: boolean): string {
  if (loading) return 'Checking status';
  if (!caseFile) return 'Not generated';
  if (isDemoCase(caseFile)) return '';
  if (caseFile.model.startsWith('template:')) return 'Deterministic note';
  return caseFile.agent.findings.length > 0 ? 'LLM generated' : 'LLM attempt failed';
}

function generationAction(caseFile: CaseFile | null | undefined, pending: boolean): string {
  if (pending) return 'Generating…';
  if (!caseFile || isDemoCase(caseFile) || caseFile.model.startsWith('template:')) {
    return 'Generate LLM note';
  }
  return isFailedLlmCase(caseFile) ? 'Retry LLM note' : 'Regenerate LLM note';
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

function criterionEvidence(rule: string, inputs: Record<string, unknown>): string {
  if (rule === 'round_amount') {
    return `${moneyValue(inputs.amountCents)} is an exact multiple of ${moneyValue(inputs.modulusCents)}.`;
  }
  if (rule === 'date_mismatch') {
    return `Posted ${numberValue(inputs.lagDays)} days after the effective date.`;
  }
  if (rule === 'off_hours') {
    const posted = typeof inputs.postedAt === 'string' ? formatDateTime(inputs.postedAt) : 'outside normal hours';
    return inputs.isWeekend === true ? `Posted on a weekend at ${posted}.` : `Posted outside normal hours at ${posted}.`;
  }
  if (rule === 'entry_size_outlier') {
    return `${numberValue(inputs.lineCount)} lines compared with a period threshold of ${numberValue(inputs.threshold)}.`;
  }
  if (rule === 'unusual_user') {
    return `${String(inputs.user ?? 'This preparer')} posted ${numberValue(inputs.userCount)} of ${numberValue(inputs.accountCount)} entries on ${accountCode(String(inputs.account ?? 'the account'))}.`;
  }
  if (rule === 'threshold_proximity') {
    return `${moneyValue(inputs.amountCents)} is ${percentValue(inputs.gapPct)} below the ${moneyValue(inputs.boundaryCents)} review threshold.`;
  }
  if (rule === 'pair_rarity') {
    return `${pairValue(inputs.pair)} occurred ${numberValue(inputs.count)} ${numberValue(inputs.count) === '1' ? 'time' : 'times'} in ${String(inputs.period ?? 'the period')}.`;
  }
  if (rule === 'new_pair_emergence') {
    const previous = numberValue(inputs.p1Count);
    const current = numberValue(inputs.p2Count);
    return inputs.status === 'NEW'
      ? `${pairValue(inputs.pair)} did not occur in the comparison period and occurred ${current} ${current === '1' ? 'time' : 'times'} in the current period.`
      : `${pairValue(inputs.pair)} changed from ${previous} occurrences in the comparison period to ${current} in the current period.`;
  }
  return ruleDescription(rule);
}

function pairValue(value: unknown): string {
  return String(value ?? 'The account combination')
    .split('\u2194')
    .map((part) => accountCode(part))
    .join(' / ');
}

function numberValue(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : String(value ?? 'Not available');
}

function moneyValue(value: unknown): string {
  return typeof value === 'number' ? `$${money(value)}` : 'the configured amount';
}

function percentValue(value: unknown): string {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'within the configured range';
}
