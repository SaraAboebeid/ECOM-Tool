/**
 * The community definition sent to the backend, and the client that sends it.
 *
 * These types mirror Dashboard/backend/app/schemas/community.py. The backend
 * validates with `extra="forbid"`, so an unknown field is a 422 rather than a
 * silently ignored one - keep the two in step.
 */
import { GraphData } from '../types';

export type Owner = 'Akademiska Hus' | 'Studentbostäder' | 'Chalmersfastigheter';

export const OWNERS: Owner[] = [
  'Akademiska Hus',
  'Studentbostäder',
  'Chalmersfastigheter',
];

export interface Coordinates {
  x: number;
  y: number;
  z?: number;
}

/** Exactly one of hourly / csv_path / annual_kwh. annual_kwh requires shape. */
export interface DemandSpec {
  hourly?: number[];
  csv_path?: string;
  annual_kwh?: number;
  shape?: number[];
}

export interface BuildingSpec {
  name: string;
  owner: Owner;
  building_type?: string;
  footprint_area: number;
  number_of_floors?: number;
  demand: DemandSpec;
  location?: Coordinates;
  pv_plants?: string[];
}

export interface PVModuleSpec {
  name?: string;
  rating?: number;
  size_x?: number;
  size_y?: number;
  /** SEK/kWp. Values below 100 are rejected - see PVModuleSpec in the backend. */
  cost_per_kwp?: number;
  embodied_co2_per_kwp?: number;
}

export interface PVPlantSpec {
  name: string;
  surface_area: number;
  percentage?: number;
  system_loss?: number;
  slope?: number;
  /** Degrees. 0 is due south. */
  azimuth?: number;
  lat?: number;
  lon?: number;
  module?: PVModuleSpec;
  location?: Coordinates;
}

export interface BatterySpec {
  name: string;
  capacity: number;
  cost_per_kwh?: number;
  embodied_co2_per_kwh?: number;
  efficiency?: number;
  lifespan?: number;
  degradation?: number;
  /** Fraction of capacity, not kWh. The backend converts. */
  initial_soc_fraction?: number;
  location?: Coordinates;
}

export interface ElectricVehicleSpec {
  name: string;
  capacity?: number;
  is_hybrid?: boolean;
  efficiency?: number;
  daily_distance?: number;
  max_charging_power?: number;
  v2g_enabled?: boolean;
  embodied_co2_per_kwh?: number;
  /** 24 or 8760 binary values. */
  availability?: number[];
}

export interface ChargePointSpec {
  name: string;
  capacity: number;
  charger_type?: string;
  is_v2g?: boolean;
  owner: Owner;
  /** Singular: the toolkit only computes demand for exactly one vehicle. */
  ev?: ElectricVehicleSpec | null;
  location?: Coordinates;
}

export interface PriceSpec {
  fixed?: number;
  hourly?: number[];
  nordpool_area?: string;
  nordpool_start?: string;
  nordpool_end?: string;
  fill?: 'repeat' | 'mean' | 'value';
  fill_value?: number;
}

export interface GridSpec {
  name?: string;
  buying_price?: PriceSpec;
  selling_price?: PriceSpec;
  carbon_intensity?: { fixed?: number; hourly?: number[] };
  analysis_start_hour?: number;
  analysis_end_hour?: number;
}

export interface AnalysisPeriodSpec {
  start_month?: number;
  start_day?: number;
  start_hour?: number;
  end_month?: number;
  end_day?: number;
  end_hour?: number;
}

export interface CommunityDefinition {
  name?: string;
  buildings: BuildingSpec[];
  pv_plants?: PVPlantSpec[];
  batteries?: BatterySpec[];
  charge_points?: ChargePointSpec[];
  /** Required. Without it the toolkit silently substitutes 1.5 SEK/kWh. */
  grid: GridSpec;
  analysis_period?: AnalysisPeriodSpec;
  dispatch_mode?: 'community' | 'market';
  internal_price_buying?: number;
  internal_price_selling?: number;
}

export interface DispatchResponse extends GraphData {
  meta: {
    community: string;
    period: string;
    hours: number;
    dispatch_mode: string;
  };
}

