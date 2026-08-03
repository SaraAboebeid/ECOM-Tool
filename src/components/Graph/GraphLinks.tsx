import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { GraphData, NODE_COLORS } from '../../types';

// Flow visualization control constants
const FLOW_CONFIG = {
  // Width control
  MIN_WIDTH: 3,           // Minimum stroke width (px)
  MAX_WIDTH: 12,          // Maximum stroke width (px)
  
  // Opacity control
  MIN_OPACITY: 0.4,       // Minimum opacity
  MAX_OPACITY: 1.0,       // Maximum opacity
  
  // Flow normalization
  MAX_FLOW_VALUE: 20,     // Maximum flow value for normalization (kW)
  
  // Particle pattern (dash = gap for square particles)
  PARTICLE_SIZE: 5,       // Size of each particle (px)
  
  // Speed thresholds
  FAST_THRESHOLD: 3,      // Flow value for fast animation (kW)
  SLOW_THRESHOLD: 1,      // Flow value for slow animation (kW)
  
  // Hover effects
  HOVER_SCALE: 1.8,       // Scaling factor on hover
  HOVER_MIN_WIDTH: 8,     // Minimum width on hover (px)
} as const;

const getLinkKey = (link: any): string => {
  const sourceId = link.source?.id || link.source;
  const targetId = link.target?.id || link.target;
  return `${sourceId}->${targetId}`;
};

const hashString = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
};

const buildStructuredPath = (link: any): string => {
  const source = link.source;
  const target = link.target;

  if (!source || !target) return '';

  const sourceX = source.x || 0;
  const sourceY = source.y || 0;
  const targetX = target.x || 0;
  const targetY = target.y || 0;

  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const routeHash = hashString(getLinkKey(link));
  const bendOffset = 14 + (routeHash % 4) * 8;
  const horizontalFirst = Math.abs(dx) >= Math.abs(dy) || routeHash % 3 === 0;

  if (horizontalFirst) {
    const viaX = sourceX + dx * 0.5 + (routeHash % 2 === 0 ? bendOffset : -bendOffset);
    return `M ${sourceX} ${sourceY} L ${viaX} ${sourceY} L ${viaX} ${targetY} L ${targetX} ${targetY}`;
  }

  const viaY = sourceY + dy * 0.5 + (routeHash % 2 === 0 ? bendOffset : -bendOffset);
  return `M ${sourceX} ${sourceY} L ${sourceX} ${viaY} L ${targetX} ${viaY} L ${targetX} ${targetY}`;
};

interface GraphLinksProps {
  containerRef: React.RefObject<SVGGElement | null>;
  data: GraphData;
  currentHour: number;
  simulation: d3.Simulation<d3.SimulationNodeDatum, undefined> | null;
  isPlaying?: boolean;
  tooltip: {
    showTooltip: (html: string, event: MouseEvent) => void;
    hideTooltip: (delay?: number) => void;
    updateTooltipPosition: (event: MouseEvent) => void;
  };
}

/**
 * Component responsible for rendering graph links with energy flow visualization
 */
