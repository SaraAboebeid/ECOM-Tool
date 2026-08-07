import { useEffect, useRef, useState } from 'react';
import {
  CommunityDefinition,
  OptimizeJob,
  OptimizeResult,
  SolverStatus,
  getOptimizationJob,
  getSolverStatus,
  startOptimization,
} from '../api/community';

/**
 * Runs the LEC rolling-horizon optimizer over the current community.
 *
 * Deliberately a button rather than a live recompute. The dispatcher runs on
 * every slider move because it takes ~2 s; the optimizer costs roughly 0.25 s
 * per building-day, so 36 buildings over a year is about an hour. It is a job:
 * submit, poll, read the result.
 */
const POLL_INTERVAL_MS = 2000;

const SEK = (value: number) =>
  `${Math.round(value).toLocaleString('sv-SE')} kr`;

const KWH = (value: number) =>
  `${Math.round(value).toLocaleString('sv-SE')} kWh`;

interface OptimizationPanelProps {
  definition: CommunityDefinition;
  /** Only what the user changed; anything absent keeps LEC-Opt's default. */
  parameters?: Record<string, number>;
  /** Dispatcher cost for the same period, if known, to show the delta. */
  baselineCost?: number | null;
}

export const OptimizationPanel: React.FC<OptimizationPanelProps> = ({
  definition,
  baselineCost,
  parameters,
}) => {
  const [solver, setSolver] = useState<SolverStatus | null>(null);
  const [job, setJob] = useState<OptimizeJob | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(1);
  const [aging, setAging] = useState(false);
  const [v2g, setV2g] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    getSolverStatus()
      .then(setSolver)
      .catch((err) => setSolver({ available: false, detail: String(err) }));
  }, []);

  // Stop polling when the component goes away, so a long run does not keep
  // firing requests into a unmounted panel.
  useEffect(() => () => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
  }, []);

  const running = job?.status === 'queued' || job?.status === 'running';

  const poll = (jobId: string) => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const next = await getOptimizationJob(jobId);
        setJob(next);
        if (next.status === 'done' || next.status === 'failed') {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          pollRef.current = null;
          if (next.status === 'done' && next.result) setResult(next.result);
          if (next.status === 'failed') setError(next.error || 'optimization failed');
        }
      } catch (err) {
        if (pollRef.current !== null) window.clearInterval(pollRef.current);
        pollRef.current = null;
        setError(String(err));
      }
    }, POLL_INTERVAL_MS);
  };

  const run = async () => {
    setError(null);
    setResult(null);
    try {
      const submitted = await startOptimization({
        community: definition,
        days,
        horizon_hours: 36,
        store_hours: 24,
        aging,
        v2g,
        parameters:
          parameters && Object.keys(parameters).length ? parameters : undefined,
      });
      setJob(submitted);
      poll(submitted.id);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  const buildingCount = definition.buildings?.length ?? 0;
  // The backend's own measured rate; enough to set expectations before a run
  // that could take an hour.
  const estimateSeconds = Math.max(1, Math.round(buildingCount * days * 0.25));

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Optimization
        </h3>
        {solver && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              solver.available
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200'
                : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200'
            }`}
            title={solver.detail ?? undefined}
          >
            {solver.available ? solver.solver : 'unavailable'}
          </span>
        )}
      </div>

      {solver && !solver.available && (
        <p className="text-[11px] text-red-600 dark:text-red-400 mb-2">
          {solver.detail || 'No solver available on the server.'}
        </p>
      )}

      <label className="block mb-2">
        <div className="flex justify-between text-[11px] mb-1">
          <span className="text-gray-700 dark:text-gray-300">Days to optimise</span>
          <span className="text-gray-500 tabular-nums">{days}</span>
        </div>
        <input
          type="range"
          min={1}
          max={14}
          step={1}
          value={days}
          disabled={running}
          onChange={(e) => setDays(Number(e.target.value))}
          className="w-full"
        />
        <span className="text-[10px] text-gray-500">
          {buildingCount} buildings · roughly {estimateSeconds}s
        </span>
      </label>

      <div className="flex gap-3 mb-2 text-[11px]">
        <label className="flex items-center gap-1 text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={aging}
            disabled={running}
            onChange={(e) => setAging(e.target.checked)}
          />
          Battery aging
        </label>
        <label className="flex items-center gap-1 text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={v2g}
            disabled={running}
            onChange={(e) => setV2g(e.target.checked)}
          />
          V2G
        </label>
      </div>

      <button
        onClick={run}
        disabled={running || (solver ? !solver.available : false)}
        className="w-full text-xs px-3 py-1.5 rounded bg-sky-600 text-white
                   disabled:opacity-50 disabled:cursor-not-allowed hover:bg-sky-700"
      >
        {running ? 'Optimising…' : 'Run optimization'}
      </button>

      {running && (
        <p className="text-[11px] text-gray-500 mt-2">
          {job?.progress || 'queued'}
        </p>
      )}

      {error && (
        <p className="text-[11px] text-red-600 dark:text-red-400 mt-2 whitespace-pre-wrap">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-3 text-[11px]">
          <div className="flex justify-between text-gray-500 mb-1">
            <span>
              {result.days} day{result.days === 1 ? '' : 's'} · {result.hours} h
            </span>
            <span>{result.solver}</span>
          </div>

          <table className="w-full tabular-nums">
            <tbody>
              {([
                ['Supplier', result.totals.supplier_cost],
                ['Transmission', result.totals.transmission_cost],
                ['Peak', result.totals.peak_cost],
                ['DSO', result.totals.dso_cost],
                ['Tax', result.totals.tax_cost],
              ] as [string, number][]).map(([label, value]) => (
                <tr key={label}>
                  <td className="text-gray-600 dark:text-gray-400">{label}</td>
                  <td className="text-right">{SEK(value)}</td>
                </tr>
              ))}
              <tr className="border-t border-gray-200 dark:border-gray-700 font-semibold">
                <td>Total</td>
                <td className="text-right">{SEK(result.totals.overall_cost)}</td>
              </tr>
            </tbody>
          </table>

          <div className="mt-2 text-gray-600 dark:text-gray-400">
            <div className="flex justify-between">
              <span>Grid import</span>
              <span className="tabular-nums">{KWH(result.totals.grid_import_kwh)}</span>
            </div>
            <div className="flex justify-between">
              <span>Grid export</span>
              <span className="tabular-nums">{KWH(result.totals.grid_export_kwh)}</span>
            </div>
            <div className="flex justify-between">
              <span>Peak import</span>
              <span className="tabular-nums">
                {result.totals.peak_net_import_kw.toFixed(0)} kW
              </span>
            </div>
          </div>

          {baselineCost != null && baselineCost > 0 && (
            <p className="mt-2 text-gray-700 dark:text-gray-300">
              vs dispatcher:{' '}
              <span
                className={
                  result.totals.overall_cost < baselineCost
                    ? 'text-emerald-600'
                    : 'text-red-600'
                }
              >
                {result.totals.overall_cost < baselineCost ? '−' : '+'}
                {SEK(Math.abs(baselineCost - result.totals.overall_cost))}
              </span>
            </p>
          )}

          {result.notes?.length > 0 && (
            <ul className="mt-2 space-y-1 text-[10px] text-amber-700 dark:text-amber-400">
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default OptimizationPanel;
