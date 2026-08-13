import { useState, type ReactNode } from 'react';
import { accountCode, itemState, type QueueItem } from './api';

function Modal({
  title,
  width,
  onClose,
  children,
  footer,
}: {
  title: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="scrim" data-open="1" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-label={title}>
        <header>
          <h3>{title}</h3>
          <span style={{ marginLeft: 'auto' }} />
          <button className="btn q" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="mb">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** Parking and reopening both need a reason on the record, so both ask for one. */
export function Reason({
  title,
  action,
  placeholder,
  busy,
  onSubmit,
  onClose,
}: {
  title: string;
  action: string;
  placeholder: string;
  busy: boolean;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const submit = () => reason.trim() && onSubmit(reason.trim());

  return (
    <Modal
      title={title}
      width={460}
      onClose={onClose}
      footer={
        <>
          <span style={{ marginLeft: 'auto' }} />
          <button className="btn" disabled={busy || !reason.trim()} onClick={submit}>
            {action}
          </button>
        </>
      }
    >
      <label className="lab" htmlFor="reason" style={{ display: 'block', marginBottom: 'var(--sp2)' }}>
        Reason
      </label>
      <input
        id="reason"
        className="rsn"
        autoFocus
        value={reason}
        placeholder={placeholder}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
    </Modal>
  );
}

/** Only groups on the same account pair can take the entries; the engine rejects the rest. */
export function GroupPicker({
  targets,
  count,
  onPick,
  onClose,
}: {
  targets: QueueItem[];
  count: number;
  onPick: (groupId: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={`Move ${count} ${count === 1 ? 'entry' : 'entries'} to`} width={460} onClose={onClose}>
      <div className="pick">
        {targets.map((target) => (
          <button key={target.groupId} onClick={() => onPick(target.groupId)}>
            <span className="p">
              {accountCode(target.accountA)} / {accountCode(target.accountB)}
            </span>
            <span className="r">
              {target.entryCount}, {itemState(target) === 'concluded' ? 'concluded' : target.recurrence.label}
            </span>
          </button>
        ))}
      </div>
      <div className="exportnote" style={{ margin: 'var(--sp4) 0 0' }}>
        Moving into a concluded group supersedes its conclusion.
      </div>
    </Modal>
  );
}
