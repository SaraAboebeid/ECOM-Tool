import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { GraphData, Node, Link, NODE_COLORS } from '../types';
import { iconToString } from './NodeIcons';
import '../simple-animations.css'; // Import simplified animations

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
  onKPICalculated?: (kpis: {
    totalPVCapacity: number;
    totalEnergyDemand: number;
    totalBatteryCapacity: number;
    totalPVProduction: number;
    totalEmbodiedCO2: number;
  }) => void;
}

export const Graph = ({ data, currentHour, filters, isTimelinePlaying, onKPICalculated }: GraphProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<d3.SimulationNodeDatum, undefined> | null>(null);
  const particleTimeoutsRef = useRef<number[]>([]);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  // Tooltip div ref (created only once)
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  // State for selected node to show in slide panel
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  // Track if timeline is playing to control flow animations
  const [isPlaying, setIsPlaying] = useState(false);
  
  // Create a stable key for the graph structure
  const graphStructureKey = `${data.nodes.map(n => n.id).sort().join(',')}-${data.links.map(l => `${l.source}-${l.target}`).sort().join(',')}`;
  
  // Create stable keys for filters to prevent unnecessary re-renders
  const nodeTypesKey = Array.from(filters.nodeTypes).sort().join(',');
  const ownersKey = Array.from(filters.owners).sort().join(',');
  const filtersKey = `${nodeTypesKey}-${filters.minFlow}-${ownersKey}-${filters.v2gFilter}-${filters.capacityRange.min}-${filters.capacityRange.max}`;
  
  // Helper function to calculate KPIs and summarize data
  const calculateKPIs = () => {
    if (!data.nodes.length) return null;
    
    const kpis = {
      totalPVCapacity: 0,
      totalEnergyDemand: 0,
      totalBatteryCapacity: 0,
      totalPVProduction: 0,
      totalEmbodiedCO2: 0
    };
    
    data.nodes.forEach(node => {
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
  
  // Calculate KPIs when data changes
  const kpis = calculateKPIs();
  
  // Notify parent component of calculated KPIs
  useEffect(() => {
    if (kpis && onKPICalculated) {
      onKPICalculated(kpis);
    }
  }, [kpis, onKPICalculated]);
  
  // Update local playing state when the timeline playing status changes
  useEffect(() => {
    setIsPlaying(isTimelinePlaying === true);
    
    // If we have an SVG reference and the simulation exists, update particles when play state changes
    if (svgRef.current && simulationRef.current) {
      const svg = d3.select(svgRef.current);
      const particleContainer = svg.select('.particles');
      
      if (!particleContainer.empty()) {
        if (isTimelinePlaying) {
          // Trigger particle animations with slight delay to allow state to update
          setTimeout(() => {
            // Clear any existing particles first
            particleTimeoutsRef.current.forEach(clearTimeout);
            particleTimeoutsRef.current = [];
            particleContainer.selectAll('.particle').remove();
            
            // This will initiate particle animations based on the new playing state
            const event = new CustomEvent('updateParticles');
            window.dispatchEvent(event);
          }, 100);
        } else {
          // If pausing, remove all particles
          particleTimeoutsRef.current.forEach(clearTimeout);
          particleTimeoutsRef.current = [];
          particleContainer.selectAll('.particle').remove();
        }
      }
    }
  }, [isTimelinePlaying]);

  useEffect(() => {
    const handleResize = () => {
      if (svgRef.current) {
        const { width, height } = svgRef.current.getBoundingClientRect();
        setDimensions(prev => {
          // Only update if dimensions actually changed to prevent unnecessary re-renders
          if (prev.width !== width || prev.height !== height) {
            return { width, height };
          }
          return prev;
        });
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Create tooltip div only once
  useEffect(() => {
    if (!tooltipRef.current) {
      const div = document.createElement('div');
      div.className = 'tooltip';
      div.style.position = 'absolute';
      div.style.visibility = 'hidden';
      
      // Check if dark mode is active to set appropriate tooltip styles
      const isDarkMode = document.documentElement.classList.contains('dark');
      div.style.background = isDarkMode ? 'rgba(30, 41, 59, 0.9)' : 'rgba(0, 0, 0, 0.8)';
      div.style.color = 'white';
      div.style.padding = '8px';
      div.style.borderRadius = '4px';
      div.style.fontSize = '12px';
      div.style.pointerEvents = 'none'; // Ensures tooltip never captures pointer events
      div.style.zIndex = '1000';
      div.style.userSelect = 'none'; // Prevent text selection
      div.style.maxWidth = '200px';
      div.style.wordWrap = 'break-word';
      div.style.boxShadow = isDarkMode ? '0 4px 6px -1px rgba(0, 0, 0, 0.5)' : '0 4px 6px -1px rgba(0, 0, 0, 0.3)';
      div.style.border = isDarkMode ? '1px solid rgba(75, 85, 99, 0.5)' : 'none';
      document.body.appendChild(div);
      tooltipRef.current = div;
    } else {
      // Always ensure pointer-events is none
      tooltipRef.current.style.pointerEvents = 'none';
    }
    // Add a MutationObserver to update tooltip styles when dark mode changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class' && tooltipRef.current) {
          const isDarkMode = document.documentElement.classList.contains('dark');
          tooltipRef.current.style.background = isDarkMode ? 'rgba(30, 41, 59, 0.9)' : 'rgba(0, 0, 0, 0.8)';
          tooltipRef.current.style.boxShadow = isDarkMode ? '0 4px 6px -1px rgba(0, 0, 0, 0.5)' : '0 4px 6px -1px rgba(0, 0, 0, 0.3)';
          tooltipRef.current.style.border = isDarkMode ? '1px solid rgba(75, 85, 99, 0.5)' : 'none';
        }
      });
    });
    
    observer.observe(document.documentElement, { attributes: true });
    
    return () => {
      if (tooltipRef.current) {
        tooltipRef.current.remove();
        tooltipRef.current = null;
      }
      observer.disconnect();
    };
  }, []);

  // Add an event listener to handle clicks outside the panel
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // If panel is open and click is outside panel and not on a node
      if (selectedNode && 
          event.target instanceof Element && 
          !event.target.closest('.node') && 
          !event.target.closest('.node-details-panel')) {
        setSelectedNode(null);
      }
    };
    
    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [selectedNode]);
  
  // Initialize the simulation only once
  useEffect(() => {
    if (!svgRef.current || !data.nodes.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const { width, height } = dimensions;

    // Create deep copies to avoid modifying original data
    const nodeData = data.nodes.map(d => ({ ...d }));
    const linkData = data.links.map(d => ({ ...d }));

    // Find SB1 node and fix its position at 184.397,717.074
    const sb1Node = nodeData.find(n => n.id === 'SB1');
    if (sb1Node) {
        sb1Node.fx = 184.397;
        sb1Node.fy = 717.074;
    }
    //find Edit and fix its position at 319.370,759.348
    const editNode = nodeData.find(n => n.id === 'Edit');
    if (editNode) {
        editNode.fx = 319.370;
        editNode.fy = 759.348;
    }
    // find HA node and fix its position at 856,158
    const haNode = nodeData.find(n => n.id === 'HA');
    if (haNode) {
        haNode.fx = 856;
        haNode.fy = 158;
    }
    // find HB and fix its position at 931.232,20.418
    const hbNode = nodeData.find(n => n.id === 'HB');
    if (hbNode) {
        hbNode.fx = 931.232;
        hbNode.fy = 20.418;
    }
    // find HC and fix its position at 1009.722,9.556
    const hcNode = nodeData.find(n => n.id === 'HC');
    if (hcNode) {
        hcNode.fx = 1009.722;
        hcNode.fy = 9.556;
    }
    // Find Idelara and fix its position at 1101.542,64.525
    const idelaraNode = nodeData.find(n => n.id === 'Idelara');
    if (idelaraNode) {
        idelaraNode.fx = 1101.542;
        idelaraNode.fy = 64.525;
    }

    // Initialize unfixed nodes with random but spread-out positions to prevent clustering at (0,0)
    nodeData.forEach((node, index) => {
      if (!node.fx && !node.fy) {
        // Use a simple layout pattern to spread nodes initially
        const angle = (index * 2 * Math.PI) / nodeData.length;
        const radius = Math.min(width, height) * 0.3; // Start in a circle pattern
        node.x = width / 2 + Math.cos(angle) * radius;
        node.y = height / 2 + Math.sin(angle) * radius;
      }
    });

    // Create force simulation with better initial positioning
    const simulation = d3.forceSimulation(nodeData as d3.SimulationNodeDatum[])
      .force('link', d3.forceLink(linkData).id((d: any) => d.id).distance(600)) // 2x increased distance between connected nodes
      .force('charge', d3.forceManyBody().strength(-800)) // Reduced repulsion to prevent twitching
      .force('x', d3.forceX(width / 2).strength(0.05)) // Slightly stronger horizontal centering for better initial layout
      .force('y', d3.forceY(height / 2).strength(0.05)) // Slightly stronger vertical centering for better initial layout
      .force('collision', d3.forceCollide().radius(110)) // 2x increased collision radius
      .alpha(1) // Start with full energy for better initial positioning
      .alphaDecay(0.0228) // Slower cooling to stabilize better
      .velocityDecay(0.4); // Increased friction to reduce oscillation

    simulationRef.current = simulation;

    // Create container for zoom
    const container = svg.append('g');

    container.append('image')
      .attr('xlink:href', '/3d_topview.png')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', 565.752)
      .attr('height', 1276.608);

    // Add zoom behavior
    const zoom = d3.zoom()
      .scaleExtent([0.5, 3])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
      });

    svg.call(zoom as any);

    // Create SVG filter for glow effect
    const defs = svg.append('defs');
    
    // Create enhanced glow filter
    const filter = defs.append('filter')
      .attr('id', 'glow')
      .attr('x', '-50%')
      .attr('y', '-50%')
      .attr('width', '200%')
      .attr('height', '200%');
    
    // Add blur effect with higher quality
    filter.append('feGaussianBlur')
      .attr('stdDeviation', '3.5')
      .attr('result', 'blur');
      
    // Add color overlay with enhanced glow
    filter.append('feFlood')
      .attr('flood-color', '#4db8ff')
      .attr('flood-opacity', '0.4')
      .attr('result', 'color');
      
    filter.append('feComposite')
      .attr('in', 'color')
      .attr('in2', 'blur')
      .attr('operator', 'in')
      .attr('result', 'coloredBlur');
      
    // Merge the original and the colored blur
    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode')
      .attr('in', 'coloredBlur');
    feMerge.append('feMergeNode')
      .attr('in', 'SourceGraphic');

    // Create 3D depth shadow filter for nodes
    const depthShadowFilter = defs.append('filter')
      .attr('id', 'depth-shadow')
      .attr('x', '-60%')
      .attr('y', '-60%')
      .attr('width', '220%')
      .attr('height', '220%');
    
    // Create drop shadow
    depthShadowFilter.append('feDropShadow')
      .attr('dx', '3')
      .attr('dy', '5')
      .attr('stdDeviation', '4')
      .attr('flood-color', '#000000')
      .attr('flood-opacity', '0.3')
      .attr('result', 'dropShadow');
    
    // Add inner shadow for depth
    depthShadowFilter.append('feOffset')
      .attr('in', 'SourceGraphic')
      .attr('dx', '-1')
      .attr('dy', '-2')
      .attr('result', 'offset');
    
    depthShadowFilter.append('feGaussianBlur')
      .attr('in', 'offset')
      .attr('stdDeviation', '2')
      .attr('result', 'blur');
    
    depthShadowFilter.append('feFlood')
      .attr('flood-color', '#ffffff')
      .attr('flood-opacity', '0.15')
      .attr('result', 'highlight');
    
    depthShadowFilter.append('feComposite')
      .attr('in', 'highlight')
      .attr('in2', 'blur')
      .attr('operator', 'in')
      .attr('result', 'innerHighlight');
    
    const depthMerge = depthShadowFilter.append('feMerge');
    depthMerge.append('feMergeNode').attr('in', 'dropShadow');
    depthMerge.append('feMergeNode').attr('in', 'SourceGraphic');
    depthMerge.append('feMergeNode').attr('in', 'innerHighlight');

    // Create subtle line shadow filter
    const lineShadowFilter = defs.append('filter')
      .attr('id', 'line-shadow')
      .attr('x', '-50%')
      .attr('y', '-50%')
      .attr('width', '200%')
      .attr('height', '200%');
    
    lineShadowFilter.append('feDropShadow')
      .attr('dx', '1')
      .attr('dy', '2')
      .attr('stdDeviation', '2')
      .attr('flood-color', '#000000')
      .attr('flood-opacity', '0.2');

    // Create node-type specific neon glow filters with pulse animation and 3D depth
    const nodeTypes = ['building', 'pv', 'grid', 'battery', 'charge_point'];
    nodeTypes.forEach(type => {
      const nodeColor = NODE_COLORS[type];
      
      // Enhanced neon glow filter with 3D depth
      const filter = defs.append('filter')
        .attr('id', `neon-glow-${type}`)
        .attr('x', '-80%')
        .attr('y', '-80%')
        .attr('width', '260%')
        .attr('height', '260%');
      
      // Create layered shadow for depth
      filter.append('feDropShadow')
        .attr('dx', '4')
        .attr('dy', '6')
        .attr('stdDeviation', '3')
        .attr('flood-color', '#000000')
        .attr('flood-opacity', '0.4')
        .attr('result', 'shadow1');
      
      filter.append('feDropShadow')
        .attr('dx', '2')
        .attr('dy', '3')
        .attr('stdDeviation', '2')
        .attr('flood-color', nodeColor)
        .attr('flood-opacity', '0.6')
        .attr('result', 'shadow2');
      
      // Create the main glow effect
      filter.append('feGaussianBlur')
        .attr('in', 'SourceGraphic')
        .attr('stdDeviation', '6')
        .attr('result', 'glow');
      
      filter.append('feFlood')
        .attr('flood-color', nodeColor)
        .attr('flood-opacity', '0.8')
        .attr('result', 'glowColor');
      
      filter.append('feComposite')
        .attr('in', 'glowColor')
        .attr('in2', 'glow')
        .attr('operator', 'in')
        .attr('result', 'coloredGlow');
      
      // Add inner highlight for 3D effect
      filter.append('feOffset')
        .attr('in', 'SourceGraphic')
        .attr('dx', '-1')
        .attr('dy', '-2')
        .attr('result', 'highlight');
      
      filter.append('feGaussianBlur')
        .attr('in', 'highlight')
        .attr('stdDeviation', '1')
        .attr('result', 'softHighlight');
      
      filter.append('feFlood')
        .attr('flood-color', '#ffffff')
        .attr('flood-opacity', '0.3')
        .attr('result', 'white');
      
      filter.append('feComposite')
        .attr('in', 'white')
        .attr('in2', 'softHighlight')
        .attr('operator', 'in')
        .attr('result', 'innerLight');
      
      // Merge all effects for layered 3D appearance
      const merge = filter.append('feMerge');
      merge.append('feMergeNode').attr('in', 'shadow1');
      merge.append('feMergeNode').attr('in', 'shadow2');
      merge.append('feMergeNode').attr('in', 'coloredGlow');
      merge.append('feMergeNode').attr('in', 'SourceGraphic');
      merge.append('feMergeNode').attr('in', 'innerLight');
      
      // Create standard glow filter for smaller elements
      const typeFilter = defs.append('filter')
        .attr('id', `glow-${type}`)
        .attr('x', '-50%')
        .attr('y', '-50%')
        .attr('width', '200%')
        .attr('height', '200%');
      typeFilter.append('feGaussianBlur')
        .attr('stdDeviation', '12')
        .attr('result', 'blur');
      typeFilter.append('feFlood')
        .attr('flood-color', NODE_COLORS[type])
        .attr('flood-opacity', '1')
        .attr('result', 'color');
      typeFilter.append('feComposite')
        .attr('in', 'color')
        .attr('in2', 'blur')
        .attr('operator', 'in')
        .attr('result', 'coloredBlur');
      const typeFilterMerge = typeFilter.append('feMerge');
      typeFilterMerge.append('feMergeNode').attr('in', 'coloredBlur');
      typeFilterMerge.append('feMergeNode').attr('in', 'SourceGraphic');
    });
      
    // Create linear gradients for each node type's flow with 3D depth
    // PV gradient (neon yellow with depth)
    const pvGradient = defs.append('linearGradient')
      .attr('id', 'gradient-pv')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '100%')
      .attr('y2', '0%');
      
    pvGradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', d3.color(NODE_COLORS.pv)?.darker(0.3)?.toString() || NODE_COLORS.pv)
      .attr('stop-opacity', 0.8);
    pvGradient.append('stop')
      .attr('offset', '30%')
      .attr('stop-color', NODE_COLORS.pv)
      .attr('stop-opacity', 1);
    pvGradient.append('stop')
      .attr('offset', '70%')
      .attr('stop-color', d3.color(NODE_COLORS.pv)?.brighter(0.5)?.toString() || NODE_COLORS.pv)
      .attr('stop-opacity', 1);
    pvGradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', d3.color(NODE_COLORS.pv)?.darker(0.2)?.toString() || NODE_COLORS.pv)
      .attr('stop-opacity', 0.8);
      
    // Grid gradient (neon green with depth)
    const gridGradient = defs.append('linearGradient')
      .attr('id', 'gradient-grid')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '100%')
      .attr('y2', '0%');
      
    gridGradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', d3.color(NODE_COLORS.grid)?.darker(0.3)?.toString() || NODE_COLORS.grid)
      .attr('stop-opacity', 0.8);
    gridGradient.append('stop')
      .attr('offset', '30%')
      .attr('stop-color', NODE_COLORS.grid)
      .attr('stop-opacity', 1);
    gridGradient.append('stop')
      .attr('offset', '70%')
      .attr('stop-color', d3.color(NODE_COLORS.grid)?.brighter(0.5)?.toString() || NODE_COLORS.grid)
      .attr('stop-opacity', 1);
    gridGradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', d3.color(NODE_COLORS.grid)?.darker(0.2)?.toString() || NODE_COLORS.grid)
      .attr('stop-opacity', 0.8);
      
    // Battery gradient (neon cyan with depth)
    const batteryGradient = defs.append('linearGradient')
      .attr('id', 'gradient-battery')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '100%')
      .attr('y2', '0%');
      
    batteryGradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', d3.color(NODE_COLORS.battery)?.darker(0.3)?.toString() || NODE_COLORS.battery)
      .attr('stop-opacity', 0.8);
    batteryGradient.append('stop')
      .attr('offset', '30%')
      .attr('stop-color', NODE_COLORS.battery)
      .attr('stop-opacity', 1);
    batteryGradient.append('stop')
      .attr('offset', '70%')
      .attr('stop-color', d3.color(NODE_COLORS.battery)?.brighter(0.5)?.toString() || NODE_COLORS.battery)
      .attr('stop-opacity', 1);
    batteryGradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', d3.color(NODE_COLORS.battery)?.darker(0.2)?.toString() || NODE_COLORS.battery)
      .attr('stop-opacity', 0.8);
      
    // Building gradient (neon magenta with depth)
    const buildingGradient = defs.append('linearGradient')
      .attr('id', 'gradient-building')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '100%')
      .attr('y2', '0%');
      
    buildingGradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', d3.color(NODE_COLORS.building)?.darker(0.3)?.toString() || NODE_COLORS.building)
      .attr('stop-opacity', 0.8);
    buildingGradient.append('stop')
      .attr('offset', '30%')
      .attr('stop-color', NODE_COLORS.building)
      .attr('stop-opacity', 1);
    buildingGradient.append('stop')
      .attr('offset', '70%')
      .attr('stop-color', d3.color(NODE_COLORS.building)?.brighter(0.5)?.toString() || NODE_COLORS.building)
      .attr('stop-opacity', 1);
    buildingGradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', d3.color(NODE_COLORS.building)?.darker(0.2)?.toString() || NODE_COLORS.building)
      .attr('stop-opacity', 0.8);
      
    // Charge point gradient (neon orange with depth)
    const chargeGradient = defs.append('linearGradient')
      .attr('id', 'gradient-charge')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '100%')
      .attr('y2', '0%');
      
    chargeGradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', d3.color(NODE_COLORS.charge_point)?.darker(0.3)?.toString() || NODE_COLORS.charge_point)
      .attr('stop-opacity', 0.8);
    chargeGradient.append('stop')
      .attr('offset', '30%')
      .attr('stop-color', NODE_COLORS.charge_point)
      .attr('stop-opacity', 1);
    chargeGradient.append('stop')
      .attr('offset', '70%')
      .attr('stop-color', d3.color(NODE_COLORS.charge_point)?.brighter(0.5)?.toString() || NODE_COLORS.charge_point)
      .attr('stop-opacity', 1);
    chargeGradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', d3.color(NODE_COLORS.charge_point)?.darker(0.2)?.toString() || NODE_COLORS.charge_point)
      .attr('stop-opacity', 0.8);
    
    // Create arrow markers for links with different colors based on node type
    const markerTypes = [
      { id: 'flow-pv', color: NODE_COLORS.pv },
      { id: 'flow-grid', color: NODE_COLORS.grid },
      { id: 'flow-battery', color: NODE_COLORS.battery },
      { id: 'flow-building', color: NODE_COLORS.building },
      { id: 'flow-charge', color: NODE_COLORS.charge_point },
      { id: 'flow', color: '#999' } // Default marker
    ];
    
    defs.selectAll(null)
      .data(markerTypes)
      .enter().append('marker')
      .attr('id', d => d.id)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 40) // Increased to position arrows properly with larger nodes
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('fill', d => d.color)
      .attr('d', 'M0,-5L10,0L0,5');

    // Simpler link drawing with fewer effects for better performance
    const linkSelection = container.append('g')
      .selectAll('line')
      .data(linkData)
      .enter().append('line')
      .attr('class', (d: Link) => {
        // Simplified class assignment
        return 'link';
      })
      .attr('stroke', (d: any) => {
        // Simpler color assignment
        const sourceNode = d.source.type ? d.source : data.nodes.find(n => n.id === d.source);
        if (!sourceNode) return '#999';
        return NODE_COLORS[sourceNode.type] || '#999';
      })
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', (d: Link) => Math.max(1, Math.abs(d.flow[currentHour]) * 1.5))
      .attr('filter', 'none') // Remove filter for better performance
      .attr('marker-end', 'url(#flow)') // Use single marker for better performance
      .attr('x1', 0)
      .attr('y1', 0)
      .attr('x2', 0)
      .attr('y2', 0);

    // Create particle system for energy flow visualization
    const particleContainer = container.append('g').attr('class', 'particles');
    
    const createParticles = () => {
      // Clear existing timeouts
      particleTimeoutsRef.current.forEach(clearTimeout);
      particleTimeoutsRef.current = [];
      
      // Remove existing particles
      particleContainer.selectAll('.particle').remove();
      
      // Only process significant flows and limit total particles
      // Don't show animated particles if not playing
      if (!isPlaying) {
        return; // Exit early if not playing
      }
      
      const significantLinks = linkData
        .filter((link: any) => Math.abs(link.flow[currentHour]) > 0.05)
        .sort((a: any, b: any) => Math.abs(b.flow[currentHour]) - Math.abs(a.flow[currentHour]))
        .slice(0, 15); // Limit to top 15 flows
      
      significantLinks.forEach((link: any, linkIndex: number) => {
        const flowValue = Math.abs(link.flow[currentHour]);
        
        // Reduced number of particles per link (max 3)
        const numParticles = Math.min(3, Math.max(1, Math.floor(flowValue * 2)));
        
        // Get source node color for particles
        const sourceNode = link.source.type ? link.source : data.nodes.find(n => n.id === link.source);
        const particleColor = sourceNode ? NODE_COLORS[sourceNode.type] : '#999';
        
        for (let i = 0; i < numParticles; i++) {
          // Calculate proportional particle size based on node radius and flow
          const baseNodeRadius = 32; // Base node radius for reference
          const maxParticleSize = 4; // Maximum particle size to prevent them from being too large
          const minParticleSize = 1; // Minimum particle size
          const flowBasedSize = Math.min(maxParticleSize, minParticleSize + (flowValue * 1.5));
          const proportionalSize = Math.min(maxParticleSize, flowBasedSize * (baseNodeRadius / 50));
          
          const particle = particleContainer.append('circle')
            .attr('class', `particle particle-${linkIndex}-${i}`)
            .attr('r', proportionalSize) // Proportional particle size with max limit
            .attr('fill', particleColor)
            .attr('stroke', particleColor)
            .attr('stroke-width', 0.5)
            .attr('opacity', 0.8)
            .attr('filter', 'url(#glow)')
            .style('pointer-events', 'none');
          
          // Initial position offset for multiple particles on same link
          const offset = (i / numParticles) * 1.0;
          
          // Animation function for particle movement
          const animateParticle = () => {
            const sourceX = link.source.x || 0;
            const sourceY = link.source.y || 0;
            const targetX = link.target.x || 0;
            const targetY = link.target.y || 0;
            
            // Calculate direction based on flow direction
            const isReverse = link.flow[currentHour] < 0;
            const startX = isReverse ? targetX : sourceX;
            const startY = isReverse ? targetY : sourceY;
            const endX = isReverse ? sourceX : targetX;
            const endY = isReverse ? sourceY : targetY;
            
            // Calculate node radius to start/end particles at edge of nodes
            const nodeRadius = 35; // Approximate node radius
            const dx = endX - startX;
            const dy = endY - startY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance === 0) return;
            
            const unitX = dx / distance;
            const unitY = dy / distance;
            
            // Adjust start and end positions to node edges
            const adjustedStartX = startX + (unitX * nodeRadius);
            const adjustedStartY = startY + (unitY * nodeRadius);
            const adjustedEndX = endX - (unitX * nodeRadius);
            const adjustedEndY = endY - (unitY * nodeRadius);
            
            // Set initial position with offset
            const initialProgress = offset;
            const initialX = adjustedStartX + (adjustedEndX - adjustedStartX) * initialProgress;
            const initialY = adjustedStartY + (adjustedEndY - adjustedStartY) * initialProgress;
            
            particle
              .attr('cx', initialX)
              .attr('cy', initialY);
            
            // Animation duration based on flow intensity (faster for higher flow)
            const duration = Math.max(1000, 3000 - (flowValue * 500));
            
            // Animate particle movement
            particle
              .transition()
              .duration(duration)
              .ease(d3.easeLinear)
              .attr('cx', adjustedEndX)
              .attr('cy', adjustedEndY)
              .on('end', function() {
                // Reset particle to start position and restart animation
                d3.select(this)
                  .attr('cx', adjustedStartX)
                  .attr('cy', adjustedStartY);
                
                // Restart animation after a small delay
                setTimeout(animateParticle, i * 200); // Stagger restart times
              });
          };
          
          // Start animation with initial delay
          const timeoutId = setTimeout(animateParticle, i * 200);
          particleTimeoutsRef.current.push(timeoutId);
        }
      });
    };
    
    // Create initial particles
    createParticles();

    // Draw nodes
    const nodeSelection = container.append('g')
      .selectAll('g')
      .data(nodeData)
      .enter().append('g')
      .attr('class', d => `node node-${d.type}`)
      .classed('pulse', d => {
        // Add pulse animation for active nodes (those with energy flowing in or out)
        const hasActiveLinks = data.links.some(link => 
          (link.source === d.id || link.target === d.id) && 
          Math.abs(link.flow[currentHour]) > 0
        );
        return hasActiveLinks;
      })
      .style('cursor', 'pointer')
      .on('click', (event, d: Node) => {
        event.stopPropagation();
        setSelectedNode(d);
      })
      .on('mouseover', function() {
        d3.select(this).classed('hover', true);
      })
      .on('mouseout', function() {
        d3.select(this).classed('hover', false);
      })
      .call(d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any);

    // Simplified outer aura ring with less intense effects
    nodeSelection.append('circle')
      .attr('class', d => `node-aura node-aura-${d.type}`)
      .attr('r', (d: Node) => {
        // Fixed radius for better performance
        const baseRadius = 30;
        return baseRadius * 1.2; // Consistent size for all nodes
      })
      .attr('fill', 'none')
      .attr('stroke', d => NODE_COLORS[d.type])
      .attr('stroke-width', 2)
      .attr('opacity', 0.5)
      .attr('filter', 'none'); // Remove filter for better performance

    // Main node circle with simplified depth effects (smaller, neon fill, fits icon/text)
    nodeSelection.append('circle')
      .attr('class', d => `node-main node-main-${d.type}`)
      .attr('r', (d: Node) => {
        // Base radius reduced for compactness
        let baseRadius = 30;
        switch(d.type) {
          case 'building':
            return baseRadius + 2; // Simplified sizing for better performance
          case 'pv':
            return baseRadius + 2;
          case 'battery':
            return baseRadius + 2;
          case 'charge_point':
            return baseRadius + 2;
          default:
            return baseRadius;
        }
      })
      .attr('fill', d => NODE_COLORS[d.type])
      .attr('stroke', d => d3.color(NODE_COLORS[d.type])?.brighter(0.3)?.toString() || NODE_COLORS[d.type])
      .attr('stroke-width', 2) // Thinner stroke for better performance
      .attr('filter', 'none'); // Remove filter for better performance

    // Add SVG icons inside nodes
    nodeSelection.each(function(d: Node) {
      const node = d3.select(this);
      const nodeType = d.type;
      
      // Insert SVG icon in the center of the node
      const iconSvgString = iconToString(nodeType);
      const iconSize = 24; // Increased icon size to match larger nodes
      
      if (iconSvgString) {
        const parser = new DOMParser();
        const iconDoc = parser.parseFromString(iconSvgString, 'image/svg+xml');
        const iconNode = iconDoc.documentElement;
        
        // Append the icon to the node
        node.node()?.appendChild(iconNode);
        
        // Position the icon in the center but slightly above center to make room for text
        d3.select(iconNode)
          .attr('width', iconSize * 2)
          .attr('height', iconSize * 2)
          .attr('x', -iconSize)
          .attr('y', -iconSize - 8) // Move icon slightly more upward for larger node
          .attr('fill', 'white');
      }
      
      // Add text label inside the node (short name or first letter of ID)
      node.append('text')
        .attr('class', 'node-inner-label')
        .attr('text-anchor', 'middle')
        .attr('dy', '20px') // Position even lower below the icon
        .attr('fill', 'white')
        .attr('font-size', '12px') // Increased font size for better visibility
        .attr('font-weight', 'bold')
        .attr('pointer-events', 'none')
        .text(() => {
          // Use first two characters of name or id for the inner label
          const label = d.name || d.id;
          return label.substring(0, 2);
        });
        
      // Add power value inside the node
      node.append('text')
        .attr('class', 'node-power-value')
        .attr('text-anchor', 'middle')
        .attr('dy', '35px') // Position further below the text label
        .attr('fill', 'white')
        .attr('font-size', '11px') // Larger font size for better readability
        .attr('font-weight', 'bold')
        .attr('pointer-events', 'none')
        .text(() => {
          // Return the appropriate power value based on node type
          switch(d.type) {
            case 'pv':
              return d.installed_capacity ? `${d.installed_capacity.toFixed(1)} kW` : '';
            case 'building':
              // For buildings we might show demand in kW (assuming it's per hour) or use another appropriate measure
              return d.total_pv_capacity ? `${d.total_pv_capacity.toFixed(1)} kW` : '';
            case 'battery':
              return d.capacity ? `${d.capacity.toFixed(1)} kW` : '';
            case 'charge_point':
              return d.capacity ? `${d.capacity.toFixed(1)} kW` : '';
            default:
              return '';
          }
        });
      
      // Add feature indicators (small dots)
      if (d.type === 'building' && d.total_pv_capacity && d.total_pv_capacity > 0) {
        // Add small solar indicator for buildings with PV
        node.append('circle')
          .attr('r', 8) // Slightly larger indicator for bigger nodes
          .attr('cx', 25) // Adjusted position for larger node
          .attr('cy', -25) // Adjusted position for larger node
          .attr('fill', NODE_COLORS['pv'])
          .attr('stroke', '#fff')
          .attr('stroke-width', 1.5)
          .attr('filter', 'url(#glow)');
      }
      
      if (d.type === 'charge_point' && d.is_v2g) {
        // Add V2G indicator for charge points with V2G capability
        node.append('circle')
          .attr('r', 8) // Slightly larger indicator for bigger nodes
          .attr('cx', 25) // Adjusted position for larger node
          .attr('cy', -25) // Adjusted position for larger node
          .attr('fill', '#10B981')
          .attr('stroke', '#fff')
          .attr('stroke-width', 1.5)
          .attr('filter', 'url(#glow)');
      }
    });
    
    // Add labels below nodes (now smaller since we have internal labels)
    nodeSelection.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '4em') // Moved further down to account for larger node size 
      .attr('fill', d => {
        // Use dark text for bright nodes and light text for dark nodes
        return d.type === 'pv' ? '#333' : '#fff';
      })
      .attr('font-size', '12px') // Larger font for better visibility with bigger nodes
      .attr('font-weight', 'bold')
      .attr('class', 'node-label')
      .text((d: Node) => d.name || d.id);
      
    // Add type labels (instead of power values which are now inside the node)
    nodeSelection.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '5.5em') // Moved further down to account for larger node size
      .attr('fill', '#fff')
      .attr('font-size', '10px') // Larger font for better visibility with bigger nodes
      .attr('class', 'node-metric')
      .text((d: Node) => {
        // Show the node type in a more human-readable format
        switch(d.type) {
          case 'pv':
            return 'Solar PV';
          case 'building':
            return d.building_type || 'Building';
          case 'battery':
            return 'Battery';
          case 'charge_point':
            return 'Charging';
          case 'grid':
            return 'Grid';
          default:
            return d.type;
        }
      });

    // Use tooltipRef for tooltip
    const tooltip = tooltipRef.current;
    let hideTooltipTimeout: number | null = null;

    // Helper to show tooltip
    function showTooltip(html: string, event: any) {
      if (!tooltip) return;
      if (hideTooltipTimeout) {
        clearTimeout(hideTooltipTimeout);
        hideTooltipTimeout = null;
      }
      tooltip.innerHTML = html;
      tooltip.style.visibility = 'visible';
      // Position tooltip away from cursor to prevent interference
      tooltip.style.left = (event.pageX + 15) + 'px';
      tooltip.style.top = (event.pageY - 35) + 'px';
    }
    // Helper to hide tooltip with debounce
    function hideTooltip() {
      if (!tooltip) return;
      if (hideTooltipTimeout) clearTimeout(hideTooltipTimeout);
      hideTooltipTimeout = setTimeout(() => {
        if (tooltip) tooltip.style.visibility = 'hidden';
      }, 80); // 80ms debounce
    }

    // Add hover events to links with enhanced flow information
    linkSelection
      .on('mouseover', (event, d: any) => {
        event.stopPropagation();
        const currentFlow = Math.abs(d.flow[currentHour]).toFixed(2);
        const sourceName = d.source.name || d.source.id;
        const targetName = d.target.name || d.target.id;
        
        // Calculate average and max flow for context
        const nonZeroFlows = d.flow.filter((f: number) => f > 0);
        const avgFlow = nonZeroFlows.length > 0 
          ? (nonZeroFlows.reduce((sum: number, val: number) => sum + val, 0) / nonZeroFlows.length).toFixed(2) 
          : 0;
        const maxFlow = Math.max(...d.flow).toFixed(2);
        
        // Get source and target node types for additional context
        const sourceType = d.source.type;
        const targetType = d.target.type;
        
        // Build tooltip content
        let tooltipContent = `<strong>${sourceName} → ${targetName}</strong><br/>`;
        tooltipContent += `Current Flow: ${currentFlow} kWh<br/>`;
        tooltipContent += `Average Flow: ${avgFlow} kWh<br/>`;
        tooltipContent += `Max Flow: ${maxFlow} kWh<br/>`;
        
        // Add energy flow description based on node types
        if (sourceType === 'pv' && targetType === 'building') {
          tooltipContent += `<br/><span style="color:#F59E0B">Solar energy supplying building</span>`;
        } else if (sourceType === 'building' && targetType === 'battery') {
          tooltipContent += `<br/><span style="color:#3B82F6">Building energy to battery storage</span>`;
        } else if (sourceType === 'building' && targetType === 'grid') {
          tooltipContent += `<br/><span style="color:#10B981">Building exporting to grid</span>`;
        } else if (sourceType === 'battery' && targetType === 'building') {
          tooltipContent += `<br/><span style="color:#3B82F6">Battery supplying building</span>`;
        } else if (sourceType === 'grid' && targetType === 'building') {
          tooltipContent += `<br/><span style="color:#10B981">Grid supplying building</span>`;
        }
        
        showTooltip(tooltipContent, event);
      })
      .on('mousemove', (event) => {
        event.stopPropagation();
        if (!tooltip) return;
        tooltip.style.left = (event.pageX + 15) + 'px';
        tooltip.style.top = (event.pageY - 35) + 'px';
      })
      .on('mouseout', (event) => {
        event.stopPropagation();
        hideTooltip();
      });

    // Add hover events to nodes with enhanced data display
    nodeSelection
      .on('mouseover', (event, d: Node) => {
        // Prevent event bubbling that could cause flickering
        event.stopPropagation();
        // Don't show tooltip if panel is open
        if (selectedNode) return;
        const displayName = d.name || d.id;
        
        // Build tooltip content based on node type and available data
        let tooltipContent = `<strong>${displayName}</strong><br/>Type: ${d.type}<br/>ID: ${d.id}`;
        
        // Add type-specific information
        switch(d.type) {
          case 'building':
            if (d.building_type) tooltipContent += `<br/>Building Type: ${d.building_type}`;
            if (d.area) tooltipContent += `<br/>Area: ${d.area.toFixed(2)} m²`;
            if (d.owner) tooltipContent += `<br/>Owner: ${d.owner}`;
            if (d.total_energy_demand) tooltipContent += `<br/>Energy Demand: ${d.total_energy_demand.toFixed(2)} kWh`;
            break;
          
          case 'pv':
            if (d.installed_capacity) tooltipContent += `<br/>Capacity: ${d.installed_capacity.toFixed(2)} kW`;
            if (d.annual_production) tooltipContent += `<br/>Annual Production: ${d.annual_production.toFixed(2)} kWh`;
            if (d.total_cost) tooltipContent += `<br/>Total Cost: ${d.total_cost.toFixed(2)} SEK`;
            if (d.total_embodied_co2) tooltipContent += `<br/>Embodied CO₂: ${d.total_embodied_co2.toFixed(2)} kgCO₂e`;
            break;
          
          case 'battery':
            if (d.capacity) tooltipContent += `<br/>Capacity: ${d.capacity.toFixed(2)} kWh`;
            if (d.total_cost) tooltipContent += `<br/>Cost: ${d.total_cost.toFixed(2)} SEK`;
            if (d.total_embodied_co2) tooltipContent += `<br/>Embodied CO₂: ${d.total_embodied_co2.toFixed(2)} kgCO₂e`;
            break;
          
          case 'charge_point':
            if (d.capacity) tooltipContent += `<br/>Capacity: ${d.capacity.toFixed(2)} kW`;
            if (d.is_v2g !== undefined) tooltipContent += `<br/>V2G Enabled: ${d.is_v2g ? 'Yes' : 'No'}`;
            if (d.total_connected_evs) tooltipContent += `<br/>Connected EVs: ${d.total_connected_evs}`;
            if (d.owner) tooltipContent += `<br/>Owner: ${d.owner}`;
            break;
          
          case 'grid':
            // Grid-specific data if available
            break;
        }
        
        showTooltip(tooltipContent, event);
      })
      .on('mousemove', (event) => {
        event.stopPropagation();
        if (!tooltip) return;
        tooltip.style.left = (event.pageX + 15) + 'px';
        tooltip.style.top = (event.pageY - 35) + 'px';
      })
      .on('mouseout', (event) => {
        event.stopPropagation();
        hideTooltip();
      });

    // Update positions on simulation tick with requestAnimationFrame for smoother rendering
    simulation.on('tick', () => {
      // Use requestAnimationFrame for smoother rendering
      requestAnimationFrame(() => {
        linkSelection
          .attr('x1', (d: any) => d.source.x)
          .attr('y1', (d: any) => d.source.y)
          .attr('x2', (d: any) => d.target.x)
          .attr('y2', (d: any) => d.target.y);

        nodeSelection.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
      });
    });

    // Apply initial zoom to show all nodes properly
    const initialScale = 0.8; // Start at a good scale to see all nodes
    const initialTransform = d3.zoomIdentity
      .translate(width * 0.1, height * 0.1) // Center with less padding to show more content
      .scale(initialScale);
    
    svg.call(zoom.transform as any, initialTransform);

    // Set up a callback to optimize zoom once simulation has stabilized
    let hasOptimizedZoom = false;
    const optimizeZoom = () => {
      if (hasOptimizedZoom) return;
      
      const nodes = simulation.nodes() as any[];
      if (nodes.length === 0) return;
      
      // Check if nodes have settled (have actual positions)
      const nodesWithPositions = nodes.filter(d => d.x !== undefined && d.y !== undefined);
      if (nodesWithPositions.length < nodes.length * 0.8) return; // Wait until 80% of nodes have positions
      
      const padding = 120;
      const minX = Math.min(...nodesWithPositions.map(d => d.x)) - padding;
      const maxX = Math.max(...nodesWithPositions.map(d => d.x)) + padding;
      const minY = Math.min(...nodesWithPositions.map(d => d.y)) - padding;
      const maxY = Math.max(...nodesWithPositions.map(d => d.y)) + padding;
      
      const graphWidth = maxX - minX;
      const graphHeight = maxY - minY;
      
      // Calculate scale to fit the graph with some margin
      const scaleX = (width * 0.85) / graphWidth;
      const scaleY = (height * 0.85) / graphHeight;
      const scale = Math.min(scaleX, scaleY, 1.0); // Allow up to 100% scale
      
      // Calculate translation to center the graph
      const translateX = (width - graphWidth * scale) / 2 - minX * scale;
      const translateY = (height - graphHeight * scale) / 2 - minY * scale;
      
      const optimizedTransform = d3.zoomIdentity
        .translate(translateX, translateY)
        .scale(scale);
      
      svg.transition()
        .duration(1000)
        .ease(d3.easeQuadOut)
        .call(zoom.transform as any, optimizedTransform);
        
      hasOptimizedZoom = true;
    };

    // Try to optimize zoom after simulation has had time to position nodes
    setTimeout(optimizeZoom, 2000);
    
    // Also listen for simulation end event to optimize zoom
    simulation.on('end', optimizeZoom);

    // Drag functions
    function dragstarted(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event: any, d: any) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }

    // Cleanup function
    return () => {
      simulation.stop();
      // Clear all particle timeouts
      particleTimeoutsRef.current.forEach(clearTimeout);
      particleTimeoutsRef.current = [];
      // Stop all particle animations
      if (svgRef.current) {
        const svg = d3.select(svgRef.current);
        const particleContainer = svg.select('.particles');
        if (!particleContainer.empty()) {
          particleContainer.selectAll('.particle').interrupt().remove();
        }
      }
      // Do not remove tooltip here; it's managed by the outer effect
    };
  }, [graphStructureKey, dimensions.width, dimensions.height, filtersKey, selectedNode]); // Only recreate when actual structure or filters change

  // Update link widths and colors when currentHour changes (without recreating the entire graph)
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const linkSelection = svg.selectAll('.link');
    const nodeSelection = svg.selectAll('.node');
    
    // Update links with enhanced 3D effects
    linkSelection
      .transition()
      .duration(300)
      .attr('stroke-width', (d: any) => Math.max(2, Math.abs(d.flow[currentHour]) * 2.5))
      .attr('stroke-opacity', (d: any) => Math.abs(d.flow[currentHour]) > 0 ? 0.9 : 0.4)
      .attr('class', (d: any) => {
        // Update animation class based on flow direction
        if (Math.abs(d.flow[currentHour]) > 0) {
          return d.flow[currentHour] > 0 ? 'link link-flow' : 'link link-flow-reverse';
        }
        return 'link';
      })
      .attr('stroke', (d: any) => {
        // Determine the gradient to use based on source node type
        const sourceNode = d.source.type ? d.source : data.nodes.find((n: any) => n.id === d.source);
        const targetNode = d.target.type ? d.target : data.nodes.find((n: any) => n.id === d.target);
        
        if (!sourceNode || !targetNode) return '#999';
        
        // If flow is too low, use a neutral color
        if (Math.abs(d.flow[currentHour]) < 0.01) return '#999';
        
        // Use appropriate gradient based on energy flow type
        if (sourceNode.type === 'pv') return 'url(#gradient-pv)';
        if (sourceNode.type === 'grid') return 'url(#gradient-grid)';
        if (sourceNode.type === 'battery') return 'url(#gradient-battery)';
        if (sourceNode.type === 'building') return 'url(#gradient-building)';
        if (sourceNode.type === 'charge_point') return 'url(#gradient-charge)';
        
        return '#999';
      })
      .attr('filter', (d: any) => {
        // Enhanced shadow for active flows
        return Math.abs(d.flow[currentHour]) > 0.1 ? 'url(#line-shadow)' : 'none';
      })
      .attr('marker-end', (d: any) => {
        // Determine the marker to use based on source node type
        const sourceNode = d.source.type ? d.source : data.nodes.find((n: any) => n.id === d.source);
        if (!sourceNode) return 'url(#flow)';
        
        // If flow is too low, use the default marker
        if (Math.abs(d.flow[currentHour]) < 0.01) return 'url(#flow)';
        
        // Use appropriate marker based on energy source type
        if (sourceNode.type === 'pv') return 'url(#flow-pv)';
        if (sourceNode.type === 'grid') return 'url(#flow-grid)';
        if (sourceNode.type === 'battery') return 'url(#flow-battery)';
        if (sourceNode.type === 'building') return 'url(#flow-building)';
        if (sourceNode.type === 'charge_point') return 'url(#flow-charge)';
        
        return 'url(#flow)';
      });
      
    // Update nodes - add/remove pulse animation class and dynamic sizing based on energy flow
    nodeSelection.each(function(d: any) {
      // Check if this node has any active flows in the current hour
      const hasActiveFlow = data.links.some((link: Link) => {
        return (link.source === d.id || link.target === d.id) && 
               Math.abs(link.flow[currentHour]) >= 0.1;
      });
      
      // Calculate total energy flow for this node at current hour
      const totalEnergyFlow = data.links.reduce((sum: number, link: Link) => {
        if (link.source === d.id || link.target === d.id) {
          return sum + Math.abs(link.flow[currentHour]);
        }
        return sum;
      }, 0);
      
      // Calculate dynamic radius based on energy flow (elastic scaling)
      const baseRadius = (() => {
        let base = 32;
        switch(d.type) {
          case 'building':
            return d.total_energy_demand ? base + Math.min(6, Math.sqrt(d.total_energy_demand) / 30) : base;
          case 'pv':
            return d.installed_capacity ? base + Math.min(8, d.installed_capacity / 2) : base;
          case 'battery':
            return d.capacity ? base + Math.min(10, d.capacity / 10) : base;
          case 'charge_point':
            return d.total_connected_evs ? base + Math.min(6, d.total_connected_evs * 2) : base;
          default:
            return base;
        }
      })();
      
      // Add dynamic scaling based on energy flow (max 20% increase)
      const flowScaling = Math.min(0.2, totalEnergyFlow * 0.05);
      const dynamicRadius = baseRadius * (1 + flowScaling);
      const dynamicAuraRadius = dynamicRadius * 1.25;
      
      // Apply the pulse animation class if the node has active flows
      d3.select(this)
        .classed('pulse', hasActiveFlow);
        
      // Apply elastic animations to node circles with energy flow-based sizing
      d3.select(this).select('.node-main')
        .transition()
        .duration(800)
        .ease(d3.easeElastic.period(0.3))
        .attr('r', dynamicRadius);
        
      d3.select(this).select('.node-aura')
        .transition()
        .duration(800)
        .ease(d3.easeElastic.period(0.3))
        .attr('r', dynamicAuraRadius);
    });

    // Update particles for current hour
    const particleContainer = svg.select('.particles');
    if (!particleContainer.empty()) {
      const updateParticles = () => {
        // Clear existing timeouts
        particleTimeoutsRef.current.forEach(clearTimeout);
        particleTimeoutsRef.current = [];
        
        // Remove existing particles
        particleContainer.selectAll('.particle').remove();
        
        // Only show animated particles if timeline is playing
        if (!isPlaying) {
          return; // Exit early if not playing
        }
        
        // Create particles for links with active flow
        data.links.forEach((link: any, linkIndex: number) => {
          const flowValue = Math.abs(link.flow[currentHour]);
          if (flowValue < 0.01) return; // Skip links with minimal flow
          
          // Find actual link data with positions
          const linkWithPositions = linkSelection.data().find((l: any) => 
            l.source.id === link.source && l.target.id === link.target
          );
          if (!linkWithPositions) return;
          
          // Number of particles based on flow intensity (1-5 particles)
          const numParticles = Math.min(5, Math.max(1, Math.floor(flowValue * 3)));
          
          // Get source node color for particles
          const sourceNode = data.nodes.find(n => n.id === link.source);
          const particleColor = sourceNode ? NODE_COLORS[sourceNode.type] : '#999';
          
          for (let i = 0; i < numParticles; i++) {
            // Calculate proportional particle size based on node radius and flow
            const baseNodeRadius = 32; // Base node radius for reference
            const maxParticleSize = 4; // Maximum particle size to prevent them from being too large
            const minParticleSize = 1; // Minimum particle size
            const flowBasedSize = Math.min(maxParticleSize, minParticleSize + (flowValue * 1.5));
            const proportionalSize = Math.min(maxParticleSize, flowBasedSize * (baseNodeRadius / 50));
            
            const particle = particleContainer.append('circle')
              .attr('class', `particle particle-${linkIndex}-${i}`)
              .attr('r', proportionalSize) // Proportional particle size with max limit
              .attr('fill', particleColor)
              .attr('stroke', particleColor)
              .attr('stroke-width', 0.5)
              .attr('opacity', 0.8)
              .attr('filter', 'url(#glow)')
              .style('pointer-events', 'none');
            
            // Initial position offset for multiple particles on same link
            const offset = (i / numParticles) * 1.0;
            
            // Animation function for particle movement
            const animateParticle = () => {
              const sourceX = (linkWithPositions as any).source.x || 0;
              const sourceY = (linkWithPositions as any).source.y || 0;
              const targetX = (linkWithPositions as any).target.x || 0;
              const targetY = (linkWithPositions as any).target.y || 0;
              
              // Calculate direction based on flow direction
              const isReverse = link.flow[currentHour] < 0;
              const startX = isReverse ? targetX : sourceX;
              const startY = isReverse ? targetY : sourceY;
              const endX = isReverse ? sourceX : targetX;
              const endY = isReverse ? sourceY : targetY;
              
              // Calculate node radius to start/end particles at edge of nodes
              const nodeRadius = 35; // Approximate node radius
              const dx = endX - startX;
              const dy = endY - startY;
              const distance = Math.sqrt(dx * dx + dy * dy);
              
              if (distance === 0) return;
              
              const unitX = dx / distance;
              const unitY = dy / distance;
              
              // Adjust start and end positions to node edges
              const adjustedStartX = startX + (unitX * nodeRadius);
              const adjustedStartY = startY + (unitY * nodeRadius);
              const adjustedEndX = endX - (unitX * nodeRadius);
              const adjustedEndY = endY - (unitY * nodeRadius);
              
              // Set initial position with offset
              const initialProgress = offset;
              const initialX = adjustedStartX + (adjustedEndX - adjustedStartX) * initialProgress;
              const initialY = adjustedStartY + (adjustedEndY - adjustedStartY) * initialProgress;
              
              particle
                .attr('cx', initialX)
                .attr('cy', initialY);
              
              // Animation duration based on flow intensity (faster for higher flow)
              const duration = Math.max(1000, 3000 - (flowValue * 500));
              
              // Animate particle movement
              particle
                .transition()
                .duration(duration)
                .ease(d3.easeLinear)
                .attr('cx', adjustedEndX)
                .attr('cy', adjustedEndY)
                .on('end', function() {
                  // Only restart if particle still exists (to avoid memory leaks)
                  if (particleContainer.select(`.particle-${linkIndex}-${i}`).empty()) return;
                  
                  // Reset particle to start position and restart animation
                  d3.select(this)
                    .attr('cx', adjustedStartX)
                    .attr('cy', adjustedStartY);
                  
                  // Restart animation after a small delay
                  const restartTimeoutId = setTimeout(animateParticle, i * 200); // Stagger restart times
                  particleTimeoutsRef.current.push(restartTimeoutId);
                });
            };
            
            // Start animation with initial delay
            const timeoutId = setTimeout(animateParticle, i * 200);
            particleTimeoutsRef.current.push(timeoutId);
          }
        });
      };
      
      // Update particles with a slight delay to ensure links are updated first
      setTimeout(updateParticles, 350);
    }

  }, [currentHour, data.nodes, data.links, isPlaying]); // Update when hour changes or play state changes

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (simulationRef.current) {
        simulationRef.current.stop();
      }
      // Tooltip is removed by the tooltip effect above
    };
  }, []);

  // Node details slide-in panel
  const renderNodeDetailsPanel = () => {
    if (!selectedNode) return null;
    
    const getAttributesByNodeType = () => {
      switch(selectedNode.type) {
        case 'building':
          return (
            <>
              {selectedNode.building_type && (
                <div className="mb-2">
                  <span className="font-semibold">Building Type:</span> {selectedNode.building_type}
                </div>
              )}
              {selectedNode.area !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Area:</span> {selectedNode.area.toFixed(2)} m²
                </div>
              )}
              {selectedNode.owner && (
                <div className="mb-2">
                  <span className="font-semibold">Owner:</span> {selectedNode.owner}
                </div>
              )}
              {selectedNode.total_energy_demand !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Energy Demand:</span> {selectedNode.total_energy_demand.toFixed(2)} kWh
                </div>
              )}
              {selectedNode.total_pv_capacity !== undefined && selectedNode.total_pv_capacity > 0 && (
                <div className="mb-2">
                  <span className="font-semibold">PV Capacity:</span> {selectedNode.total_pv_capacity.toFixed(2)} kW
                </div>
              )}
            </>
          );
        case 'pv':
          return (
            <>
              {selectedNode.installed_capacity !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Capacity:</span> {selectedNode.installed_capacity.toFixed(2)} kW
                </div>
              )}
              {selectedNode.annual_production !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Annual Production:</span> {selectedNode.annual_production.toFixed(2)} kWh
                </div>
              )}
              {selectedNode.total_cost !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Total Cost:</span> {selectedNode.total_cost.toFixed(2)} SEK
                </div>
              )}
              {selectedNode.total_embodied_co2 !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Embodied CO₂:</span> {selectedNode.total_embodied_co2.toFixed(2)} kgCO₂e
                </div>
              )}
            </>
          );
        case 'battery':
          return (
            <>
              {selectedNode.capacity !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Capacity:</span> {selectedNode.capacity.toFixed(2)} kWh
                </div>
              )}
              {selectedNode.total_cost !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Cost:</span> {selectedNode.total_cost.toFixed(2)} SEK
                </div>
              )}
              {selectedNode.total_embodied_co2 !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Embodied CO₂:</span> {selectedNode.total_embodied_co2.toFixed(2)} kgCO₂e
                </div>
              )}
            </>
          );
        case 'charge_point':
          return (
            <>
              {selectedNode.capacity !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Capacity:</span> {selectedNode.capacity.toFixed(2)} kW
                </div>
              )}
              {selectedNode.is_v2g !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">V2G Enabled:</span> {selectedNode.is_v2g ? 'Yes' : 'No'}
                </div>
              )}
              {selectedNode.total_connected_evs !== undefined && (
                <div className="mb-2">
                  <span className="font-semibold">Connected EVs:</span> {selectedNode.total_connected_evs}
                </div>
              )}
              {selectedNode.owner && (
                <div className="mb-2">
                  <span className="font-semibold">Owner:</span> {selectedNode.owner}
                </div>
              )}
            </>
          );
        case 'grid':
          return (
            <div className="mb-2">
              <span className="font-semibold">Type:</span> Electrical Grid
            </div>
          );
        default:
          return null;
      }
    };

    return (
      <div 
        className={`node-details-panel fixed top-0 right-0 h-full bg-white dark:bg-gray-800 w-80 shadow-lg transform transition-transform duration-300 ease-in-out ${
          selectedNode ? 'translate-x-0' : 'translate-x-full'
        } z-10 overflow-y-auto`}
      >
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white">
              {selectedNode.name || selectedNode.id}
            </h3>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          
          <div className="mb-4 inline-block px-3 py-1 rounded-full text-sm font-medium text-white" 
               style={{ backgroundColor: NODE_COLORS[selectedNode.type] }}>
            {selectedNode.type.replace('_', ' ')}
          </div>
          
          <div className="space-y-4">
            <div>
              <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Attributes</h4>
              <div className="bg-gray-100 dark:bg-gray-700 p-4 rounded-lg">
                <div className="mb-2">
                  <span className="font-semibold">ID:</span> {selectedNode.id}
                </div>
                {getAttributesByNodeType()}
              </div>
            </div>
            
            {selectedNode.type === 'pv' && (
              <div className="mt-6">
                <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">KPIs</h4>
                <div className="grid grid-cols-1 gap-4">
                  <div className="bg-blue-100 dark:bg-blue-900 p-4 rounded-lg">
                    <div className="text-xl font-bold">{selectedNode.annual_production?.toFixed(2) || 0}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-300">Annual Production (kWh)</div>
                  </div>
                  <div className="bg-green-100 dark:bg-green-900 p-4 rounded-lg">
                    <div className="text-xl font-bold">{selectedNode.installed_capacity?.toFixed(2) || 0}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-300">Installed Capacity (kW)</div>
                  </div>
                  <div className="bg-red-100 dark:bg-red-900 p-4 rounded-lg">
                    <div className="text-xl font-bold">{selectedNode.total_embodied_co2?.toFixed(2) || 0}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-300">Embodied CO₂ (kgCO₂e)</div>
                  </div>
                </div>
              </div>
            )}
            
            {selectedNode.type === 'building' && (
              <div className="mt-6">
                <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">KPIs</h4>
                <div className="grid grid-cols-1 gap-4">
                  <div className="bg-orange-100 dark:bg-orange-900 p-4 rounded-lg">
                    <div className="text-xl font-bold">{selectedNode.total_energy_demand?.toFixed(2) || 0}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-300">Energy Demand (kWh)</div>
                  </div>
                </div>
              </div>
            )}
            
            {selectedNode.type === 'battery' && (
              <div className="mt-6">
                <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">KPIs</h4>
                <div className="grid grid-cols-1 gap-4">
                  <div className="bg-blue-100 dark:bg-blue-900 p-4 rounded-lg">
                    <div className="text-xl font-bold">{selectedNode.capacity?.toFixed(2) || 0}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-300">Capacity (kWh)</div>
                  </div>
                  <div className="bg-red-100 dark:bg-red-900 p-4 rounded-lg">
                    <div className="text-xl font-bold">{selectedNode.total_embodied_co2?.toFixed(2) || 0}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-300">Embodied CO₂ (kgCO₂e)</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Add neon-glow pulse animation style with 3D depth enhancements
  // This style is injected only once
  useEffect(() => {
    if (!document.getElementById('neon-glow-style')) {
      const style = document.createElement('style');
      style.id = 'neon-glow-style';
      style.innerHTML = `
        .neon-glow {
          filter: none;
          animation: neon-pulse 2.2s infinite alternate;
        }
        @keyframes neon-pulse {
          0% { 
            filter: brightness(1.1) drop-shadow(0 0 16px #fff) drop-shadow(2px 4px 8px rgba(0,0,0,0.3)); 
            transform: translateZ(0);
          }
          50% { 
            filter: brightness(1.6) drop-shadow(0 0 32px #fff) drop-shadow(3px 6px 12px rgba(0,0,0,0.4)); 
            transform: translateZ(2px);
          }
          100% { 
            filter: brightness(1.1) drop-shadow(0 0 16px #fff) drop-shadow(2px 4px 8px rgba(0,0,0,0.3)); 
            transform: translateZ(0);
          }
        }
        
        /* Enhanced 3D hover effects for nodes */
        .node:hover .node-main {
          filter: brightness(1.2) drop-shadow(0 0 20px currentColor) drop-shadow(4px 8px 15px rgba(0,0,0,0.5));
          transform: translateZ(4px) scale(1.05);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .node:hover .node-aura {
          filter: brightness(1.3) drop-shadow(0 0 25px currentColor);
          transform: translateZ(2px) scale(1.1);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        /* Enhanced 3D link hover effects */
        .link:hover {
          filter: brightness(1.3) drop-shadow(0 0 8px currentColor) drop-shadow(1px 3px 6px rgba(0,0,0,0.4));
          stroke-width: 4;
          transform: translateZ(1px);
          transition: all 0.2s ease-out;
        }
        
        /* 3D particle effects */
        .particle {
          filter: drop-shadow(0 0 6px currentColor) drop-shadow(1px 2px 4px rgba(0,0,0,0.3));
          transform-style: preserve-3d;
        }
        
        /* Layered depth for different elements */
        .particles {
          transform: translateZ(5px);
        }
        
        .node {
          transform-style: preserve-3d;
        }
        
        .link {
          transform: translateZ(-1px);
        }
      `;
      document.head.appendChild(style);
    }
  }, []);

  return (
    <div className="w-full h-full relative">
      <svg
        ref={svgRef}
        className="w-full h-full bg-white dark:bg-gray-900 transition-colors duration-300"
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        preserveAspectRatio="xMidYMid meet"
      />
      {/* Add background overlay when panel is open */}
      <div 
        className={`fixed inset-0 bg-black dark:bg-gray-950 transition-opacity duration-300 ease-in-out ${
          selectedNode ? 'opacity-30 z-10' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setSelectedNode(null)}
      />
      {renderNodeDetailsPanel()}
    </div>
  );
};
