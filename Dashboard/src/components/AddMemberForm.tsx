import { useState } from 'react';
import {
  BatterySpec,
  ChargePointSpec,
  CommunityDefinition,
  Owner,
  OWNERS,
} from '../api/community';

/**
 * Add an asset to the community.
 *
 * Five kinds, because they sit in different places in the spec: a building is a
 * member, a roof array belongs to one, and a community plant, battery or
 * charger belong to the community as a whole. A PV plant counts as "community"
 * purely by not being claimed in any building's pv_plants list - that absence
 * is what the backend's community_pv_plants property derives from.
 */
type MemberKind = 'building' | 'roof_pv' | 'community_pv' | 'battery' | 'charge_point';

const KINDS: { key: MemberKind; label: string }[] = [
  { key: 'building', label: 'Building' },
  { key: 'roof_pv', label: 'Roof PV' },
  { key: 'community_pv', label: 'Community PV' },
  { key: 'battery', label: 'Battery' },
  { key: 'charge_point', label: 'Charger' },
];

/**
 * A generic weekday office profile, used only when a new building is given an
 * annual total rather than measured data. DemandSpec requires a shape alongside
 * annual_kwh precisely so this assumption has to be stated: spreading a yearly
 * figure flat would erase the peaks that drive battery sizing and demand
 * charges.
 */
const OFFICE_DAY_SHAPE = [
  0.4, 0.35, 0.35, 0.35, 0.4, 0.5, 0.7, 0.9,
  1.1, 1.25, 1.3, 1.3, 1.25, 1.3, 1.3, 1.25,
  1.1, 0.95, 0.8, 0.7, 0.6, 0.55, 0.5, 0.45,
];

const SIZE_FIELD: Record<MemberKind, { label: string; unit: string; max: number }> = {
  building: { label: 'Footprint', unit: 'm2', max: 20000 },
  roof_pv: { label: 'Roof coverage', unit: '%', max: 80 },
  community_pv: { label: 'Panel area', unit: 'm2', max: 20000 },
  battery: { label: 'Capacity', unit: 'kWh', max: 5000 },
  charge_point: { label: 'Max power', unit: 'kW', max: 350 },
};

interface AddMemberFormProps {
  definition: CommunityDefinition;
  onChange: (next: CommunityDefinition) => void;
  /** Buildings a new roof array can be mounted on. */
  roofCandidates: { name: string; roofM2: number }[];
  onClose: () => void;
}

