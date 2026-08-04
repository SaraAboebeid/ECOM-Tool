import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { GraphData, Node } from '../types';
import { applyFixedPositions } from '../utils/nodePositioning';
import { getFitToBackgroundTransform } from '../utils/backgroundConfig';

interface UseGraphSimulationProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
  containerRef: React.RefObject<SVGGElement | null>;
  data: GraphData;
  dimensions: { width: number; height: number };
  graphStructureKey: string;
  filtersKey: string;
  selectedNode: Node | null;
}

/**
 * Custom hook for managing D3 force simulation with zoom/pan functionality
 */
export const useGraphSimulation = ({
  svgRef,
  containerRef,
  data,
  dimensions,
  graphStructureKey,
  filtersKey,
  selectedNode
}: UseGraphSimulationProps) => {
  const simulationRef = useRef<d3.Simulation<d3.SimulationNodeDatum, undefined> | null>(null);
  const zoomInitializedRef = useRef(false);
  const zoomRef = useRef<d3.ZoomBehavior<Element, unknown> | null>(null);

  // Effect for creating/recreating simulation only when structure changes
  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !data.nodes.length) return;

    const svg = d3.select(svgRef.current);
    const container = d3.select(containerRef.current);
    const { width, height } = dimensions;

    // Apply fixed positions to nodes - create a shared reference
    const nodeData = applyFixedPositions(data.nodes.map(d => ({ ...d })));
    const linkData = data.links.map(d => ({ ...d }));

    // Initialize unfixed nodes with spread-out positions to prevent clustering at (0,0)
    nodeData.forEach((node, index) => {
      if (!node.fx && !node.fy) {
        // Use a simple layout pattern to spread nodes initially
        const angle = (index * 2 * Math.PI) / nodeData.length;
        const radius = Math.min(width, height) * 0.3; // Start in a circle pattern
        node.x = width / 2 + Math.cos(angle) * radius;
        node.y = height / 2 + Math.sin(angle) * radius;
        // Add slight random velocity to avoid perfect overlap
        (node as any).vx = (Math.random() - 0.5) * 50;
        (node as any).vy = (Math.random() - 0.5) * 50;
      }
    });

    // Create force simulation with the same node references
    const simulation = d3.forceSimulation(nodeData as d3.SimulationNodeDatum[])
      .force('link', d3.forceLink(linkData).id((d: any) => d.id).distance(600))
      .force('charge', d3.forceManyBody().strength(-800))
      .force('x', d3.forceX(width / 2).strength(0.05)) // Stronger centering for better initial layout
      .force('y', d3.forceY(height / 2).strength(0.05)) // Stronger centering for better initial layout
      .force('collision', d3.forceCollide().radius(110))
      .alpha(1) // Start with full energy for better initial positioning
      .alphaDecay(0.0228)
      .velocityDecay(0.4)
      .restart(); // Explicitly restart the simulation

    simulationRef.current = simulation;
    
    // Store simulation globally for fit-to-view access
    (window as any).graphSimulation = simulation;
    
    // Store link data on simulation for component access
    // Node data can be accessed directly via simulation.nodes()
    (simulation as any).linkData = linkData;

    // Add zoom behavior only once
    if (!zoomInitializedRef.current) {
      const zoom = d3.zoom()
        .scaleExtent([0.1, 5]) // Increased zoom range for better flexibility
        .on('zoom', (event) => {
          container.attr('transform', event.transform);
        });
      
      // Store the zoom behavior in the ref for external access
      zoomRef.current = zoom;

      svg.call(zoom as any);
      zoomInitializedRef.current = true;

      // Share the zoom behaviour so fit-to-view drives the same transform state
      // instead of attaching a second, independent zoom.
      (window as any).graphZoom = zoom;

      // Fit the rotated background to the viewport. The bounds account for
      // COMPASS_ORIENTATION, so no hand-tuned centering offsets are needed.
      const fit = getFitToBackgroundTransform(width, height);

      const initialTransform = d3.zoomIdentity
        .translate(fit.x, fit.y)
        .scale(fit.scale);

      svg.call(zoom.transform as any, initialTransform);
    }

    // Cleanup function
    return () => {
      simulation.stop();
    };
  }, [svgRef, containerRef, dimensions, graphStructureKey]); // Only recreate simulation when graph structure actually changes

  // Separate effect for updating data without recreating simulation
  useEffect(() => {
    if (!simulationRef.current) return;

    const simulation = simulationRef.current;
    
    // Update nodes and links data without recreating the simulation
    const nodeData = applyFixedPositions(data.nodes.map(d => ({ ...d })));
    const linkData = data.links.map(d => ({ ...d }));
    
    // Update simulation nodes and links
    simulation.nodes(nodeData as d3.SimulationNodeDatum[]);
    
    const linkForce = simulation.force('link') as d3.ForceLink<d3.SimulationNodeDatum, d3.SimulationLinkDatum<d3.SimulationNodeDatum>>;
    if (linkForce) {
      linkForce.links(linkData);
    }
    
    // Store updated link data
    (simulation as any).linkData = linkData;
    
    // Gently restart simulation with low alpha to avoid jarring movements
    simulation.alpha(0.1).restart();
  }, [data]);

  return {
    simulation: simulationRef.current,
    zoom: zoomRef.current
  };
};

export default useGraphSimulation;
