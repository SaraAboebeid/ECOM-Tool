import { useMemo } from 'react';
import { Link, Node } from '../../../types';

interface FlowSparklineProps {
  node: Node;
  links: Link[];
}

const WIDTH = 268;
const HEIGHT = 64;
const PAD = { top: 6, right: 2, bottom: 14, left: 30 };

const IN_COLOR = '#22d3ee';
const OUT_COLOR = '#f97316';

/** An endpoint is an id before D3 runs and a node object after. */
const idOf = (end: unknown): string =>
  typeof end === 'string' ? end : ((end as { id?: string })?.id ?? '');

const niceCeiling = (value: number): number => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((m) => m * magnitude).find((c) => c >= value) ?? value;
};

const format = (kwh: number): string =>
  kwh >= 1000 ? `${(kwh / 1000).toFixed(1)} MWh` : `${kwh.toFixed(1)} kWh`;

/**
 * Hourly energy in and out of one node, on a shared axis.
 *
 * Replaces a pair of separate D3 charts that had two faults: they sliced the
 * flow to 24 hours when the dispatch runs 48, so half of every series was
 * dropped; and they matched links with `link.target === node.id`, which is only
 * true before D3 replaces the endpoints with node objects - after the
 * simulation starts, every comparison failed and the charts read as empty.
 *
 * One axis for both directions, because the question is whether a node is a net
 * source or a net sink, and two independently-scaled charts cannot answer it.
 */
export const FlowSparkline: React.FC<FlowSparklineProps> = ({ node, links }) => {
  const { inPath, outPath, max, hours, inTotal, outTotal } = useMemo(() => {
    const hours = Math.max(...links.map((l) => (l as any).flow?.length ?? 0), 0);
    const incoming = new Array(hours).fill(0);
    const outgoing = new Array(hours).fill(0);

    for (const link of links) {
      const flow = (link as any).flow as number[] | undefined;
      if (!flow) continue;
      const isIn = idOf((link as any).target) === node.id;
      const isOut = idOf((link as any).source) === node.id;
      if (!isIn && !isOut) continue;
      const bucket = isIn ? incoming : outgoing;
      for (let h = 0; h < flow.length && h < hours; h += 1) {
        const value = Number(flow[h]);
        if (Number.isFinite(value) && value > 0) bucket[h] += value;
      }
    }

    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const max = niceCeiling(Math.max(...incoming, ...outgoing, 0));
    const x = (i: number) => PAD.left + (hours > 1 ? (i / (hours - 1)) * plotW : 0);
    const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
    const toPath = (values: number[]) =>
      values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

    return {
      inPath: toPath(incoming),
      outPath: toPath(outgoing),
      max,
      hours,
      inTotal: incoming.reduce((a, b) => a + b, 0),
      outTotal: outgoing.reduce((a, b) => a + b, 0),
    };
  }, [node.id, links]);

  if (hours < 2) return null;

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img"
           aria-label={`Hourly flow in and out of ${node.name || node.id}`}>
        {[0, 1].map((fraction) => {
          const y = PAD.top + (HEIGHT - PAD.top - PAD.bottom) * (1 - fraction);
          return (
            <g key={fraction}>
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y}
                    className="analytics-gridline" />
              <text x={PAD.left - 5} y={y + 3} textAnchor="end"
                    className="analytics-axis-label">
                {fraction === 0 ? 0 : max}
              </text>
            </g>
          );
        })}
        <path d={outPath} fill="none" stroke={OUT_COLOR} strokeWidth={1.5}
              strokeLinejoin="round" />
        <path d={inPath} fill="none" stroke={IN_COLOR} strokeWidth={1.5}
              strokeLinejoin="round" />
        <text x={PAD.left} y={HEIGHT - 3} className="analytics-axis-label">0h</text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 3} textAnchor="end"
              className="analytics-axis-label">{hours}h</text>
      </svg>

      <div className="flex gap-4 mt-1">
        <span className="detail-flow-key">
          <span className="analytics-swatch analytics-swatch--line"
                style={{ background: IN_COLOR }} aria-hidden />
          In <b>{format(inTotal)}</b>
        </span>
        <span className="detail-flow-key">
          <span className="analytics-swatch analytics-swatch--line"
                style={{ background: OUT_COLOR }} aria-hidden />
          Out <b>{format(outTotal)}</b>
        </span>
      </div>
    </div>
  );
};

export default FlowSparkline;
