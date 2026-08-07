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
export const NODE_COLORS = {
  building: '#ff00a6ff',    // pink-500
  pv: '#eaff00ff',          // amber-500
  grid: '#00ffe5ff',        // green-500
  battery: '#fa3600ff',     // blue-500
  charge_point: '#00ff5eff' // purple-500
};

// Alternate neon color scheme
// export const NODE_COLORS = {
//   building: '#EC4899',    // pink-500
//   pv: '#F59E0B',          // amber-500
//   grid: '#10B981',       // green-500
//   battery: '#3B82F6',    // blue-500
//   charge_point: '#8B5CF6' // purple-500
// };

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