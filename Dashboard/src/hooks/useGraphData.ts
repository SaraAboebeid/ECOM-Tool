import { useEffect, useMemo } from 'react';
import { GraphData } from '../types';
import { calculateKPIs, createGraphStructureKey, createFiltersKey, KPIData } from '../utils/graphCalculations';

interface GraphFilters {
  nodeTypes: Set<string>;
  minFlow: number;
  owners: Set<string>;
  v2gFilter: 'all' | 'v2g-only' | 'no-v2g';
  capacityRange: { min: number; max: number };
}

interface UseGraphDataProps {
  data: GraphData;
  filters: GraphFilters;
  currentHour?: number;
  onKPICalculated?: (kpis: KPIData) => void;
}

/**
 * Custom hook for processing graph data and calculating KPIs
 * @param data Graph data
 * @param filters Graph filters
 * @param currentHour Current hour for flow filtering
 * @param onKPICalculated Callback for KPI calculations
 * @returns Processed data and stable keys
 */
export const useGraphData = ({ data, filters, currentHour = 0, onKPICalculated }: UseGraphDataProps) => {
  // Create stable keys for the graph structure to prevent unnecessary re-renders
  const graphStructureKey = useMemo(() => 
    createGraphStructureKey(data.nodes, data.links), 
    [data.nodes, data.links]
  );
  
  // Create stable keys for filters to prevent unnecessary re-renders
  const filtersKey = useMemo(() => 
    createFiltersKey(filters), 
    [filters]
  );
  
  // Calculate KPIs when data changes
  const kpis = useMemo(() => 
    calculateKPIs(data.nodes), 
    [data.nodes]
  );
  
  // Notify parent component of calculated KPIs
  useEffect(() => {
    if (kpis && onKPICalculated) {
      onKPICalculated(kpis);
    }
  }, [kpis, onKPICalculated]);

  // Create deep copies and apply filters within the hook
  const processedData = useMemo(() => {
    // Deep copy the nodes and links
    const nodesCopy = data.nodes.map(d => ({ ...d }));
    const linksCopy = data.links.map(d => ({ ...d }));
    
    // Filter nodes based on filters
    const filteredNodes = nodesCopy.filter(node => {
      // Filter by node type
      if (!filters.nodeTypes.has(node.type)) return false;
      
      // Filter by owner
      if (node.owner && filters.owners.size > 0 && !filters.owners.has(node.owner)) {
        return false;
      }
      
      // Filter by V2G capability (for charge points)
      if (node.type === 'charge_point' && filters.v2gFilter !== 'all') {
        if (filters.v2gFilter === 'v2g-only' && !node.is_v2g) return false;
        if (filters.v2gFilter === 'no-v2g' && node.is_v2g) return false;
      }
      
      // Filter by capacity range
      const nodeCapacity = node.capacity || node.installed_capacity || 0;
      if (nodeCapacity > 0 && (nodeCapacity < filters.capacityRange.min || nodeCapacity > filters.capacityRange.max)) {
        return false;
      }
      
      return true;
    });
    
    // Get filtered node IDs for link filtering
    const filteredNodeIds = new Set(filteredNodes.map(node => node.id));
    
    // Filter links based on filtered nodes and minFlow
    const filteredLinks = linksCopy.filter(link => {
      // Ensure both source and target nodes exist after filtering
      const sourceId = typeof link.source === 'object' && link.source !== null ? (link.source as any).id : link.source;
      const targetId = typeof link.target === 'object' && link.target !== null ? (link.target as any).id : link.target;
      const sourceExists = filteredNodeIds.has(sourceId);
      const targetExists = filteredNodeIds.has(targetId);
      
      // Check if flow exceeds minimum threshold at the current hour
      const flowValue = Array.isArray(link.flow) ? link.flow[currentHour] : link.flow;
      const flowExceedsMin = Math.abs(flowValue) >= filters.minFlow;
      
      return sourceExists && targetExists && flowExceedsMin;
    });
    
    return {
      nodes: filteredNodes,
      links: filteredLinks
    };
  }, [data, filters, currentHour]);

  return {
    processedData,
    kpis,
    graphStructureKey,
    filtersKey
  };
};

export default useGraphData;