/** A daily demand curve, peaking mid-morning and again early evening. */
const DAILY_DEMAND_SHAPE = [
  0.45, 0.40, 0.38, 0.37, 0.40, 0.52, 0.70, 0.88,
  1.00, 0.98, 0.94, 0.92, 0.90, 0.91, 0.93, 0.95,
  1.00, 0.97, 0.88, 0.78, 0.68, 0.60, 0.53, 0.48,
];

/** Plugged in from 18:00 to 07:00. */
const OVERNIGHT = [
  1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1,
];

export const DEFAULT_COMMUNITY: CommunityDefinition = {
  name: 'Chalmers Campus',
  buildings: [
    {
      name: 'Fysik',
      owner: 'Akademiska Hus',
      building_type: 'College',
      footprint_area: 1500,
      number_of_floors: 4,
      location: { x: -120, y: 60 },
      demand: { annual_kwh: 900000, shape: DAILY_DEMAND_SHAPE },
      pv_plants: ['Fysik roof'],
    },
    {
      name: 'Kemi',
      owner: 'Chalmersfastigheter',
      building_type: 'College',
      footprint_area: 1100,
      number_of_floors: 3,
      location: { x: 130, y: -40 },
      demand: { annual_kwh: 620000, shape: DAILY_DEMAND_SHAPE },
      pv_plants: ['Kemi roof'],
    },
    {
      name: 'Studenthem',
      owner: 'Studentbostäder',
      building_type: 'MidriseApartment',
      footprint_area: 800,
      number_of_floors: 6,
      location: { x: 10, y: 170 },
      demand: { annual_kwh: 410000, shape: DAILY_DEMAND_SHAPE },
      pv_plants: [],
    },
  ],
  pv_plants: [
    { name: 'Fysik roof', surface_area: 1200, slope: 30, azimuth: 0 },
    { name: 'Kemi roof', surface_area: 900, slope: 25, azimuth: 0 },
  ],
  batteries: [
    { name: 'Campus BESS', capacity: 800, initial_soc_fraction: 0.5, location: { x: 0, y: 0 } },
  ],
  charge_points: [
    {
      name: 'Parkering A',
      capacity: 22,
      owner: 'Akademiska Hus',
      charger_type: 'AC Level 2',
      is_v2g: false,
      location: { x: -60, y: -150 },
      ev: {
        name: 'EV A',
        capacity: 60,
        max_charging_power: 11,
        daily_distance: 40,
        availability: OVERNIGHT,
      },
    },
  ],
  grid: {
    name: 'SE3',
    buying_price: { fixed: 1.35 },
    selling_price: { fixed: 0.55 },
    carbon_intensity: { fixed: 41 },
  },
  analysis_period: {
    start_month: 6,
    start_day: 1,
    start_hour: 0,
    end_month: 6,
    end_day: 2,
    end_hour: 23,
  },
  dispatch_mode: 'community',
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      // FastAPI returns {detail: string} for our 422s and an array for
      // pydantic's own field errors.
      if (typeof payload.detail === 'string') {
        detail = payload.detail;
      } else if (Array.isArray(payload.detail)) {
        detail = payload.detail
          .map((e: any) => `${(e.loc ?? []).slice(1).join('.')}: ${e.msg}`)
          .join('\n');
      }
    } catch {
      /* keep the status line */
    }
    throw new ApiError(detail, response.status);
  }

  return response.json();
}

export function dispatchCommunity(
  definition: CommunityDefinition,
  signal?: AbortSignal,
): Promise<DispatchResponse> {
  return post<DispatchResponse>('/api/dispatch', definition, signal);
}

export interface ScenarioSummary {
  name: string;
  title: string;
  buildings: number;
}

/**
 * Community definitions saved on the backend, e.g. the generated Chalmers
 * campus models. The built-in demo is prepended so it is always selectable.
 */
export async function listScenarios(): Promise<ScenarioSummary[]> {
  const response = await fetch('/api/scenarios');
  if (!response.ok) throw new ApiError('Could not list scenarios', response.status);
  const payload = await response.json();
  return payload.scenarios ?? [];
}

export async function loadScenario(name: string): Promise<CommunityDefinition> {
  const response = await fetch(`/api/scenarios/${encodeURIComponent(name)}`);
  if (!response.ok) {
    throw new ApiError(`Could not load scenario "${name}"`, response.status);
  }
  return response.json();
}

export const DEMO_SCENARIO: ScenarioSummary = {
  name: '__demo__',
  title: 'Demo community (3 buildings)',
  buildings: 3,
};
