import { Node } from '../types';

export interface KPIData {
  totalPVCapacity: number;
  totalEnergyDemand: number;
  totalBatteryCapacity: number;
  totalPVProduction: number;
  totalEmbodiedCO2: number;
}

/**
 * Calculate KPIs (Key Performance Indicators) from graph nodes
 * @param nodes Array of graph nodes
 * @returns KPI data object or null if no nodes
 */
export const calculateKPIs = (nodes: Node[]): KPIData | null => {
  if (!nodes.length) return null;
  
  const kpis: KPIData = {
    totalPVCapacity: 0,
    totalEnergyDemand: 0,
    totalBatteryCapacity: 0,
    totalPVProduction: 0,
    totalEmbodiedCO2: 0
  };
  
  nodes.forEach(node => {
    if (node.type === 'pv') {
      kpis.totalPVCapacity += node.installed_capacity || 0;
      kpis.totalPVProduction += node.annual_production || 0;
      kpis.totalEmbodiedCO2 += node.total_embodied_co2 || 0;
    }
    else if (node.type === 'building') {
      kpis.totalEnergyDemand += node.total_energy_demand || 0;
    }
    else if (node.type === 'battery') {
      kpis.totalBatteryCapacity += node.capacity || 0;
      kpis.totalEmbodiedCO2 += node.total_embodied_co2 || 0;
    }
  });
  
  return kpis;
};

/**
 * Create stable keys for graph structure to prevent unnecessary re-renders
 * @param nodes Array of graph nodes
 * @param links Array of graph links
 * @returns Stable string key for the graph structure
 */
export const createGraphStructureKey = (nodes: Node[], links: any[]): string => {
  return `${nodes.map(n => n.id).sort().join(',')}-${links.map(l => `${l.source}-${l.target}`).sort().join(',')}`;
};

/**
 * Create stable filter keys to prevent unnecessary re-renders
 * @param filters Graph filters object
 * @returns Stable string key for the filters
 */
export const createFiltersKey = (filters: {
  nodeTypes: Set<string>;
  minFlow: number;
  owners: Set<string>;
  v2gFilter: 'all' | 'v2g-only' | 'no-v2g';
  capacityRange: { min: number; max: number };
}): string => {
  const nodeTypesKey = Array.from(filters.nodeTypes).sort().join(',');
  const ownersKey = Array.from(filters.owners).sort().join(',');
  return `${nodeTypesKey}-${filters.minFlow}-${ownersKey}-${filters.v2gFilter}-${filters.capacityRange.min}-${filters.capacityRange.max}`;
};

/**
 * Calculate total energy flow for a specific node at a given hour
 * @param nodeId ID of the node
 * @param links Array of graph links
 * @param currentHour Current hour index
 * @returns Total energy flow for the node
 */
export const calculateNodeEnergyFlow = (nodeId: string, links: any[], currentHour: number): number => {
  return links.reduce((sum: number, link: any) => {
    if (link.source === nodeId || link.target === nodeId) {
      return sum + Math.abs(link.flow[currentHour]);
    }
    return sum;
  }, 0);
};

/**
 * Check if a node has active energy flows at the current hour
 * @param nodeId ID of the node
 * @param links Array of graph links
 * @param currentHour Current hour index
 * @param threshold Minimum flow threshold to consider active
 * @returns True if node has active flows
 */
export const hasActiveEnergyFlow = (nodeId: string, links: any[], currentHour: number, threshold: number = 0.1): boolean => {
  return links.some((link: any) => 
    (link.source === nodeId || link.target === nodeId) && 
    Math.abs(link.flow[currentHour]) >= threshold
  );
};
