import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { GraphData, Node, Link, NODE_COLORS } from '../../types';
import { iconToString } from '../NodeIcons';
import { hasFixedPosition, getFixedPosition } from '../../utils/nodePositioning';

const getNodeRadius = (node: Node): number => {
  switch (node.type) {
    case 'grid':
      return 16;
    case 'charge_point':
      return 18;
    case 'battery':
      return 19;
    case 'pv':
      return 18;
    case 'building':
      return 20;
    default:
      return 18;
  }
};

const hasBuildingPvPanels = (node: Node): boolean =>
  node.type === 'building' && !!node.total_pv_capacity && node.total_pv_capacity > 0;

interface GraphNodesProps {
  containerRef: React.RefObject<SVGGElement | null>;
  data: GraphData;
  currentHour: number;
  simulation: d3.Simulation<d3.SimulationNodeDatum, undefined> | null;
  selectedNode: Node | null;
  onNodeClick: (node: Node) => void;
  tooltip: {
    showTooltip: (html: string, event: MouseEvent) => void;
    hideTooltip: (delay?: number) => void;
    updateTooltipPosition: (event: MouseEvent) => void;
  };
}

/**
 * Component responsible for rendering graph nodes with full interactive features
 */
export const GraphNodes: React.FC<GraphNodesProps> = ({
  containerRef,
  data,
  currentHour,
  simulation,
  selectedNode,
  onNodeClick,
  tooltip
}) => {
  
  // Cache for parsed SVG icons to avoid re-parsing
  const iconCacheRef = useRef<Map<string, SVGElement>>(new Map());
  
  // Cache for node data to prevent unnecessary DOM updates
  const lastDataRef = useRef<string>('');
  
  // Create nodes when simulation or data changes
  useEffect(() => {
    if (!containerRef.current || !simulation || !data.nodes.length) return;

    const container = d3.select(containerRef.current);
    
    // Check if data actually changed to prevent unnecessary updates
    const currentDataKey = JSON.stringify(data.nodes.map(n => ({ id: n.id, type: n.type })));
    if (currentDataKey === lastDataRef.current && container.selectAll('.node').size() > 0) {
      // Even if structure hasn't changed, we need to ensure tick synchronization
      const existingNodes = container.selectAll('.node');
      const updateNodePositions = () => {
        existingNodes.attr('transform', (d: any) => `translate(${d.x || 0},${d.y || 0})`);
      };
      
      // Re-attach tick listener to ensure synchronization
      simulation.on('tick.nodes', updateNodePositions);
      updateNodePositions(); // Initial update
      return;
    }
    lastDataRef.current = currentDataKey;
    
    // Remove existing nodes
    container.selectAll('.node').remove();

    // Use the same node data from simulation to ensure consistency
    const nodeData = simulation.nodes() as Node[]; // Use simulation.nodes() directly for better sync

    // Drag functions that respect fixed positions
    const dragstarted = (event: any, d: any) => {
      // Don't allow dragging of nodes with fixed positions
      if (hasFixedPosition(d.id)) {
        // Change cursor to indicate non-draggable
        d3.select(event.sourceEvent.target.parentNode).style('cursor', 'not-allowed');
        return;
      }
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
      // Change cursor to indicate dragging
      d3.select(event.sourceEvent.target.parentNode).style('cursor', 'grabbing');
    };

    const dragged = (event: any, d: any) => {
      // Don't allow dragging of nodes with fixed positions
      if (hasFixedPosition(d.id)) {
        return;
      }
      d.fx = event.x;
      d.fy = event.y;
    };

    const dragended = (event: any, d: any) => {
      if (!event.active) simulation.alphaTarget(0);
      
      // Reset cursor based on node type
      const cursor = hasFixedPosition(d.id) ? 'pointer' : 'grab';
      d3.select(event.sourceEvent.target.parentNode).style('cursor', cursor);
      
      // Preserve fixed positions, only release non-fixed nodes
      if (!hasFixedPosition(d.id)) {
        d.fx = null;
        d.fy = null;
      } else {
        // Restore original fixed position if it was somehow changed
        const fixedPos = getFixedPosition(d.id);
        if (fixedPos) {
          d.fx = fixedPos.x;
          d.fy = fixedPos.y;
        }
      }
    };

    // Create node groups
    const nodeSelection = container.append('g')
      .attr('class', 'nodes-container')
      .selectAll('g')
      .data(nodeData as Node[])
      .enter().append('g')
      .attr('class', (d: Node) => `node node-${d.type}`)
      .style('cursor', d => hasFixedPosition(d.id) ? 'pointer' : 'grab')
      .on('click', (event: MouseEvent, d: Node) => {
        event.stopPropagation();
        onNodeClick(d);
      })
      .on('mouseover', function(this: SVGGElement, event: MouseEvent, d: Node) {
        // Don't show tooltip if panel is open
        if (selectedNode) return;
        
        const displayName = d.name || d.id;
        let tooltipContent = `<div class="font-semibold">${displayName}</div>`;
        tooltipContent += `<div>Type: ${d.type.replace('_', ' ')}</div>`;
        
        // Add type-specific information
        switch(d.type) {
          case 'building':
            if (d.total_energy_demand !== undefined) {
              tooltipContent += `<br/>Energy Demand: ${d.total_energy_demand.toFixed(2)} kWh/year`;
            }
            if (d.total_pv_capacity !== undefined && d.total_pv_capacity > 0) {
              tooltipContent += `<br/>PV Capacity: ${d.total_pv_capacity.toFixed(2)} kW`;
            }
            if (d.building_type) tooltipContent += `<br/>Building Type: ${d.building_type}`;
            if (d.owner) tooltipContent += `<br/>Owner: ${d.owner}`;
            break;
          
          case 'pv':
            if (d.installed_capacity !== undefined) {
              tooltipContent += `<br/>Capacity: ${d.installed_capacity.toFixed(2)} kW`;
            }
            if (d.annual_production !== undefined) {
              tooltipContent += `<br/>Annual Production: ${d.annual_production.toFixed(2)} kWh/year`;
            }
            if (d.total_embodied_co2 !== undefined) {
              tooltipContent += `<br/>Embodied CO₂: ${d.total_embodied_co2.toFixed(2)} kgCO₂e`;
            }
            if (d.owner) tooltipContent += `<br/>Owner: ${d.owner}`;
            break;
          
          case 'battery':
            if (d.capacity !== undefined) {
              tooltipContent += `<br/>Capacity: ${d.capacity.toFixed(2)} kWh`;
            }
            if (d.total_cost !== undefined) {
              tooltipContent += `<br/>Cost: ${d.total_cost.toFixed(2)} SEK`;
            }
            if (d.total_embodied_co2 !== undefined) {
              tooltipContent += `<br/>Embodied CO₂: ${d.total_embodied_co2.toFixed(2)} kgCO₂e`;
            }
            if (d.owner) tooltipContent += `<br/>Owner: ${d.owner}`;
            break;
          
          case 'charge_point':
            if (d.capacity !== undefined) {
              tooltipContent += `<br/>Capacity: ${d.capacity.toFixed(2)} kW`;
            }
            if (d.is_v2g !== undefined) {
              tooltipContent += `<br/>V2G Enabled: ${d.is_v2g ? 'Yes' : 'No'}`;
            }
            if (d.total_connected_evs) {
              tooltipContent += `<br/>Connected EVs: ${d.total_connected_evs}`;
            }
            if (d.owner) tooltipContent += `<br/>Owner: ${d.owner}`;
            break;
          
          case 'grid':
            // Grid-specific data if available
            break;
        }
        
        tooltip.showTooltip(tooltipContent, event);
      })
      .on('mousemove', (event: MouseEvent) => {
        tooltip.updateTooltipPosition(event);
      })
      .on('mouseout', () => {
        tooltip.hideTooltip();
      })
      .call(d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any);

    // Main node shapes
    nodeSelection.filter((d: Node) => d.type !== 'building')
      .append('circle')
      .attr('class', (d: Node) => `node-main node-main-${d.type}`)
      .attr('r', (d: Node) => getNodeRadius(d))
      .attr('fill', (d: Node) => NODE_COLORS[d.type])
      .attr('stroke', 'white')
      .attr('stroke-width', '1')
      .attr('stroke-opacity', '0.8')
      .attr('opacity', (d: Node) => {
        // If this node has flow data for the current hour, make it fully opaque
        const hasFlow = data.links.some(link => {
          const isInvolved = link.source === d.id || link.target === d.id;
          const hasCurrentFlow = link.flow && Math.abs(link.flow[currentHour]) > 0;
          return isInvolved && hasCurrentFlow;
        });
        return hasFlow ? 1.0 : 0.55;
      })
      .style('filter', (d: Node) => {
        // If this node has flow data for the current hour, add a glow effect
        const hasFlow = data.links.some(link => {
          const isInvolved = link.source === d.id || link.target === d.id;
          const hasCurrentFlow = link.flow && Math.abs(link.flow[currentHour]) > 0;
          return isInvolved && hasCurrentFlow;
        });
        return hasFlow 
          ? 'drop-shadow(0 0 6px rgba(255,255,255,0.32)) drop-shadow(1px 3px 5px rgba(0,0,0,0.28))' 
          : 'drop-shadow(1px 3px 5px rgba(0,0,0,0.28))';
      });

    nodeSelection.filter((d: Node) => d.type === 'building')
      .append('rect')
      .attr('class', 'node-main node-main-building')
      .attr('x', -20)
      .attr('y', -16)
      .attr('width', 40)
      .attr('height', 32)
      .attr('rx', 10)
      .attr('fill', NODE_COLORS.building)
      .attr('stroke', 'white')
      .attr('stroke-width', '1')
      .attr('stroke-opacity', '0.85')
      .attr('opacity', (d: Node) => {
        const hasFlow = data.links.some(link => {
          const isInvolved = link.source === d.id || link.target === d.id;
          const hasCurrentFlow = link.flow && Math.abs(link.flow[currentHour]) > 0;
          return isInvolved && hasCurrentFlow;
        });
        return hasFlow ? 1.0 : 0.55;
      })
      .style('filter', (d: Node) => {
        const hasFlow = data.links.some(link => {
          const isInvolved = link.source === d.id || link.target === d.id;
          const hasCurrentFlow = link.flow && Math.abs(link.flow[currentHour]) > 0;
          return isInvolved && hasCurrentFlow;
        });
        return hasFlow
          ? 'drop-shadow(0 0 6px rgba(255,255,255,0.32)) drop-shadow(1px 3px 5px rgba(0,0,0,0.28))'
          : 'drop-shadow(1px 3px 5px rgba(0,0,0,0.28))';
      });

    nodeSelection.filter((d: Node) => hasBuildingPvPanels(d))
      .append('rect')
      .attr('class', 'node-pv-badge')
      .attr('x', -12)
      .attr('y', -24)
      .attr('width', 24)
      .attr('height', 8)
      .attr('rx', 4)
      .attr('fill', NODE_COLORS.pv)
      .attr('stroke', 'white')
      .attr('stroke-width', '1')
      .attr('opacity', 0.95);

    // Add text icon labels inside nodes (direct text approach instead of SVG)
    nodeSelection.each(function(d: Node) {
      const node = d3.select(this);
      const nodeType = d.type;
      
      // Get icon name for this node type
      const iconName = (() => {
        switch(nodeType) {
          case 'building': return 'apartment';
          case 'pv': return 'wb_sunny';
          case 'grid': return 'grid_on';
          case 'battery': return 'battery_charging_full';
          case 'charge_point': return 'ev_station';
          default: return '';
        }
      })();
      
      if (iconName) {
        // Add a text element with Material Symbols icon
        node.append('text')
          .attr('class', 'material-symbols-outlined node-icon')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('dy', '-8px') // Position slightly above center
          .attr('fill', 'white')
          .style('font-size', d.type === 'building' ? '22px' : '20px')
          .style('pointer-events', 'none')
          .style('user-select', 'none')
          .text(iconName)
          .attr('opacity', () => {
            // Check if this node has any active energy flow
            const hasFlow = data.links.some(link => {
              const isInvolved = link.source === d.id || link.target === d.id;
              const hasCurrentFlow = link.flow && Math.abs(link.flow[currentHour]) > 0;
              return isInvolved && hasCurrentFlow;
            });
            return hasFlow ? 1.0 : 0.7; // Slightly fade icons for inactive nodes
          });
      }
      
      // Add text label inside the node
      node.append('text')
        .attr('class', 'node-inner-label')
        .attr('text-anchor', 'middle')
        .attr('dy', '18px')
        .attr('fill', 'white')
        .attr('font-size', '11px')
        .attr('font-weight', 'bold')
        .attr('pointer-events', 'none')
        .style('font-family', 'system-ui, -apple-system, sans-serif')
        .style('text-shadow', '0px 0px 2px rgba(0, 0, 0, 0.8)')
        .style('user-select', 'none')
        .text(() => {
          const label = d.name || d.id;
          return label.substring(0, 2);
        });
        
      // Add power value inside the node
      node.append('text')
        .attr('class', 'node-power-value')
        .attr('text-anchor', 'middle')
        .attr('dy', '31px')
        .attr('fill', 'white')
        .attr('font-size', '10px')
        .attr('font-weight', 'bold')
        .attr('pointer-events', 'none')
        .style('font-family', 'system-ui, -apple-system, sans-serif')
        .style('text-shadow', '0px 0px 2px rgba(0, 0, 0, 0.8)')
        .style('user-select', 'none')
        .text(() => {
          switch(d.type) {
            case 'pv':
              return d.installed_capacity ? `${d.installed_capacity.toFixed(1)} kW` : '';
            case 'building':
              return d.total_pv_capacity ? `${d.total_pv_capacity.toFixed(1)} kW` : '';
            case 'battery':
              return d.capacity ? `${d.capacity.toFixed(1)} kW` : '';
            case 'charge_point':
              return d.capacity ? `${d.capacity.toFixed(1)} kW` : '';
            default:
              return '';
          }
        });
      
      // Add feature indicators
      if (d.type === 'building' && d.total_pv_capacity && d.total_pv_capacity > 0) {
        node.append('circle')
          .attr('r', 8)
          .attr('cx', 25)
          .attr('cy', -25)
          .attr('fill', NODE_COLORS['pv']);
      }
      
      if (d.type === 'charge_point' && d.is_v2g) {
        node.append('circle')
          .attr('r', 8)
          .attr('cx', 25)
          .attr('cy', -25)
          .attr('fill', NODE_COLORS['grid']); // Use global color for grid indicator
      }
    });

    // Add labels below nodes
    nodeSelection.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '3.4em')
      .attr('fill', (d: Node) => {
        return d.type === 'pv' ? '#333' : '#fff';
      })
      .attr('font-size', '11px')
      .attr('font-weight', 'bold')
      .attr('class', 'node-label')
      .text((d: Node) => d.name || d.id);
      
    // Add type labels
    nodeSelection.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '4.8em')
      .attr('fill', '#fff')
      .attr('font-size', '9px')
      .attr('class', 'node-metric')
      .text((d: Node) => {
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

    // Update simulation node force with new data
    if (simulation) {
      simulation.nodes(nodeData as d3.SimulationNodeDatum[]);
      
      // Update node positions on simulation tick - use namespaced event
      simulation.on('tick.nodes', () => {
        nodeSelection.attr('transform', (d: any) => `translate(${d.x || 0},${d.y || 0})`);
      });
    }

    // Initial update with current hour styling - removed for performance
    // updateNodeStyling(nodeSelection, currentHour);

  }, [containerRef, simulation, data.nodes, data.links, selectedNode, onNodeClick, tooltip]);

  // Update node styling when the current hour changes
  useEffect(() => {
    if (!containerRef.current) return;

    const container = d3.select(containerRef.current);
    const nodeSelection = container.selectAll('.node');
    
    updateNodeStyling(nodeSelection, currentHour);

  }, [currentHour, containerRef, data.links]);

  // Helper function to update node styling based on current hour and energy flows
  const updateNodeStyling = (nodeSelection: d3.Selection<any, any, any, any>, hour: number) => {
    nodeSelection.each(function(d: any) {
      const nodeElement = d3.select(this);
      const nodeCircle = nodeElement.select('.node-main');
      const isBuilding = d.type === 'building';
      
      // Check if this node has any active energy flow at current hour
      const hasFlow = data.links.some(link => {
        const isInvolved = link.source === d.id || link.target === d.id;
        const hasCurrentFlow = link.flow && Math.abs(link.flow[hour]) > 0;
        return isInvolved && hasCurrentFlow;
      });
      
      // Update node circle
      if (isBuilding) {
        nodeCircle
          .attr('x', -20)
          .attr('y', -16)
          .attr('width', 40)
          .attr('height', 32)
          .attr('rx', 10)
          .attr('opacity', hasFlow ? 1.0 : 0.55)
          .style('filter', hasFlow 
            ? 'drop-shadow(0 0 6px rgba(255,255,255,0.32)) drop-shadow(1px 3px 5px rgba(0,0,0,0.28))' 
            : 'drop-shadow(1px 3px 5px rgba(0,0,0,0.28))');
      } else {
        nodeCircle
          .attr('r', getNodeRadius(d))
          .attr('opacity', hasFlow ? 1.0 : 0.55)
          .style('filter', hasFlow 
            ? 'drop-shadow(0 0 6px rgba(255,255,255,0.32)) drop-shadow(1px 3px 5px rgba(0,0,0,0.28))' 
            : 'drop-shadow(1px 3px 5px rgba(0,0,0,0.28))');
      }

      const nodeBadge = nodeElement.select('.node-pv-badge');
      if (!nodeBadge.empty()) {
        nodeBadge.attr('opacity', hasFlow ? 1.0 : 0.85);
      }
      
      // Update icon opacity if it exists
      const nodeIcon = nodeElement.select('svg');
      if (!nodeIcon.empty()) {
        nodeIcon.attr('opacity', hasFlow ? 1.0 : 0.7);
      }
      
      // Update text elements
      nodeElement.selectAll('text')
        .attr('opacity', hasFlow ? 1.0 : 0.7);
    });
  };

  return null; // This component renders directly to SVG via D3
};

export default GraphNodes;
