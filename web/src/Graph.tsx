import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { accountCode, fetchGraph, type GraphMode, type GraphNode } from './api';

const WIDTH = 1200;
const HEIGHT = 250;
const MODES: GraphMode[] = ['diff', 'p1', 'p2'];
const STATUSES = ['NEW', 'SHIFTED', 'VANISHED', 'STABLE'] as const;

interface Point {
  x: number;
  y: number;
}

/**
 * Account pairs over the two periods. The layout is a ring rather than a force
 * simulation: with 34 accounts the interesting thing is which pairs changed, and
 * a ring keeps every node reachable to drag without settling animations.
 */
export function Graph({ onPickPair }: { onPickPair: (pair: [string, string]) => void }) {
  const [mode, setMode] = useState<GraphMode>('diff');
  const { data } = useQuery({ queryKey: ['graph', mode], queryFn: () => fetchGraph(mode) });

  const svg = useRef<SVGSVGElement>(null);
  const [dragged, setDragged] = useState<Record<string, Point>>({});
  const [dragging, setDragging] = useState<string | null>(null);

  const nodes = data?.nodes ?? [];
  const ring = useMemo(() => ringLayout(nodes), [nodes]);
  const at = (id: string) => dragged[id] ?? ring[id] ?? { x: 0, y: 0 };

  const maxVolume = Math.max(1, ...nodes.map((n) => n.volume));
  const radius = (node: GraphNode) => 8 + 9 * Math.sqrt(node.volume / maxVolume);

  const edges = (data?.edges ?? []).map((edge) => ({
    ...edge,
    status: 'status' in edge ? edge.status : 'STABLE',
    weight: 'status' in edge ? Math.max(edge.p1Count, edge.p2Count) : edge.count,
  }));
  const maxWeight = Math.max(1, ...edges.map((e) => e.weight));

  // Pointer capture, not component state, decides whether a move is a drag: the
  // first move can arrive before the state that set it has re-rendered.
  function move(event: React.PointerEvent<SVGCircleElement>, id: string) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !svg.current) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      svg.current.getScreenCTM()!.inverse(),
    );
    setDragged((previous) => ({
      ...previous,
      [id]: { x: clamp(point.x, 20, WIDTH - 20), y: clamp(point.y, 20, HEIGHT - 24) },
    }));
  }

  return (
    <div className="graph" data-open="1">
      <div className="gb">
        <span className="lab">Account pairs</span>
        <span className="seg">
          {MODES.map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button className="btn q sm" onClick={() => setDragged({})} disabled={!hasKeys(dragged)}>
          Reset layout
        </button>
      </div>

      <div className="gw">
        <svg ref={svg} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMid meet">
          {edges.map((edge) => {
            const a = at(edge.source);
            const b = at(edge.target);
            return (
              <g key={edge.id}>
                <line
                  className="ehit"
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  onClick={() => onPickPair([edge.source, edge.target])}
                >
                  <title>
                    {accountCode(edge.source)} to {accountCode(edge.target)}, {edge.status}
                  </title>
                </line>
                <line
                  className={`eg ${edge.status}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  strokeWidth={1.5 + 5 * Math.sqrt(edge.weight / maxWeight)}
                />
              </g>
            );
          })}

          {nodes.map((node) => {
            const { x, y } = at(node.id);
            const r = radius(node);
            return (
              <g key={node.id}>
                <circle
                  className={dragging === node.id ? 'gnode drag' : 'gnode'}
                  cx={x}
                  cy={y}
                  r={r}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragging(node.id);
                  }}
                  onPointerMove={(event) => move(event, node.id)}
                  onPointerUp={() => setDragging(null)}
                >
                  <title>{node.id}</title>
                </circle>
                <text className="glab" x={x} y={y + r + 11} textAnchor="middle">
                  {accountCode(node.id)}
                </text>
              </g>
            );
          })}
        </svg>

        <div className="gside">
          <div className="lab" style={{ marginBottom: 'var(--sp3)' }}>
            {mode === 'diff' ? 'Status' : 'Pairs'}
          </div>
          {mode === 'diff' ? (
            <div className="key">
              {STATUSES.map((status) => (
                <div key={status}>
                  <Stroke status={status} />
                  {status}
                  <span style={{ marginLeft: 'auto' }} className="mono">
                    {edges.filter((e) => e.status === status).length}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="key">
              <div>
                pairs
                <span style={{ marginLeft: 'auto' }} className="mono">
                  {edges.length}
                </span>
              </div>
              <div>
                accounts
                <span style={{ marginLeft: 'auto' }} className="mono">
                  {nodes.length}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stroke({ status }: { status: (typeof STATUSES)[number] }) {
  return (
    <svg width="26" height="8">
      <line className={`eg ${status}`} x1="0" y1="4" x2="26" y2="4" strokeWidth="5" />
    </svg>
  );
}

/**
 * Accounts sit on an ellipse grouped by root type, so related ones stay adjacent.
 * Spacing is by arc length rather than by angle: on a wide ellipse equal angles
 * bunch the nodes at both ends and their labels collide.
 */
function ringLayout(nodes: GraphNode[]): Record<string, Point> {
  const ordered = [...nodes].sort(
    (a, b) => a.rootType.localeCompare(b.rootType) || a.id.localeCompare(b.id),
  );
  const rx = WIDTH / 2 - 70;
  const ry = HEIGHT / 2 - 38;

  const steps = 2000;
  const point = (t: number) => ({
    x: WIDTH / 2 + Math.cos(t) * rx,
    y: HEIGHT / 2 + Math.sin(t) * ry,
  });
  const arc = [0];
  for (let i = 1; i <= steps; i++) {
    const from = point(((i - 1) / steps) * Math.PI * 2);
    const to = point((i / steps) * Math.PI * 2);
    arc.push(arc[i - 1]! + Math.hypot(to.x - from.x, to.y - from.y));
  }

  const positions: Record<string, Point> = {};
  let step = 0;
  ordered.forEach((node, i) => {
    const target = (i / ordered.length) * arc[steps]!;
    while (step < steps && arc[step]! < target) step++;
    positions[node.id] = point((step / steps) * Math.PI * 2);
  });
  return positions;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const hasKeys = (record: Record<string, unknown>) => Object.keys(record).length > 0;
