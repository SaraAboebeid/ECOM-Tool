import { useState } from 'react';
import { CommunityDefinition, ScenarioSummary } from '../api/community';

interface CommunityControlsProps {
  definition: CommunityDefinition;
  onChange: (next: CommunityDefinition) => void;
  isComputing: boolean;
  error: string | null;
  meta?: { period: string; hours: number } | null;
  scenarios: ScenarioSummary[];
  activeScenario: string;
  onScenarioChange: (name: string) => void;
}

/** Deep clone so edits never mutate the definition React is holding. */
const clone = (d: CommunityDefinition): CommunityDefinition =>
  JSON.parse(JSON.stringify(d));

const Slider = ({
  label, value, min, max, step, unit, onChange, hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
  hint?: string;
}) => (
  <label className="block mb-3">
    <div className="flex justify-between items-baseline text-xs mb-1">
      <span className="text-gray-700 dark:text-gray-300">{label}</span>
      <span className="font-mono text-gray-900 dark:text-gray-100">
        {value.toLocaleString()} {unit}
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-blue-500"
    />
    {hint && <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">{hint}</p>}
  </label>
);

export const CommunityControls = ({
  definition, onChange, isComputing, error, meta,
  scenarios, activeScenario, onScenarioChange,
}: CommunityControlsProps) => {

  const battery = definition.batteries?.[0];
  const chargePoint = definition.charge_points?.[0];
  const totalPvArea = (definition.pv_plants ?? [])
    .reduce((sum, p) => sum + p.surface_area, 0);

  const update = (mutate: (draft: CommunityDefinition) => void) => {
    const next = clone(definition);
    mutate(next);
    onChange(next);
  };

  /** Scale every roof proportionally, so one slider drives total PV. */
  const setTotalPvArea = (target: number) => {
    update((d) => {
      const plants = d.pv_plants ?? [];
      const current = plants.reduce((sum, p) => sum + p.surface_area, 0);
      if (current <= 0 || plants.length === 0) return;
      const factor = target / current;
      plants.forEach((p) => {
        p.surface_area = Math.max(1, Math.round(p.surface_area * factor));
      });
    });
  };

  const setPeriodDays = (days: number) => {
    update((d) => {
      // June 1 plus however many days, staying inside the month.
      d.analysis_period = {
        start_month: 6, start_day: 1, start_hour: 0,
        end_month: 6, end_day: days, end_hour: 23,
      };
    });
  };

  const periodDays = definition.analysis_period?.end_day ?? 2;

  // Positioning, the title and the collapse control now belong to the console
  // rail, so this renders content only. It used to pin itself to `top-4 left-4`
  // with z-40, which put it directly on top of the filter panel.
  return (
    <div className="text-gray-900 dark:text-gray-100">
      {error && (
        <div className="mb-3 p-2 rounded bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 text-[11px] whitespace-pre-wrap">
          {error}
        </div>
      )}

      <label className="block mb-3">
        <span className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Community
        </span>
        <select
          value={activeScenario}
          onChange={(e) => onScenarioChange(e.target.value)}
          className="mt-1 w-full text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1"
        >
          {scenarios.map((s) => (
            <option key={s.name} value={s.name}>
              {s.title} — {s.buildings} building{s.buildings === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </label>

      <div className="mb-3 text-[10px] text-gray-500 dark:text-gray-400 leading-relaxed">
        {meta && <div>{meta.period}</div>}
        <div>
          {definition.buildings.length} buildings ·{' '}
          {(definition.pv_plants ?? []).length} PV ·{' '}
          {(definition.batteries ?? []).length} battery ·{' '}
          {(definition.charge_points ?? []).length} charger
        </div>
        {totalPvArea > 0 && <div>{Math.round(totalPvArea).toLocaleString()} m² of PV surface</div>}
      </div>

      <section className="mb-4">
        <h3 className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
          Storage
        </h3>
        {battery ? (
          <>
            <Slider
              label="Battery capacity"
              value={battery.capacity}
              min={0}
              max={5000}
              step={50}
              unit="kWh"
              onChange={(v) =>
                update((d) => {
                  // The backend requires capacity > 0.
                  d.batteries![0].capacity = Math.max(1, v);
                })
              }
            />
            <Slider
              label="Starting charge"
              value={Math.round((battery.initial_soc_fraction ?? 0.5) * 100)}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(v) =>
                update((d) => {
                  d.batteries![0].initial_soc_fraction = v / 100;
                })
              }
              hint="Fraction of capacity, so it holds as you resize."
            />
          </>
        ) : (
          <p className="text-xs text-gray-500">No battery in this community.</p>
        )}
      </section>

      <section className="mb-4">
        <h3 className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
          Solar
        </h3>
        <Slider
          label="Total roof area"
          value={totalPvArea}
          min={0}
          max={20000}
          step={100}
          unit="m²"
          onChange={setTotalPvArea}
          hint="Scales every roof proportionally."
        />
        <Slider
          label="Panel coverage"
          value={definition.pv_plants?.[0]?.percentage ?? 70}
          min={10}
          max={100}
          step={5}
          unit="%"
          onChange={(v) =>
            update((d) => d.pv_plants?.forEach((p) => (p.percentage = v)))
          }
        />
        <Slider
          label="Tilt"
          value={definition.pv_plants?.[0]?.slope ?? 30}
          min={0}
          max={60}
          step={5}
          unit="°"
          onChange={(v) => update((d) => d.pv_plants?.forEach((p) => (p.slope = v)))}
          hint="Each distinct tilt costs one PVGIS lookup, then it is cached."
        />
      </section>

      <section className="mb-4">
        <h3 className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
          Grid
        </h3>
        <Slider
          label="Import price"
          value={definition.grid.buying_price?.fixed ?? 1.35}
          min={0}
          max={5}
          step={0.05}
          unit="SEK/kWh"
          onChange={(v) =>
            update((d) => {
              d.grid.buying_price = { fixed: v };
            })
          }
        />
        <Slider
          label="Export price"
          value={definition.grid.selling_price?.fixed ?? 0.55}
          min={0}
          max={5}
          step={0.05}
          unit="SEK/kWh"
          onChange={(v) =>
            update((d) => {
              d.grid.selling_price = { fixed: v };
            })
          }
        />
        <Slider
          label="Carbon intensity"
          value={definition.grid.carbon_intensity?.fixed ?? 41}
          min={0}
          max={400}
          step={1}
          unit="kgCO₂e/kWh"
          onChange={(v) =>
            update((d) => {
              d.grid.carbon_intensity = { fixed: v };
            })
          }
        />
      </section>

      <section className="mb-4">
        <h3 className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
          Mobility
        </h3>
        {chargePoint?.ev ? (
          <>
            <Slider
              label="Charger power"
              value={chargePoint.capacity}
              min={3.7}
              max={150}
              step={1}
              unit="kW"
              onChange={(v) =>
                update((d) => {
                  d.charge_points![0].capacity = v;
                })
              }
            />
            <Slider
              label="Daily driving"
              value={chargePoint.ev.daily_distance ?? 35}
              min={0}
              max={200}
              step={5}
              unit="km"
              onChange={(v) =>
                update((d) => {
                  d.charge_points![0].ev!.daily_distance = Math.max(1, v);
                })
              }
            />
            <label className="flex items-center gap-2 text-xs mt-2">
              <input
                type="checkbox"
                checked={chargePoint.is_v2g ?? false}
                onChange={(e) =>
                  update((d) => {
                    // The backend rejects a vehicle with V2G on when the
                    // charger has it off, so both move together.
                    d.charge_points![0].is_v2g = e.target.checked;
                    d.charge_points![0].ev!.v2g_enabled = e.target.checked;
                  })
                }
                className="accent-blue-500"
              />
              <span className="text-gray-700 dark:text-gray-300">
                Vehicle-to-grid
              </span>
            </label>
          </>
        ) : (
          <p className="text-xs text-gray-500">No charge point in this community.</p>
        )}
      </section>

      <section>
        <h3 className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
          Period
        </h3>
        <Slider
          label="Days from 1 June"
          value={periodDays}
          min={1}
          max={14}
          step={1}
          unit={periodDays === 1 ? 'day' : 'days'}
          onChange={setPeriodDays}
          hint="Longer periods take proportionally longer to dispatch."
        />
      </section>
    </div>
  );
};
