import { useRef, useState, useEffect, useCallback } from 'react';
import { GraphData, Node } from '../../types';
import { useGraphData } from '../../hooks/useGraphData';
import { useGraphDimensions } from '../../hooks/useGraphDimensions';
import { useGraphTooltip } from '../../hooks/useGraphTooltip';
import { GraphCanvas } from './GraphCanvas';
import { NodeDetailsPanel } from './NodeDetailsPanel';
import { getFitToBackgroundTransform } from '../../utils/backgroundConfig';
import '../../simple-animations.css';
import * as d3 from 'd3';

interface GraphProps {
  data: GraphData;
  currentHour: number;
  filters: {
    nodeTypes: Set<string>;
    minFlow: number;
    owners: Set<string>;
    v2gFilter: 'all' | 'v2g-only' | 'no-v2g';
    capacityRange: { min: number; max: number };
  };
  isTimelinePlaying?: boolean;
  performanceMode?: 'auto' | 'high_performance' | 'balanced' | 'high_quality';
  onKPICalculated?: (kpis: {
    totalPVCapacity: number;
    totalEnergyDemand: number;
    totalBatteryCapacity: number;
    totalPVProduction: number;
    totalEmbodiedCO2: number;
  }) => void;
  onFitToView?: (fitFn: () => void) => void;
}

/**
 * Main Graph component that orchestrates all graph functionality
 * This is the new modular version that replaces the monolithic Graph.tsx
 */
export const Graph: React.FC<GraphProps> = ({ 
  data, 
  currentHour, 
  filters, 
  isTimelinePlaying, 
  performanceMode = 'auto',
  onKPICalculated,
  onFitToView
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  // Use custom hooks for modular functionality
  const { processedData, kpis, graphStructureKey, filtersKey } = useGraphData({
    data,
    filters,
    currentHour,
    onKPICalculated
  });

  const dimensions = useGraphDimensions(svgRef);
  const tooltip = useGraphTooltip();

  // The zoom behaviour is created once by useGraphSimulation and shared here so
  // every fit reuses the same transform state.
  const getSharedZoom = () =>
    ((window as any).graphZoom as d3.ZoomBehavior<Element, unknown> | undefined) ?? null;

  // Function to fit graph to view (can be called manually)
  const fitGraphToView = useCallback(() => {
    if (!svgRef.current) return;
    
    // Get the current SVG element
    const svg = d3.select(svgRef.current);
    
    // Get all nodes from the processed data
    const nodes = processedData.nodes;
    
    if (nodes.length === 0) return;
    
    // Try to get node positions from the simulation if available
    let nodePositions = nodes;
    
    // If we have access to the simulation, get the current node positions
    if ((window as any).graphSimulation) {
      const simNodes = (window as any).graphSimulation.nodes();
      nodePositions = simNodes.length > 0 ? simNodes : nodes;
    }
    
    const padding = 150;
    // Get the bounds of all nodes
    const minX = Math.min(...nodePositions.map(d => d.x || 0)) - padding;
    const maxX = Math.max(...nodePositions.map(d => d.x || 0)) + padding;
    const minY = Math.min(...nodePositions.map(d => d.y || 0)) - padding;
    const maxY = Math.max(...nodePositions.map(d => d.y || 0)) + padding;
    
    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    
    // Calculate scale to fit the graph with some margin
    const scaleX = (dimensions.width * 0.9) / graphWidth;
    const scaleY = (dimensions.height * 0.9) / graphHeight;
    const scale = Math.min(scaleX, scaleY, 3); // Use the new max scale limit
    
    // Calculate translation to center the graph
    const translateX = (dimensions.width - graphWidth * scale) / 2 - minX * scale;
    const translateY = (dimensions.height - graphHeight * scale) / 2 - minY * scale;
    
    const optimizedTransform = d3.zoomIdentity
      .translate(translateX, translateY)
      .scale(scale);

    // Reuse the zoom behaviour the simulation attached. Calling d3.zoom() again
    // here would install a second behaviour whose transform starts at identity,
    // so the next pan would jump back to the unfitted view.
    const zoom = getSharedZoom();
    if (!zoom) return;

    svg.transition()
       .duration(1500)
       .ease(d3.easeQuadOut)
       .call(zoom.transform as any, optimizedTransform);
  }, [processedData.nodes, dimensions]);

  // Function to fit to background image bounds
  const fitToImageBounds = useCallback(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const zoom = getSharedZoom();
    if (!zoom) return;

    // Bounds are rotation-aware, so the map lands centred without nudges.
    const fit = getFitToBackgroundTransform(dimensions.width, dimensions.height, 50);

    const transform = d3.zoomIdentity
      .translate(fit.x, fit.y)
      .scale(fit.scale);

    svg.transition()
       .duration(1500)
       .ease(d3.easeQuadOut)
       .call(zoom.transform as any, transform);
  }, [dimensions]);

  // Expose fitGraphToView function to parent component
  useEffect(() => {
    if (onFitToView) {
      onFitToView(fitGraphToView);
    }
  }, [onFitToView, fitGraphToView]);

  // Handle node selection
  const handleNodeClick = (node: Node) => {
    setSelectedNode(node);
  };

  // Handle closing node details panel
  const handleCloseNodeDetails = () => {
    setSelectedNode(null);
  };

  return (
    <div className="relative w-full h-full">
      {/* Main graph canvas */}
      <GraphCanvas
        svgRef={svgRef}
        data={processedData}
        currentHour={currentHour}
        dimensions={dimensions}
        isTimelinePlaying={isTimelinePlaying}
        graphStructureKey={graphStructureKey}
        filtersKey={filtersKey}
        selectedNode={selectedNode}
        onNodeClick={handleNodeClick}
        tooltip={tooltip}
        performanceMode={performanceMode}
      />

      {/* Node details panel */}
      <NodeDetailsPanel
        allNodes={data.nodes}
        selectedNode={selectedNode}
        onClose={handleCloseNodeDetails}
        links={data.links}
      />
    </div>
  );
};

export default Graph;