export const GraphLinks: React.FC<GraphLinksProps> = ({
  containerRef,
  data,
  currentHour,
  simulation,
  isPlaying = false,
  tooltip
}) => {
  const lastDataRef = useRef<string>('');

  useEffect(() => {
    if (!containerRef.current || !simulation || !data.links.length) return;

    const container = d3.select(containerRef.current);
    
    // Get both node and link data from simulation to ensure consistent references
    const linkForce = simulation.force('link') as d3.ForceLink<any, any>;
    const linkData = linkForce ? linkForce.links() : [];
    const nodeData = simulation.nodes() as any[]; // Use simulation.nodes() instead of cached data
    
    // Check if data actually changed to prevent unnecessary updates
    const currentDataKey = JSON.stringify(data.links.map(l => ({ source: l.source, target: l.target })));
    if (currentDataKey === lastDataRef.current && container.selectAll('.link').size() > 0) {
      // Even if structure hasn't changed, we still need to update the visual properties
      // for the current hour and update the tick function
      const existingBackgroundLinks = container.selectAll('.background-link');
      const existingLinks = container.selectAll('.link');
      
      // Update visual properties for the animated flow lines
      existingLinks
        .attr('stroke-opacity', (d: any) => {
          const flowValue = d.flow && d.flow[currentHour] ? Math.abs(d.flow[currentHour]) : 0;
          if (flowValue === 0) return 0;
          // Use opacity to show flow intensity
          const normalizedFlow = Math.min(flowValue / FLOW_CONFIG.MAX_FLOW_VALUE, 1);
          return FLOW_CONFIG.MIN_OPACITY + (normalizedFlow * (FLOW_CONFIG.MAX_OPACITY - FLOW_CONFIG.MIN_OPACITY));
        })
        .attr('stroke-width', (d: any) => {
          const flowValue = d.flow && d.flow[currentHour] ? Math.abs(d.flow[currentHour]) : 0;
          if (flowValue === 0) return 0;
          // Dynamic width based on flow intensity
          const normalizedFlow = Math.min(flowValue / FLOW_CONFIG.MAX_FLOW_VALUE, 1);
          return FLOW_CONFIG.MIN_WIDTH + (normalizedFlow * (FLOW_CONFIG.MAX_WIDTH - FLOW_CONFIG.MIN_WIDTH));
        })
        .attr('stroke', (d: any) => {
          const flowValue = d.flow && d.flow[currentHour] ? Math.abs(d.flow[currentHour]) : 0;
          if (flowValue === 0) return '#999';
          
          // Color based on source node type
          const sourceNode = nodeData.find(n => n.id === (d.source.id || d.source));
          if (!sourceNode) return '#999';
          
          // Use the global NODE_COLORS for consistency
          return NODE_COLORS[sourceNode.type] || '#6B7280';
        })
        .attr('class', (d: any) => {
          const flowValue = d.flow && d.flow[currentHour] ? d.flow[currentHour] : 0;
          if (Math.abs(flowValue) === 0) return 'link';
          
          // Determine animation speed based on flow intensity using config constants
          const absFlow = Math.abs(flowValue);
          let speedClass = '';
          if (absFlow > FLOW_CONFIG.FAST_THRESHOLD) speedClass = '-fast';
          else if (absFlow > FLOW_CONFIG.SLOW_THRESHOLD) speedClass = '';
          else speedClass = '-slow';
          
          // Add animation class based on flow direction and speed
          return flowValue > 0 ? `link link-flow${speedClass}` : `link link-flow-reverse${speedClass}`;
        })
        .style('cursor', (d: any) => {
          const flowValue = d.flow && d.flow[currentHour] ? Math.abs(d.flow[currentHour]) : 0;
          return flowValue > 0 ? 'pointer' : 'default';
        });
      
      const updateLinkPositions = () => {
        // Update animated particle lines
        existingLinks
          .attr('d', buildStructuredPath);
        
        // Update solid background lines
        existingBackgroundLinks
            .attr('d', buildStructuredPath);
      };
      
      // Re-attach tick listener to ensure synchronization
      simulation.on('tick.links', updateLinkPositions);
      updateLinkPositions(); // Initial update
      return;
    }
    lastDataRef.current = currentDataKey;

    // Remove existing links
    container.selectAll('.links-container').remove();

    // Create links container
    const linksContainer = container.append('g')
      .attr('class', 'links-container');

    // Create background solid lines (always visible)
    const backgroundLinks = linksContainer
      .selectAll('.background-link')
      .data(linkData)
      .enter().append('path')
      .attr('class', 'background-link')
      .attr('fill', 'none')
      .attr('stroke', '#777')
      .attr('stroke-opacity', 0.1)
      .attr('stroke-width', 1);
      
    // Create animated particle lines on top for showing energy flow
    const linkSelection = linksContainer
      .selectAll('.link')
      .data(linkData)
      .enter().append('path')
      .attr('fill', 'none')
      .attr('stroke-dasharray', `${FLOW_CONFIG.PARTICLE_SIZE} ${FLOW_CONFIG.PARTICLE_SIZE}`) // Equal dash and gap for square particles
      .attr('stroke-opacity', d => {
        const flowValue = d.flow && d.flow[currentHour] ? Math.abs(d.flow[currentHour]) : 0;
        if (flowValue === 0) return 0;
        // Use opacity to show flow intensity
        const normalizedFlow = Math.min(flowValue / FLOW_CONFIG.MAX_FLOW_VALUE, 1);
        return FLOW_CONFIG.MIN_OPACITY + (normalizedFlow * (FLOW_CONFIG.MAX_OPACITY - FLOW_CONFIG.MIN_OPACITY));
      })
      .attr('stroke-width', d => {
        const flowValue = d.flow && d.flow[currentHour] ? Math.abs(d.flow[currentHour]) : 0;
        if (flowValue === 0) return 0;
        // Dynamic width based on flow intensity
        const normalizedFlow = Math.min(flowValue / FLOW_CONFIG.MAX_FLOW_VALUE, 1);
        return FLOW_CONFIG.MIN_WIDTH + (normalizedFlow * (FLOW_CONFIG.MAX_WIDTH - FLOW_CONFIG.MIN_WIDTH));
      })
      .attr('stroke', d => {
        const flowValue = d.flow && d.flow[currentHour] ? Math.abs(d.flow[currentHour]) : 0;
        if (flowValue === 0) return '#999';
        
        // Color based on source node type
        const sourceNode = nodeData.find(n => n.id === (d.source.id || d.source));
        if (!sourceNode) return '#999';
        
        // Use the global NODE_COLORS for consistency
        return NODE_COLORS[sourceNode.type] || '#6B7280';
      })
      .attr('class', d => {
        const flowValue = d.flow && d.flow[currentHour] ? d.flow[currentHour] : 0;
        if (Math.abs(flowValue) === 0) return 'link';
        
        // Determine animation speed based on flow intensity using config constants
        const absFlow = Math.abs(flowValue);
        let speedClass = '';
        if (absFlow > FLOW_CONFIG.FAST_THRESHOLD) speedClass = '-fast';
        else if (absFlow > FLOW_CONFIG.SLOW_THRESHOLD) speedClass = '';
        else speedClass = '-slow';
        
        // Add animation class based on flow direction and speed
        return flowValue > 0 ? `link link-flow${speedClass}` : `link link-flow-reverse${speedClass}`;
      })
      .style('cursor', d => {
        // Only show pointer cursor for links with energy flow
        const flowValue = d.flow && d.flow[currentHour] ? Math.abs(d.flow[currentHour]) : 0;
        return flowValue > 0 ? 'pointer' : 'default';
      })
      .on('mouseover', function(this: SVGLineElement, event: MouseEvent, d: any) {
        // Only show tooltip for links with energy flow
        const flowValue = d.flow && d.flow[currentHour] ? Math.abs(d.flow[currentHour]) : 0;
        if (flowValue === 0) return;
        
        // Enhanced hover effect with configurable scaling
        d3.select(this)
          .attr('stroke-width', Math.max(FLOW_CONFIG.HOVER_MIN_WIDTH, parseInt(d3.select(this).attr('stroke-width')) * FLOW_CONFIG.HOVER_SCALE))
          .style('filter', 'brightness(1.4) drop-shadow(0 0 12px currentColor)');
        
        // Show link tooltip - use nodeData from simulation for consistent references
        const sourceNode = nodeData.find(n => n.id === (d.source.id || d.source));
        const targetNode = nodeData.find(n => n.id === (d.target.id || d.target));
        
        if (sourceNode && targetNode) {
          let tooltipContent = `<div class="font-semibold">Energy Flow</div>`;
          tooltipContent += `<div>From: ${sourceNode.name || sourceNode.id}</div>`;
          tooltipContent += `<div>To: ${targetNode.name || targetNode.id}</div>`;
          if (d.flow && d.flow[currentHour] !== undefined) {
            tooltipContent += `<div>Flow: ${d.flow[currentHour].toFixed(2)} kW</div>`;
          }
          
          // Add energy source type
          const sourceTypeLabel = {
            'grid': 'Grid Energy',
            'pv': 'Solar Energy',
            'battery': 'Battery Energy',
            'building': 'Building Energy',
            'charge_point': 'Charging Energy'
          }[sourceNode.type] || 'Energy';
          tooltipContent += `<div class="text-sm text-gray-500">Source: ${sourceTypeLabel}</div>`;
          
          tooltip.showTooltip(tooltipContent, event);
        }
      })
      .on('mousemove', (event: MouseEvent) => {
        tooltip.updateTooltipPosition(event);
      })
      .on('mouseout', function(this: SVGPathElement) {
        // Reset hover styling using current hour's flow value
        const linkDatum = d3.select(this).datum() as any;
        const flowValue = linkDatum?.flow?.[currentHour] || 0;
        let originalWidth = 0;
        if (Math.abs(flowValue) > 0) {
          const normalizedFlow = Math.min(Math.abs(flowValue) / FLOW_CONFIG.MAX_FLOW_VALUE, 1);
          originalWidth = FLOW_CONFIG.MIN_WIDTH + (normalizedFlow * (FLOW_CONFIG.MAX_WIDTH - FLOW_CONFIG.MIN_WIDTH));
        }
        
        d3.select(this)
          .attr('stroke-width', originalWidth)
          .style('filter', null);
          
        tooltip.hideTooltip();
      });

    // Update link positions on simulation tick
    const updateLinkPositions = () => {
      // Update animated particle lines
      linkSelection
        .attr('d', buildStructuredPath);
      
      // Update solid background lines  
      backgroundLinks
        .attr('d', buildStructuredPath);
    };

    // Listen to simulation ticks - use namespaced event to avoid conflicts
    simulation.on('tick.links', updateLinkPositions);

    // Initial position update
    updateLinkPositions();

  }, [containerRef, simulation, data.links, data.nodes, tooltip, currentHour]);

  return null; // This component renders directly to SVG via D3
};

export default GraphLinks;
