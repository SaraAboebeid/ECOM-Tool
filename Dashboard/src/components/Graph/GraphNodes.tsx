import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { GraphData, Node, NODE_COLORS, NODE_STROKE } from '../../types';
import { hasFixedPosition, getFixedPosition } from '../../utils/nodePositioning';

/**
 * Icon colour for a given node fill, chosen by contrast rather than fixed.
 *
 * Every fill in the neon palette fails against a white icon - the yellow at
 * 1.12:1 and the cyan at 1.28:1 are effectively invisible - while a dark ink
 * clears 4.5:1 on all of them and reaches 16:1 on the brightest. Computed so it
 * stays correct if the palette changes.
 */
const relativeLuminance = (hex: string): number => {
  const h = hex.replace('#', '').slice(0, 6);
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) =>
    v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const DARK_INK = '#0f172a';

const iconColorOn = (fill: string): string => {
  const contrast = (a: number, b: number) =>
    (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const bg = relativeLuminance(fill);
  return contrast(bg, relativeLuminance(DARK_INK)) >= contrast(bg, 1)
    ? DARK_INK
    : '#ffffff';
};

const getNodeRadius = (node: Node): number => {
  switch (node.type) {
    case 'grid':
      return 18;
    case 'charge_point':
      return 20;
    case 'battery':
      return 21;
    case 'pv':
      return 20;
    case 'building':
      return 22;
    default:
      return 20;
  }
};

const getNodePowerText = (node: Node): string => {
  switch (node.type) {
    case 'pv':
      return node.installed_capacity ? `${node.installed_capacity.toFixed(1)} kW` : '';
    case 'building':
      return node.total_pv_capacity ? `${node.total_pv_capacity.toFixed(1)} kW` : '';
    case 'battery':
      return node.capacity ? `${node.capacity.toFixed(1)} kWh` : '';
    case 'charge_point':
      return node.capacity ? `${node.capacity.toFixed(1)} kW` : '';
    default:
      return '';
  }
};

/** Chip geometry. Width is measured from the rendered text, not estimated. */
const LABEL_CHIP_HEIGHT = 18;
const LABEL_CHIP_PADDING_X = 9;
const LABEL_CHIP_MIN_WIDTH = 42;

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
      .attr('stroke', NODE_STROKE)
      .attr('stroke-width', '1.8')
      .attr('stroke-opacity', '0.92')
      .attr('opacity', (d: Node) => {
        // If this node has flow data for the current hour, make it fully opaque
        const hasFlow = data.links.some(link => {
          const isInvolved = link.source === d.id || link.target === d.id;
          const hasCurrentFlow = link.flow && Math.abs(link.flow[currentHour]) > 0;
          return isInvolved && hasCurrentFlow;
        });
        return hasFlow ? 1.0 : 0.55;
      })
      // No screen blend. It lightens towards the backdrop, so over the
      // near-white map every one of these fills came out white - grid
      // #00ffe5 rendered as #f5fffe, battery #fa3600 as #fff9fa. It only ever
      // worked while the canvas was dark.
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
      .attr('stroke', NODE_STROKE)
      .attr('stroke-width', '1.8')
      .attr('stroke-opacity', '0.95')
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

    nodeSelection
      .append('circle')
      .attr('class', 'node-energy-halo')
      .attr('r', (d: Node) => getNodeRadius(d) + 8)
      .attr('fill', 'none')
      .attr('stroke', '#7dd3fc')
      .attr('stroke-opacity', 0.22)
      .attr('stroke-width', 1.4)
      .style('pointer-events', 'none');

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
          .attr('dy', '-2px')
          .attr('fill', iconColorOn(NODE_COLORS[d.type] || '#6B7280'))
          .style('font-size', d.type === 'building' ? '24px' : '22px')
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

      // No abbreviation label here: the chip below already carries the full
      // name, and stacking both repeated it on every node.

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

    // The single label: full name in a chip sized to the text it holds.
    const labelChip = nodeSelection.append('g')
      .attr('class', 'node-label-chip')
      .attr('transform', 'translate(0,38)')
      .style('pointer-events', 'none');

    // Text goes in first so it can be measured; the chip is inserted behind it
    // afterwards. Estimating width from character count, as this did before,
    // truncated the longer names - 'CSB Gibraltarvallen guesthouse' needs about
    // 200px and the old estimate clamped every chip to 130.
    labelChip.append('text')
      .attr('class', 'node-label-text')
      .attr('text-anchor', 'middle')
      .attr('dy', '2px')
      .attr('fill', '#f8fafc')
      .attr('font-size', '10px')
      .attr('font-weight', '600')
      .style('font-family', 'Sora, system-ui, sans-serif')
      .style('user-select', 'none')
      .text((d: Node) => d.name || d.id);

    labelChip.each(function () {
      const group = d3.select(this);
      const textNode = group.select<SVGTextElement>('text.node-label-text').node();
      if (!textNode) return;

      let textWidth = 0;
      try {
        textWidth = textNode.getComputedTextLength();
      } catch {
        // getComputedTextLength throws if the element is not rendered yet.
        textWidth = (textNode.textContent || '').length * 6.1;
      }

      const chipWidth = Math.max(LABEL_CHIP_MIN_WIDTH, textWidth + LABEL_CHIP_PADDING_X * 2);
      group.insert('rect', 'text')
        .attr('x', -chipWidth / 2)
        .attr('y', -LABEL_CHIP_HEIGHT / 2)
        .attr('width', chipWidth)
        .attr('height', LABEL_CHIP_HEIGHT)
        .attr('rx', LABEL_CHIP_HEIGHT / 2)
        .attr('fill', 'rgba(15, 23, 42, 0.78)')
        .attr('stroke', 'rgba(148, 163, 184, 0.45)')
        .attr('stroke-width', 0.9);
    });

    // A second line only where there is a real measured value. The old code
    // fell back to the building_type, which put 'LargeOffice' under every
    // building name for no informational gain.
    nodeSelection.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '5.3em')
      .attr('fill', '#64748b')
      .attr('font-size', '9px')
      .attr('letter-spacing', '0.06em')
      .attr('class', 'node-metric')
      .style('pointer-events', 'none')
      .text((d: Node) => getNodePowerText(d));

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

      const nodeHalo = nodeElement.select('.node-energy-halo');
      if (!nodeHalo.empty()) {
        nodeHalo
          .attr('stroke-opacity', hasFlow ? 0.45 : 0.14)
          .attr('stroke-width', hasFlow ? 1.8 : 1.1);
      }
      
      // Update icon opacity if it exists
      const nodeIcon = nodeElement.select('.node-icon');
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