export const AddMemberForm: React.FC<AddMemberFormProps> = ({
  definition,
  onChange,
  roofCandidates,
  onClose,
}) => {
  const [kind, setKind] = useState<MemberKind>('building');
  const [name, setName] = useState('');
  const [owner, setOwner] = useState<Owner>(OWNERS[0]);
  const [size, setSize] = useState(100);
  const [annualKwh, setAnnualKwh] = useState(250000);
  const [floors, setFloors] = useState(3);
  const [host, setHost] = useState(roofCandidates[0]?.name ?? '');
  const [error, setError] = useState<string | null>(null);

  const existingNames = new Set([
    ...definition.buildings.map((b) => b.name),
    ...(definition.pv_plants ?? []).map((p) => p.name),
    ...(definition.batteries ?? []).map((b) => b.name),
    ...(definition.charge_points ?? []).map((c) => c.name),
  ]);

  const field = SIZE_FIELD[kind];

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give it a name.');
      return;
    }
    // The backend requires names unique across the whole community, not just
    // within a kind, so check the same way rather than waiting for a 422.
    if (existingNames.has(trimmed)) {
      setError(`"${trimmed}" already exists.`);
      return;
    }

    const next = structuredClone(definition) as CommunityDefinition;
    next.pv_plants = next.pv_plants ?? [];
    next.batteries = next.batteries ?? [];
    next.charge_points = next.charge_points ?? [];

    if (kind === 'building') {
      next.buildings.push({
        name: trimmed,
        owner,
        building_type: 'College',
        footprint_area: size,
        number_of_floors: floors,
        demand: { annual_kwh: annualKwh, shape: OFFICE_DAY_SHAPE },
        pv_plants: [],
      });
    } else if (kind === 'roof_pv') {
      const roof = roofCandidates.find((r) => r.name === host);
      const building = next.buildings.find((b) => b.name === host);
      if (!roof || !building) {
        setError('Pick a building to mount it on.');
        return;
      }
      next.pv_plants.push({ name: trimmed, surface_area: roof.roofM2, percentage: size });
      building.pv_plants = [...(building.pv_plants ?? []), trimmed];
    } else if (kind === 'community_pv') {
      // Deliberately not listed in any building's pv_plants - that absence is
      // what makes it a community plant rather than a roof array.
      next.pv_plants.push({ name: trimmed, surface_area: size, percentage: 80 });
    } else if (kind === 'battery') {
      next.batteries.push({ name: trimmed, capacity: size } as BatterySpec);
    } else {
      next.charge_points.push({ name: trimmed, capacity: size, owner } as ChargePointSpec);
    }

    onChange(next);
    onClose();
  };

  return (
    <div className="rounded-lg border border-cyan-300 dark:border-cyan-700 p-2 mb-2
                    bg-cyan-50/60 dark:bg-cyan-500/5">
      <div className="grid grid-cols-3 gap-1 mb-2">
        {KINDS.map((k) => (
          <button
            key={k.key}
            onClick={() => { setKind(k.key); setError(null); }}
            className={`px-1 py-1 rounded text-[10px] font-semibold transition-colors ${
              kind === k.key
                ? 'bg-cyan-600 text-white'
                : 'border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      <input
        value={name}
        onChange={(e) => { setName(e.target.value); setError(null); }}
        placeholder="Name"
        className="w-full mb-1.5 px-2 py-1 rounded text-[11px] border
                   border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
      />

      {kind === 'roof_pv' && (
        <select
          value={host}
          onChange={(e) => setHost(e.target.value)}
          className="w-full mb-1.5 px-2 py-1 rounded text-[11px] border
                     border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
        >
          {roofCandidates.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name} - {Math.round(r.roofM2).toLocaleString()} m2 roof
            </option>
          ))}
        </select>
      )}

      {(kind === 'building' || kind === 'charge_point') && (
        <select
          value={owner}
          onChange={(e) => setOwner(e.target.value as Owner)}
          className="w-full mb-1.5 px-2 py-1 rounded text-[11px] border
                     border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
        >
          {OWNERS.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}

      <label className="block mb-1.5">
        <div className="flex justify-between text-[10px] mb-0.5">
          <span className="text-slate-500">{field.label}</span>
          <span className="tabular-nums">{Math.min(size, field.max)} {field.unit}</span>
        </div>
        <input
          type="range"
          min={1}
          max={field.max}
          step={1}
          value={Math.min(size, field.max)}
          onChange={(e) => setSize(Number(e.target.value))}
          className="w-full accent-cyan-500"
        />
      </label>

      {kind === 'building' && (
        <>
          <label className="block mb-1.5">
            <div className="flex justify-between text-[10px] mb-0.5">
              <span className="text-slate-500">Floors</span>
              <span className="tabular-nums">{floors}</span>
            </div>
            <input type="range" min={1} max={20} step={1} value={floors}
                   onChange={(e) => setFloors(Number(e.target.value))}
                   className="w-full accent-cyan-500" />
          </label>

          <label className="block mb-1.5">
            <div className="flex justify-between text-[10px] mb-0.5">
              <span className="text-slate-500">Annual demand</span>
              <span className="tabular-nums">{(annualKwh / 1000).toFixed(0)} MWh</span>
            </div>
            <input type="range" min={10000} max={5000000} step={10000} value={annualKwh}
                   onChange={(e) => setAnnualKwh(Number(e.target.value))}
                   className="w-full accent-cyan-500" />
          </label>

          <p className="text-[9px] text-amber-700 dark:text-amber-400 mb-1.5 leading-snug">
            Shaped from a generic weekday office profile, not measured data. The
            peaks are assumed, so treat results for this building as indicative.
          </p>
        </>
      )}

      {error && <p className="text-[10px] text-red-600 dark:text-red-400 mb-1.5">{error}</p>}

      <div className="flex gap-1">
        <button
          onClick={submit}
          className="flex-1 px-2 py-1 rounded bg-cyan-600 text-white text-[10px]
                     font-semibold hover:bg-cyan-700"
        >
          Add
        </button>
        <button
          onClick={onClose}
          className="px-3 py-1 rounded border border-slate-200 dark:border-slate-700 text-[10px]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export default AddMemberForm;
