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
  /**
   * Footprint centroids, canonically keyed. Fills in buildings the hand-placed
   * table has no entry for, so they land on their own building instead of in
   * the force layout.
   */
  footprintCentroids?: Map<string, { x: number; y: number }>;
}

/** Mean position of the nodes that did get a fixed position, if any. */
const placedCentre = (nodes: Node[]): { x: number; y: number } | null => {
  const placed = nodes.filter(n => n.fx != null && n.fy != null);
  if (!placed.length) return null;
  return {
    x: placed.reduce((sum, n) => sum + (n.fx as number), 0) / placed.length,
    y: placed.reduce((sum, n) => sum + (n.fy as number), 0) / placed.length
  };
};

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
  selectedNode,
  footprintCentroids
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
    const nodeData = applyFixedPositions(
      data.nodes.map(d => ({ ...d })),
      footprintCentroids
    );
    const linkData = data.links.map(d => ({ ...d }));

    // Anything still unplaced is seeded around the campus rather than around
    // the viewport centre. The two are different coordinate spaces - the fixed
    // positions are image-frame pixels - so seeding in viewport pixels used to
    // strand loose nodes ~1000px away from every building.
    const anchor = placedCentre(nodeData) ?? { x: width / 2, y: height / 2 };

    nodeData.forEach((node, index) => {
      if (!node.fx && !node.fy) {
        // Use a simple layout pattern to spread nodes initially
        const angle = (index * 2 * Math.PI) / nodeData.length;
        const radius = Math.min(width, height) * 0.3; // Start in a circle pattern
        node.x = anchor.x + Math.cos(angle) * radius;
        node.y = anchor.y + Math.sin(angle) * radius;
        // Add slight random velocity to avoid perfect overlap
        (node as any).vx = (Math.random() - 0.5) * 50;
        (node as any).vy = (Math.random() - 0.5) * 50;
      }
    });

    // Create force simulation with the same node references
    const simulation = d3.forceSimulation(nodeData as d3.SimulationNodeDatum[])
      .force('link', d3.forceLink(linkData).id((d: any) => d.id).distance(600))
      .force('charge', d3.forceManyBody().strength(-800))
      .force('x', d3.forceX(anchor.x).strength(0.05)) // Pull toward the campus, not the viewport
      .force('y', d3.forceY(anchor.y).strength(0.05))
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
    // footprintCentroids is in the deps because it arrives asynchronously: the
    // GeoJSON is fetched after first paint, and the nodes it places would
    // otherwise stay stuck wherever the force layout first put them.
  }, [svgRef, containerRef, dimensions, graphStructureKey, footprintCentroids]);

  // Separate effect for updating data without recreating simulation
  useEffect(() => {
    if (!simulationRef.current) return;

    const simulation = simulationRef.current;
    
    // Update nodes and links data without recreating the simulation
    const nodeData = applyFixedPositions(
      data.nodes.map(d => ({ ...d })),
      footprintCentroids
    );
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
  }, [data, footprintCentroids]);

  return {
    simulation: simulationRef.current,
    zoom: zoomRef.current
  };
};

export default useGraphSimulation;
