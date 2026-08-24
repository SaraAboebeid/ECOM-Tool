export interface Node {
  id: string;
  type: 'building' | 'pv' | 'grid' | 'battery' | 'charge_point';
  name?: string;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  // Additional properties
  total_energy_demand?: number;
  total_installed_capacity?: number;
  total_pv_capacity?: number;
  annual_production?: number;
  installed_capacity?: number;
  capacity?: number;
  total_cost?: number;
  total_embodied_co2?: number;
  owner?: string;
  VALID_OWNERS?: string[];
  // For charge points
  is_v2g?: boolean;
  total_connected_evs?: number;
  charger_type?: string;
  // For buildings
  building_type?: string;
  area?: number;
}

export interface Link {
  source: string;
  target: string;
  type?: string;
  flow: number[];  // Array of 48 hourly values
}

export interface GraphKPIs {
  total_demand: number;
  total_grid_import: number;
  total_grid_export: number;
  total_pv_used: number;
  total_pv_gen: number;
  self_sufficiency: number;
  self_consumption: number;
  avg_grid_carbon_intensity: number;
  total_grid_carbon_import: number;
  avg_grid_price_import: number;
  avg_building_self_consumption: number;
  building_self_consumption: Record<string, number>;
}

export interface GraphData {
  nodes: Node[];
  links: Link[];
  kpis?: GraphKPIs;
}

export interface GraphState {
  currentHour: number;
  isPlaying: boolean;
  filters: {
    nodeTypes: Set<string>;
    minFlow: number;
    owners: Set<string>;
    buildingTypes: Set<string>;
    capacityRange: { min: number; max: number };
  };
}

// Color scheme for different node types - Tailwind colors
/**
 * Node colours, by palette.
 *
 * Switch by changing ACTIVE_PALETTE - one line, and everything that reads
 * NODE_COLORS follows: node fills, link colours, the legend swatches.
 *
 * 'spring' was checked for separation in OKLab rather than by eye. Every pair
 * clears the normal-vision floor of dE 15 (tightest is pv/battery at 16.5), and
 * under protanopia and deuteranopia the tightest pair holds at 13.1, well above
 * the dE 8 target. Node shape and icon carry the type as well, so colour is
 * never the only channel.
 *
 * Two fills are deliberately low-contrast against a near-white ground - pv at
 * 1.26:1 and battery at 2.00:1 - which is why NODE_STROKE is dark for this
 * palette instead of the near-white it used to be. Without that ring the solar
 * node all but vanishes on the map.
 */
const PALETTES = {
  // The original saturated set.
  neon: {
    building: '#ff00a6ff',
    pv: '#eaff00ff',
    grid: '#00ffe5ff',
    battery: '#fa3600ff',
    charge_point: '#00ff5eff',
  },
  // Praxeti: Midnight Mirage, First Colors of Spring, Mantis, Picture Book
  // Green, Nuit Blanche.
  spring: {
    building: '#001F3F',      // Midnight Mirage - the mass of the campus
    pv: '#DBE64C',            // First Colors of Spring - solar keeps yellow
    grid: '#1E488F',          // Nuit Blanche - the one link to the outside
    battery: '#74C365',       // Mantis
    charge_point: '#00804C',  // Picture Book Green
  },
} as const;

/** Change this to 'neon' to put the previous scheme back. */
export const ACTIVE_PALETTE: keyof typeof PALETTES = 'neon';

export const NODE_COLORS: Record<string, string> = PALETTES[ACTIVE_PALETTE];

/**
 * Ring drawn around every node. Dark under 'spring' because two of its fills
 * are too light to hold an edge against the map; near-white under 'neon',
 * whose fills are all saturated.
 */
export const NODE_STROKE = ACTIVE_PALETTE === 'spring' ? '#001F3F' : '#eef6ff';

/** Page and map ground for the active palette. */
export const SURFACE_COLOR = ACTIVE_PALETTE === 'spring' ? '#F6F7ED' : '#f5f7fa';

// Alternate pastel color scheme
// export const NODE_COLORS = {
//   building: '#FFB6C1',    // Light Pink
//   pv: '#FFFACD',          // Light Yellow
//   grid: '#B0E0E6',       // Light Blue
//   battery: '#DDA0DD',    // Plum
//   charge_point: '#E6E6FA' // Lavender
// };

// Alternate cyberpunk color scheme
// export const NODE_COLORS = {
//   building: '#FF00FF',    // Magenta
//   pv: '#00FFFF',          // Cyan
//   grid: '#00FF00',       // Green
//   battery: '#0000FF',    // Blue
//   charge_point: '#FF00FF' // Purple
// };