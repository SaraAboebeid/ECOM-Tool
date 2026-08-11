import { useMemo, useState } from 'react';
import { CommunityDefinition, PVPlantSpec } from '../api/community';
import {
  MAX_ROOF_COVERAGE_PERCENT,
  capacityForCoverage,
  coverageForCapacity,
  roofAreaOf,
} from '../utils/roofArea';

/**
 * Who is in the community, and how much PV each member carries.
 *
 * Membership and roof coverage are edited together because they are the same
 * decision: adding a building only matters if you can then say what it
 * contributes. Coverage is expressed as a share of the building's measured
 * footprint and capped at MAX_ROOF_COVERAGE_PERCENT, so the control cannot
 * describe a roof that does not exist.
 */
interface MembersPanelProps {
  definition: CommunityDefinition;
  onChange: (next: CommunityDefinition) => void;
  /** Buildings removed from the community, kept so they can be restored. */
  excluded: Record<string, unknown>;
  onExcludedChange: (next: Record<string, unknown>) => void;
  /** Latest dispatched self-sufficiency, so the effect of a change is visible here. */
  selfSufficiency?: number | null;
}

/** The plant a building owns, if any. Buildings name their plants. */
const plantFor = (
  definition: CommunityDefinition,
  buildingName: string
): PVPlantSpec | undefined => {
  const building = definition.buildings.find((b) => b.name === buildingName);
  const owned = building?.pv_plants ?? [];
  if (!owned.length) return undefined;
  return definition.pv_plants?.find((p) => owned.includes(p.name));
};

