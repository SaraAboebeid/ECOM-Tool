import { useState } from 'react';
import { SweepPoint, SweepVariable } from '../api/community';

/**
 * Cost against size.
 *
 * One series, so no legend box - the caption names it. The optimum is the whole
 * point of the chart, so it gets a ring and a direct label while every other
 * point stays a plain dot; labelling them all would bury the answer. Grid and
 * axes are recessive, and all text uses ink tokens rather than the series
 * colour, so identity is never carried by colour alone.
 */
interface CostCurveProps {
  points: SweepPoint[];
  best: SweepPoint;
  variable: SweepVariable;
  unit: string;
}

const W = 268;
const H = 132;
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

const SEK = (v: number) => `${Math.round(v).toLocaleString('sv-SE')} kr`;

export const CostCurve: React.FC<CostCurveProps> = ({
  points, best, variable, unit,
}) => {
  const [hover, setHover] = useState<SweepPoint | null>(null);

  if (points.length < 2) {
    return (
      <p className="text-[10px] text-slate-500">
        A curve needs at least two points.
      </p>
    );
  }

  const xs = points.map((p) => p.value);
  const ys = points.map((p) => p.overall_cost);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  // Pad the value axis so the cheapest point is not pinned to the frame, and
  // keep the baseline off zero: these costs never approach zero, so a zero
  // baseline would flatten the very differences the chart exists to show.
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const ySpan = yMax - yMin || 1;
  const yLo = yMin - ySpan * 0.15;
  const yHi = yMax + ySpan * 0.15;

  const px = (v: number) =>
    PAD.left + ((v - xMin) / (xMax - xMin || 1)) * (W - PAD.left - PAD.right);
  const py = (v: number) =>
    PAD.top + (1 - (v - yLo) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.value).toFixed(1)},${py(p.overall_cost).toFixed(1)}`)
    .join(' ');

  const shown = hover ?? best;
  const xLabel = variable === 'battery_kwh' ? 'Battery kWh' : 'Roof coverage %';

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto overflow-visible"
        role="img"
        aria-label={`Overall cost against ${xLabel}. Cheapest at ${best.value} ${unit}.`}
        onMouseLeave={() => setHover(null)}
      >
        {/* Recessive gridlines: three horizontal rules, no vertical clutter. */}
        {[0, 0.5, 1].map((t) => {
          const v = yLo + t * (yHi - yLo);
          return (
            <g key={t}>
              <line
                x1={PAD.left} x2={W - PAD.right}
                y1={py(v)} y2={py(v)}
                stroke="currentColor" strokeOpacity={0.12} strokeWidth={1}
                className="text-slate-500"
              />
              <text
                x={PAD.left - 5} y={py(v) + 3}
                textAnchor="end" fontSize="7"
                className="fill-slate-400 tabular-nums"
              >
                {Math.round(v / 1000)}k
              </text>
            </g>
          );
        })}

        <path d={path} fill="none" stroke="#0891b2" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" />

        {points.map((p) => {
          const isBest = p.value === best.value;
          return (
            <g key={p.value}>
              {isBest && (
                <circle cx={px(p.value)} cy={py(p.overall_cost)} r={6}
                        fill="none" stroke="#0891b2" strokeWidth={1.5}
                        strokeOpacity={0.5} />
              )}
              <circle
                cx={px(p.value)} cy={py(p.overall_cost)}
                r={isBest ? 3.5 : 2.5}
                fill={isBest ? '#0891b2' : '#ffffff'}
                stroke="#0891b2" strokeWidth={1.5}
              />
              {/* Hit target larger than the mark, per interaction guidance. */}
              <circle
                cx={px(p.value)} cy={py(p.overall_cost)} r={10}
                fill="transparent"
                onMouseEnter={() => setHover(p)}
                style={{ cursor: 'pointer' }}
              />
            </g>
          );
        })}

        {/* Direct label on the optimum only. */}
        <text
          x={px(best.value)}
          y={py(best.overall_cost) - 10}
          textAnchor={px(best.value) > W / 2 ? 'end' : 'start'}
          fontSize="7.5"
          fontWeight="700"
          className="fill-slate-700 dark:fill-slate-200 tabular-nums"
        >
          best {best.value}{unit === 'kWh' ? '' : '%'}
        </text>

        <text x={PAD.left} y={H - 6} fontSize="7" className="fill-slate-400 tabular-nums">
          {xMin}
        </text>
        <text x={W - PAD.right} y={H - 6} fontSize="7" textAnchor="end"
              className="fill-slate-400 tabular-nums">
          {xMax}
        </text>
        <text x={W / 2} y={H - 6} fontSize="7" textAnchor="middle"
              className="fill-slate-400">
          {xLabel}
        </text>
      </svg>

      <figcaption className="mt-1 text-[10px] text-slate-600 dark:text-slate-400 tabular-nums">
        <span className="font-semibold">
          {shown.value}{unit === 'kWh' ? ' kWh' : '% roof'}
        </span>
        {' · '}{SEK(shown.overall_cost)}
        {' · '}peak {Math.round(shown.peak_net_import_kw)} kW
        {hover ? '' : ' (cheapest)'}
      </figcaption>
    </figure>
  );
};

export default CostCurve;
