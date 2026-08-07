import { useEffect, useRef, useState } from 'react';
import {
  CommunityDefinition,
  OptimizeJob,
  OptimizerParameters,
  SweepResult,
  SweepVariable,
  getOptimizationJob,
  startSweep,
} from '../api/community';
import { CostCurve } from './CostCurve';

/**
 * Find the cheapest battery or PV size by sweeping it.
 *
 * LEC-Opt optimises operation for a size you give it; bess_capacity is a plain
 * float on the building object, never a decision variable. So sizing is an
 * outer loop - one full solve per candidate - which is why the point count is
 * small and the runtime estimate is shown before you start.
 */
const POLL_MS = 2000;
const MAX_POINTS = 12;

interface SizingPanelProps {
  definition: CommunityDefinition;
  parameters: OptimizerParameters;
}

const SEK = (v: number) => `${Math.round(v).toLocaleString('sv-SE')} kr`;

export const SizingPanel: React.FC<SizingPanelProps> = ({
  definition,
  parameters,
}) => {
  const [variable, setVariable] = useState<SweepVariable>('battery_kwh');
  const [maxValue, setMaxValue] = useState(1000);
  const [pointCount, setPointCount] = useState(6);
  const [days, setDays] = useState(1);
  const [job, setJob] = useState<OptimizeJob | null>(null);
  const [result, setResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<number | null>(null);

  useEffect(() => () => {
    if (poll.current !== null) window.clearInterval(poll.current);
  }, []);

  // PV is a percentage of roof, so its ceiling is fixed; battery is open-ended.
  const ceiling = variable === 'pv_percent' ? 80 : maxValue;
  const values = Array.from({ length: pointCount }, (_, i) =>
    Math.round((ceiling / (pointCount - 1)) * i)
  );

  const running = job?.status === 'queued' || job?.status === 'running';
  const buildings = definition.buildings?.length ?? 0;
  // The backend measures ~0.25 s per building-day, once per point.
  const estimate = Math.max(1, Math.round(buildings * days * 0.25 * pointCount));

  const run = async () => {
    setError(null);
    setResult(null);
    try {
      const submitted = await startSweep({
        community: definition,
        variable,
        values,
        days,
        parameters: Object.keys(parameters).length ? parameters : undefined,
      });
      setJob(submitted);
      if (poll.current !== null) window.clearInterval(poll.current);
      poll.current = window.setInterval(async () => {
        try {
          const next = await getOptimizationJob(submitted.id);
          setJob(next);
          if (next.status === 'done' || next.status === 'failed') {
            window.clearInterval(poll.current!);
            poll.current = null;
            if (next.status === 'done') setResult(next.result as SweepResult);
            else setError(next.error || 'sweep failed');
          }
        } catch (err) {
          window.clearInterval(poll.current!);
          poll.current = null;
          setError(String(err));
        }
      }, POLL_MS);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  return (
    <div className="text-[11px] text-slate-700 dark:text-slate-300">
      <div className="flex gap-1 mb-2">
        {([
          ['battery_kwh', 'Battery'],
          ['pv_percent', 'PV coverage'],
        ] as [SweepVariable, string][]).map(([key, label]) => (
          <button
            key={key}
            disabled={running}
            onClick={() => setVariable(key)}
            className={`flex-1 px-2 py-1 rounded-lg border text-[10px] font-semibold
                        transition-colors disabled:opacity-50 ${
                          variable === key
                            ? 'border-cyan-400 bg-cyan-50 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300'
                            : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
          >
            {label}
          </button>
        ))}
      </div>

      {variable === 'battery_kwh' && (
        <label className="block mb-1.5">
          <div className="flex justify-between text-[10px] mb-0.5">
            <span className="text-slate-500">Largest size to try</span>
            <span className="tabular-nums">{maxValue} kWh</span>
          </div>
          <input type="range" min={100} max={5000} step={100} value={maxValue}
                 disabled={running}
                 onChange={(e) => setMaxValue(Number(e.target.value))}
                 className="w-full accent-cyan-500" />
        </label>
      )}

      <div className="grid grid-cols-2 gap-2 mb-2">
        <label>
          <div className="flex justify-between text-[10px] mb-0.5">
            <span className="text-slate-500">Points</span>
            <span className="tabular-nums">{pointCount}</span>
          </div>
          <input type="range" min={3} max={MAX_POINTS} step={1} value={pointCount}
                 disabled={running}
                 onChange={(e) => setPointCount(Number(e.target.value))}
                 className="w-full accent-cyan-500" />
        </label>
        <label>
          <div className="flex justify-between text-[10px] mb-0.5">
            <span className="text-slate-500">Days each</span>
            <span className="tabular-nums">{days}</span>
          </div>
          <input type="range" min={1} max={7} step={1} value={days}
                 disabled={running}
                 onChange={(e) => setDays(Number(e.target.value))}
                 className="w-full accent-cyan-500" />
        </label>
      </div>

      <p className="text-[10px] text-slate-500 mb-2 tabular-nums">
        {pointCount} solves · {buildings} buildings · roughly {estimate}s
      </p>

      <button
        onClick={run}
        disabled={running}
        className="w-full text-xs px-3 py-1.5 rounded-lg bg-cyan-600 text-white
                   hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {running ? 'Sweeping…' : 'Find cheapest size'}
      </button>

      {running && (
        <p className="text-[10px] text-slate-500 mt-1.5">{job?.progress || 'queued'}</p>
      )}
      {error && (
        <p className="text-[10px] text-red-600 dark:text-red-400 mt-1.5 whitespace-pre-wrap">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-3">
          <CostCurve
            points={result.points}
            best={result.best}
            variable={result.variable}
            unit={result.unit}
          />

          <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-700">
            <div className="flex justify-between">
              <span className="text-slate-500">Cheapest</span>
              <span className="font-semibold tabular-nums">
                {result.best.value}
                {result.unit === 'kWh' ? ' kWh' : '% roof'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Saving vs smallest</span>
              <span
                className={`tabular-nums ${
                  result.saving_vs_baseline > 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-500'
                }`}
              >
                {result.saving_vs_baseline > 0 ? '−' : ''}
                {SEK(Math.abs(result.saving_vs_baseline))}
              </span>
            </div>
          </div>

          {result.notes?.length > 0 && (
            <ul className="mt-2 space-y-1 text-[10px] text-amber-700 dark:text-amber-400">
              {result.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default SizingPanel;