export const MembersPanel: React.FC<MembersPanelProps> = ({
  definition,
  onChange,
  excluded,
  onExcludedChange,
  selfSufficiency,
}) => {
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const inCommunity = definition.buildings.map((b) => ({
      name: b.name,
      included: true,
    }));
    const out = Object.keys(excluded).map((name) => ({ name, included: false }));
    return [...inCommunity, ...out]
      .sort((a, b) => a.name.localeCompare(b.name, 'sv'))
      .filter((r) => r.name.toLowerCase().includes(query.toLowerCase()));
  }, [definition.buildings, excluded, query]);

  const setMembership = (name: string, include: boolean) => {
    if (include) {
      const restored = excluded[name] as any;
      if (!restored) return;
      const { [name]: _drop, ...rest } = excluded;
      onExcludedChange(rest);
      onChange({ ...definition, buildings: [...definition.buildings, restored] });
      return;
    }
    const building = definition.buildings.find((b) => b.name === name);
    if (!building) return;
    onExcludedChange({ ...excluded, [name]: building });
    onChange({
      ...definition,
      buildings: definition.buildings.filter((b) => b.name !== name),
    });
  };

  /** Set coverage, creating or removing the plant as needed. */
  const setCoverage = (buildingName: string, percent: number) => {
    const roof = roofAreaOf(buildingName);
    if (roof == null) return;

    const next = structuredClone(definition) as CommunityDefinition;
    const building = next.buildings.find((b) => b.name === buildingName);
    if (!building) return;

    const plantName = `${buildingName}-PV`;
    next.pv_plants = next.pv_plants ?? [];
    const existingIndex = next.pv_plants.findIndex(
      (p) => (building.pv_plants ?? []).includes(p.name) || p.name === plantName
    );

    if (percent <= 0) {
      // Drop the plant rather than keep a zero-capacity one: the backend
      // rejects percentage <= 0, so a 0% plant is not a valid spec.
      if (existingIndex >= 0) next.pv_plants.splice(existingIndex, 1);
      building.pv_plants = [];
    } else if (existingIndex >= 0) {
      next.pv_plants[existingIndex] = {
        ...next.pv_plants[existingIndex],
        surface_area: roof,
        percentage: percent,
      };
      building.pv_plants = [next.pv_plants[existingIndex].name];
    } else {
      next.pv_plants.push({
        name: plantName,
        surface_area: roof,
        percentage: percent,
      });
      building.pv_plants = [plantName];
    }

    onChange(next);
  };

  const totals = useMemo(() => {
    let kwp = 0;
    let roof = 0;
    for (const b of definition.buildings) {
      const area = roofAreaOf(b.name);
      if (area != null) roof += area;
      const plant = plantFor(definition, b.name);
      if (plant && area != null) {
        kwp += capacityForCoverage(plant.surface_area ?? area, plant.percentage ?? 0);
      }
    }
    return { kwp, roof };
  }, [definition]);

  /** Put every building back in, or take every one out. */
  const setAll = (include: boolean) => {
    if (include) {
      const restored = Object.values(excluded) as any[];
      if (!restored.length) return;
      onExcludedChange({});
      onChange({ ...definition, buildings: [...definition.buildings, ...restored] });
      return;
    }
    // Keep at least one member: an empty community has nothing to dispatch and
    // the backend rejects it.
    const [keep, ...rest] = definition.buildings;
    if (!keep) return;
    const nextExcluded = { ...excluded };
    for (const b of rest) nextExcluded[b.name] = b;
    onExcludedChange(nextExcluded);
    onChange({ ...definition, buildings: [keep] });
  };

  const total = definition.buildings.length + Object.keys(excluded).length;

  return (
    <div className="text-[11px] text-slate-700 dark:text-slate-300">
      <div className="flex items-center justify-between mb-1.5 tabular-nums">
        <span>
          <strong>{definition.buildings.length}</strong> of {total} in community
        </span>
        <span className="text-slate-500">
          {totals.kwp.toFixed(0)} kWp · {Math.round(totals.roof).toLocaleString()} m² roof
        </span>
      </div>

      {/* Self-sufficiency is the point of adding or removing a member, so it
          sits with the controls rather than only in the header. */}
      {selfSufficiency != null && (
        <div className="flex items-center justify-between mb-2 px-2 py-1.5 rounded-lg
                        bg-emerald-50 dark:bg-emerald-500/10">
          <span className="text-emerald-800 dark:text-emerald-300">Self-sufficiency</span>
          <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
            {selfSufficiency.toFixed(2)}%
          </span>
        </div>
      )}

      <div className="flex gap-1 mb-2">
        <button
          onClick={() => setAll(true)}
          disabled={!Object.keys(excluded).length}
          className="flex-1 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700
                     text-[10px] font-semibold hover:bg-slate-50 dark:hover:bg-slate-800
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Include all
        </button>
        <button
          onClick={() => setAll(false)}
          disabled={definition.buildings.length <= 1}
          className="flex-1 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700
                     text-[10px] font-semibold hover:bg-slate-50 dark:hover:bg-slate-800
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Exclude all
        </button>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a building…"
        className="w-full mb-2 px-2 py-1.5 rounded-lg text-[11px]
                   border border-slate-200 dark:border-slate-700
                   bg-white dark:bg-slate-800 outline-none
                   focus:border-cyan-400 dark:focus:border-cyan-500"
      />

      <ul className="space-y-1.5">
        {rows.map(({ name, included }) => {
          const roof = roofAreaOf(name);
          const plant = included ? plantFor(definition, name) : undefined;
          const coverage = plant
            ? Math.min(plant.percentage ?? 0, MAX_ROOF_COVERAGE_PERCENT)
            : 0;
          const kwp = roof != null ? capacityForCoverage(roof, coverage) : 0;

          return (
            <li
              key={name}
              className={`rounded-lg border px-2 py-1.5 transition-colors ${
                included
                  ? 'border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-800/60'
                  : 'border-dashed border-slate-200 dark:border-slate-700 opacity-55'
              }`}
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={included}
                  onChange={(e) => setMembership(name, e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-cyan-500"
                />
                <span className="font-medium truncate flex-1">{name}</span>
                <span className="text-slate-500 tabular-nums text-[10px]">
                  {roof != null ? `${Math.round(roof).toLocaleString()} m²` : 'no roof data'}
                </span>
              </label>

              {included && roof != null && (
                <div className="mt-1.5 pl-5">
                  <div className="flex items-center justify-between text-[10px] mb-0.5">
                    <span className="text-slate-500">
                      PV coverage
                      {plant && coverage > 0 && (
                        <span className="ml-1 text-cyan-600 dark:text-cyan-400">
                          existing
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums">
                      {coverage.toFixed(0)}% · {kwp.toFixed(0)} kWp
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={MAX_ROOF_COVERAGE_PERCENT}
                    step={1}
                    value={coverage}
                    onChange={(e) => setCoverage(name, Number(e.target.value))}
                    className="w-full accent-cyan-500"
                  />
                </div>
              )}

              {included && roof == null && (
                <p className="mt-1 pl-5 text-[10px] text-amber-600 dark:text-amber-400">
                  No footprint in the Rhino model, so roof area is unknown and PV
                  cannot be sized here.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default MembersPanel;
