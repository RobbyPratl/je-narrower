import {
  conclusionLabels,
  itemState,
  pairLabel,
  type Loaded,
  type QueueItem,
} from './api';
import { buildWorkbook, download } from './xlsx';
import { workpaperSheets } from './workpaper';

export function Export({
  items,
  status,
  onClose,
}: {
  items: QueueItem[];
  status: Loaded;
  onClose: () => void;
}) {
  const concluded = items.filter((i) => itemState(i) === 'concluded');
  const aside = items.filter((i) => itemState(i) === 'aside');
  const open = items.filter((i) => itemState(i) === 'open');
  const superseded = items.flatMap((i) => i.supersededDecisions.map((d) => ({ item: i, prior: d })));

  return (
    <div className="scrim" data-open="1" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Export workpaper">
        <header>
          <h3>Export workpaper</h3>
          <span style={{ marginLeft: 'auto' }} />
          <button className="btn q" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="mb">
          <p className="exportnote">
            Two sheets: every flagged item with the rules that fired and its conclusion, then the
            conclusions that were superseded.
          </p>
          <table className="xtab">
            <thead>
              <tr>
                <th>Item</th>
                <th>Entries</th>
                <th>State</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {[...concluded, ...aside, ...open].map((item) => (
                <tr key={item.groupId}>
                  <td className="m">{pairLabel(item)}</td>
                  <td className="m">{item.entryCount}</td>
                  <td className={item.decision ? 'm' : 'dim'}>
                    {item.decision ? conclusionLabels[item.decision.conclusion] : 'open'}
                  </td>
                  <td className="dim">{item.decision?.basis.slice(0, 70) ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer>
          <span className="exportcount">
            <b className="mono">{concluded.length}</b> concluded,{' '}
            <b className="mono">{open.length}</b> open, <b className="mono">{aside.length}</b> set
            aside, <b className="mono">{superseded.length}</b> superseded
          </span>
          <span style={{ marginLeft: 'auto' }} />
          <button
            className="btn go"
            onClick={() => {
              download(buildWorkbook(workpaperSheets(items, status)), `${status.dataset}-workpaper.xlsx`);
              onClose();
            }}
          >
            Download .xlsx
          </button>
        </footer>
      </div>
    </div>
  );
}
