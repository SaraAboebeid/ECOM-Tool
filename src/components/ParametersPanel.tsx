import { useEffect, useMemo, useState } from 'react';
import {
  OptimizerParameterInfo,
  OptimizerParameters,
  getOptimizerParameters,
} from '../api/community';

/**
 * The LEC-Opt constants, exposed for tuning.
 *
 * Every one of these was a literal inside functions1.py. Defaults are the
 * committed values, so an untouched panel reproduces the model exactly as the
 * optimization team runs it; provenance is shown because several of the numbers
 * are dated and two describe schemes that no longer exist.
 */
interface ParametersPanelProps {
  value: OptimizerParameters;
  onChange: (next: OptimizerParameters) => void;
}

export const ParametersPanel: React.FC<ParametersPanelProps> = ({
  value,
  onChange,
}) => {
  const [info, setInfo] = useState<OptimizerParameterInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    getOptimizerParameters()
      .then(setInfo)
      .catch((err) => setError(String(err?.message ?? err)));
  }, []);

  const groups = useMemo(() => {
    if (!info) return [];
    const byGroup = new Map<string, OptimizerParameterInfo[]>();
    for (const p of info) {
      if (!byGroup.has(p.group)) byGroup.set(p.group, []);
      byGroup.get(p.group)!.push(p);
    }
    return [...byGroup.entries()];
  }, [info]);

  const changedCount = Object.keys(value).length;

  if (error) {
    return <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>;
  }
  if (!info) {
    return <p className="text-[11px] text-slate-500">Loading parameters…</p>;
  }

  const set = (name: string, next: number | null) => {
    const copy = { ...value };
    if (next === null) delete copy[name];
    else copy[name] = next;
    onChange(copy);
  };

  return (
    <div className="text-[11px] text-slate-700 dark:text-slate-300">
      <div className="flex items-center justify-between mb-2">
        <span className="text-slate-500">
          {changedCount === 0
            ? 'All at model defaults'
            : `${changedCount} changed from default`}
        </span>
        {changedCount > 0 && (
          <button
            onClick={() => onChange({})}
            className="text-[10px] px-1.5 py-0.5 rounded border
                       border-slate-200 dark:border-slate-700
                       hover:bg-slate-50 dark:hover:bg-slate-700"
          >
            Reset all
          </button>
        )}
      </div>

      {groups.map(([group, items]) => (
        <div key={group} className="mb-3">
          <h4 className="text-[9px] font-bold uppercase tracking-[0.12em]
                         text-slate-400 dark:text-slate-500 mb-1">
            {group}
          </h4>

          <div className="space-y-1">
            {items.map((p) => {
              const current = value[p.name] ?? p.default;
              const isChanged = value[p.name] !== undefined;
              const isOpen = expanded === p.name;

              return (
                <div key={p.name}>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setExpanded(isOpen ? null : p.name)}
                      className="flex-1 text-left truncate hover:text-slate-900
                                 dark:hover:text-slate-100"
                      title="Show provenance"
                    >
                      {p.name.replace(/_/g, ' ').replace(/ sek per /g, ' ')}
                      {p.outdated && (
                        <span
                          className="ml-1 text-amber-600 dark:text-amber-400"
                          title="Flagged by the optimization team as out of date"
                        >
                          ●
                        </span>
                      )}
                    </button>

                    <input
                      type="number"
                      value={current}
                      min={p.minimum ?? undefined}
                      max={p.maximum ?? undefined}
                      step="any"
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === '') return set(p.name, null);
                        set(p.name, Number(raw));
                      }}
                      className={`w-20 px-1.5 py-0.5 rounded text-right tabular-nums
                                  border bg-white dark:bg-slate-800 outline-none
                                  focus:border-cyan-400 ${
                                    isChanged
                                      ? 'border-cyan-400 dark:border-cyan-500'
                                      : 'border-slate-200 dark:border-slate-700'
                                  }`}
                    />
                    <span className="w-16 text-[9px] text-slate-400 truncate">
                      {p.unit}
                    </span>
                    {isChanged && (
                      <button
                        onClick={() => set(p.name, null)}
                        className="text-slate-400 hover:text-slate-700
                                   dark:hover:text-slate-200 leading-none"
                        title={`Reset to ${p.default}`}
                      >
                        ×
                      </button>
                    )}
                  </div>

                  {isOpen && (
                    <p
                      className={`mt-1 mb-1.5 ml-1 pl-2 border-l-2 text-[10px] leading-snug ${
                        p.outdated
                          ? 'border-amber-400 text-amber-700 dark:text-amber-400'
                          : 'border-slate-200 dark:border-slate-700 text-slate-500'
                      }`}
                    >
                      {p.description}
                      <span className="block mt-0.5 text-slate-400">
                        default {p.default}
                        {p.minimum !== null && p.maximum !== null
                          ? ` · range ${p.minimum}–${p.maximum}`
                          : ''}
                      </span>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <p className="text-[10px] text-slate-400 leading-snug">
        <span className="text-amber-600 dark:text-amber-400">●</span> marks values
        the optimization team flagged as outdated. Click a name for its source.
      </p>
    </div>
  );
};

export default ParametersPanel;
