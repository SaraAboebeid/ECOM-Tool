import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { GraphData } from '../types';
import { NODE_COLORS } from '../types';

interface SankeyDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  data: GraphData;
  currentHour: number;
  isDarkMode: boolean;
}

interface FlowCategory {
  name: string;
  type: string;
  incoming: number;
  outgoing: number;
}

interface SankeyNode {
  id: string;
  name: string;
  type: string;
  value: number;
  x?: number;
  y?: number;
}

interface SankeyLink {
  source: string;
  target: string;
  value: number;
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
}

/**
 * Drawer component that displays energy flows for the current hour
 */
export const SankeyDrawer: React.FC<SankeyDrawerProps> = ({ isOpen, onClose, data, currentHour, isDarkMode }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  
  // Log state changes for debugging
  useEffect(() => {
    console.log(`SankeyDrawer isOpen state changed to: ${isOpen ? 'OPEN' : 'CLOSED'}`);
    
    // Show an alert only during development to verify the component is working
    if (isOpen) {
      console.log('%c Sankey Drawer is now OPEN ', 'background: #4CAF50; color: white; padding: 4px;');
    } else {
      console.log('%c Sankey Drawer is now CLOSED ', 'background: #F44336; color: white; padding: 4px;');
    }
  }, [isOpen]);

  // Update dimensions when window resizes or fullscreen changes
  useEffect(() => {
    const updateDimensions = () => {
      // Make sure we have a parent element to measure
      if (!svgRef.current || !svgRef.current.parentElement) return;
      
      // Use the parent container dimensions so the SVG fits the visible drawer area
      const { width, height } = svgRef.current.parentElement.getBoundingClientRect();
      setDimensions({ width, height });
    };

    // Set up the resize listener
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    
    // Check dimensions again after a short delay (for DOM to settle)
    const timeoutId = setTimeout(updateDimensions, 100);
    
    return () => {
      window.removeEventListener('resize', updateDimensions);
      clearTimeout(timeoutId);
    };
  }, [isOpen, isFullscreen]);
  
  // Add resize functionality
  useEffect(() => {
    if (!resizeHandleRef.current) return;
    
    const resizeHandle = resizeHandleRef.current;
    
    const handleMouseDown = (e: MouseEvent) => {
      if (isFullscreen) return; // Don't allow resizing in fullscreen mode
      
      setIsResizing(true);
      const startY = e.clientY;
      const startHeight = dimensions.height;
      
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaY = startY - moveEvent.clientY;
        const newHeight = Math.max(150, Math.min(window.innerHeight * 0.8, startHeight + deltaY));
        setDimensions(prev => ({ ...prev, height: newHeight }));
      };
      
      const handleMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
      
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    };
    
    resizeHandle.addEventListener('mousedown', handleMouseDown);
    
    return () => {
      resizeHandle.removeEventListener('mousedown', handleMouseDown);
    };
  }, [dimensions.height, isFullscreen]);

  // Process data for flow diagram (for bar charts)
  const processFlowData = (): FlowCategory[] => {
    if (!data || !data.nodes || !data.links) {
      return [];
    }

    // Create flow categories
    const categories = new Map<string, FlowCategory>();
    
    // Initialize categories
    ['pv', 'building', 'grid', 'battery', 'charge_point'].forEach(type => {
      categories.set(type, {
        name: type.charAt(0).toUpperCase() + type.slice(1),
        type,
        incoming: 0,
        outgoing: 0
      });
    });

    // Process links for the current hour
    data.links.forEach(link => {
      if (!link.flow || !Array.isArray(link.flow) || link.flow.length <= currentHour) {
        return;
      }

      const flowValue = link.flow[currentHour];
      if (flowValue === 0) {
        return; // Skip zero flows
      }

      const sourceNode = data.nodes.find(n => n.id === link.source);
      const targetNode = data.nodes.find(n => n.id === link.target);

      if (!sourceNode || !targetNode) {
        return;
      }

      const sourceType = sourceNode.type;
      const targetType = targetNode.type;

      // Update outgoing flow for source category
      const sourceCategory = categories.get(sourceType);
      if (sourceCategory && flowValue > 0) {
        sourceCategory.outgoing += flowValue;
      }

      // Update incoming flow for target category
      const targetCategory = categories.get(targetType);
      if (targetCategory && flowValue > 0) {
        targetCategory.incoming += flowValue;
      }
    });

    // Return as array
    return Array.from(categories.values());
  };
  
  // Process data for Sankey diagram with all individual entities
  const processSankeyData = (): { nodes: SankeyNode[], links: SankeyLink[] } => {
    if (!data || !data.nodes || !data.links) {
      return { nodes: [], links: [] };
    }
    
    const nodeTypes = ['pv', 'battery', 'building', 'grid', 'charge_point'];
    const typeOrder: Record<string, number> = {};
    nodeTypes.forEach((type, index) => {
      typeOrder[type] = index;
    });
    
    // Create map of individual nodes
    const nodesMap = new Map<string, SankeyNode>();
    
    // Filter for significant links only
    const significantLinks: SankeyLink[] = [];
    
    // Process all links for the current hour
    data.links.forEach(link => {
      if (!link.flow || !Array.isArray(link.flow) || link.flow.length <= currentHour) {
        return;
      }

      const flowValue = link.flow[currentHour];
      if (flowValue <= 0) {
        return; // Skip zero or negative flows
      }

      const sourceNode = data.nodes.find(n => n.id === link.source);
      const targetNode = data.nodes.find(n => n.id === link.target);

      if (!sourceNode || !targetNode) {
        return;
      }
      
      // Create source node if it doesn't exist
      if (!nodesMap.has(sourceNode.id)) {
        nodesMap.set(sourceNode.id, {
          id: sourceNode.id,
          name: sourceNode.name || sourceNode.id,
          type: sourceNode.type,
          value: 0
        });
      }
      
      // Create target node if it doesn't exist
      if (!nodesMap.has(targetNode.id)) {
        nodesMap.set(targetNode.id, {
          id: targetNode.id,
          name: targetNode.name || targetNode.id,
          type: targetNode.type,
          value: 0
        });
      }
      
      // Add flow value to both nodes
      const sankeySource = nodesMap.get(sourceNode.id)!;
      const sankeyTarget = nodesMap.get(targetNode.id)!;
      
      sankeySource.value += flowValue;
      sankeyTarget.value += flowValue;
      
      // Create link
      significantLinks.push({
        source: sourceNode.id,
        target: targetNode.id,
        value: flowValue
      });
    });
    
    // Convert nodes map to array
    let nodes = Array.from(nodesMap.values());
    
    // Sort nodes by type then by value for positioning
    nodes.sort((a, b) => {
      const typeComparison = (typeOrder[a.type] || 0) - (typeOrder[b.type] || 0);
      if (typeComparison !== 0) return typeComparison;
      // If same type, sort by value (descending)
      return b.value - a.value;
    });
    
    // Limit to top X nodes if there are too many
    const MAX_NODES = 20; // Maximum number of nodes to display
    if (nodes.length > MAX_NODES) {
      // Keep the most significant nodes by energy flow value
      nodes.sort((a, b) => b.value - a.value);
      nodes = nodes.slice(0, MAX_NODES);
      
      // Keep only links between these nodes
      const nodeIds = new Set(nodes.map(n => n.id));
      const filteredLinks = significantLinks.filter(
        link => nodeIds.has(link.source) && nodeIds.has(link.target)
      );
      
      return {
        nodes,
        links: filteredLinks
      };
    }
    
    return {
      nodes,
      links: significantLinks
    };
  };

  // Draw Sankey diagram
  useEffect(() => {
    // Debug logging to track rendering
    console.log('Draw effect triggered. isOpen:', isOpen, 'dimensions:', dimensions);
    
    // If the drawer isn't open, we can skip the rest
    if (!isOpen) {
      return;
    }
    
    // Safety check for SVG ref
    if (!svgRef.current) {
      console.warn('SVG ref is not available');
      return;
    }
    
    // Force reasonable dimensions if needed
    if (dimensions.width === 0 || dimensions.height === 0) {
      console.log('Forcing dimensions because current dimensions are zero');
      // Measure parent if available, otherwise use fallback values
      const parentWidth = svgRef.current.parentElement?.clientWidth || window.innerWidth;
      const height = isFullscreen ? window.innerHeight - 150 : 350;
      setDimensions({ width: parentWidth, height });
      return; // Will re-run when dimensions are updated
    }

    // Clear previous diagram
    d3.select(svgRef.current).selectAll('*').remove();

    const margin = { top: 20, right: 30, bottom: 10, left: 30 };
    const width = dimensions.width - margin.left - margin.right;
    const height = dimensions.height - margin.top - margin.bottom;

    // Process data for Sankey diagram
    const sankeyData = processSankeyData();
    
    if (sankeyData.nodes.length === 0 || sankeyData.links.length === 0) {
      // No data to display
      const svg = d3.select(svgRef.current);
      svg.append('text')
        .attr('x', dimensions.width / 2)
        .attr('y', dimensions.height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', isDarkMode ? '#e5e7eb' : '#374151')
        .text('No energy flows for this hour');
      return;
    }

    // Create SVG
    const svg = d3.select(svgRef.current)
      .attr('width', dimensions.width)
      .attr('height', dimensions.height)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Define node layout parameters (more compact)
    const nodeWidth = isFullscreen ? 72 : 54;
    const nodeMargin = 8;
    // Decide column order dynamically: keep PV and GRID on same (left) side unless building exports to grid this hour
    const hasBuildingToGridExport = data.links?.some(link => {
      if (!link.flow || !Array.isArray(link.flow) || link.flow.length <= currentHour) return false;
      const v = link.flow[currentHour];
      if (v <= 0) return false;
      const src = data.nodes.find(n => n.id === link.source);
      const tgt = data.nodes.find(n => n.id === link.target);
      return src?.type === 'building' && tgt?.type === 'grid';
    }) || false;

    const nodeTypesOrdered = hasBuildingToGridExport
      ? ['pv', 'battery', 'building', 'charge_point', 'grid'] // grid on right if exporting
      : ['grid', 'pv', 'building', 'charge_point', 'battery']; // grid left with PV when importing only

    // Group nodes by type
    const nodesByType: Record<string, SankeyNode[]> = {};
    for (const node of sankeyData.nodes) {
      if (!nodesByType[node.type]) nodesByType[node.type] = [];
      nodesByType[node.type].push(node);
    }

    // Sort nodes within each type by value
    Object.values(nodesByType).forEach(arr => {
      (arr as SankeyNode[]).sort((a, b) => b.value - a.value);
    });
    
    // Calculate column positions for each type
    const totalWidth = width - (isFullscreen ? 160 : 120); // More margin in fullscreen
    const presentTypes = nodeTypesOrdered.filter(type => nodesByType[type] && nodesByType[type].length > 0);
    const count = presentTypes.length;

    // Column positions for each type (sorted by preferred order)
    const typePositions: Record<string, number> = {};
    presentTypes.forEach((type, i) => {
      typePositions[type] = (i * totalWidth / Math.max(1, count - 1)) + (isFullscreen ? 80 : 60);
    });
    
    // Position nodes within their type columns
    Object.entries(nodesByType).forEach(([type, list]) => {
      if (typePositions[type] === undefined) return; // Type not displayed this hour
      const xPos = typePositions[type];
      const nodesArr = list as SankeyNode[];
      const totalNodesInColumn = nodesArr.length;
      
      // Calculate vertical spacing - compact to keep everything visible
      const totalHeight = height - (isFullscreen ? 120 : 100);
      const maxSpacing = isFullscreen ? 160 : 100; // tighter spacing
      const available = totalHeight / Math.max(1, totalNodesInColumn + 1);
      const verticalSpacing = Math.min(maxSpacing, available);
      const startY = (isFullscreen ? 60 : 50) + (totalHeight - ((totalNodesInColumn - 1) * verticalSpacing)) / 2;
      
      nodesArr.forEach((node, i) => {
        node.x = xPos;
        node.y = startY + (i * verticalSpacing);
      });
    });

    // Calculate the maximum link value for scaling
    const maxLinkValue = d3.max(sankeyData.links, d => d.value) || 1;
    
    // Scale for link thickness - more compact
    const linkWidthScale = d3.scaleLinear()
      .domain([0, maxLinkValue])
      .range([1, 12]); // Min and max link widths

    // Calculate link positions
    sankeyData.links.forEach(link => {
      const sourceNode = sankeyData.nodes.find(n => n.id === link.source);
      const targetNode = sankeyData.nodes.find(n => n.id === link.target);
      
      if (sourceNode && targetNode) {
        link.sourceX = sourceNode.x! + nodeWidth / 2;
        link.sourceY = sourceNode.y!;
        link.targetX = targetNode.x! - nodeWidth / 2;
        link.targetY = targetNode.y!;
      }
    });

    // Draw links as bezier curves
    svg.selectAll('.link')
      .data(sankeyData.links)
      .enter()
      .append('path')
      .attr('class', 'link')
      .attr('d', d => {
        const curvature = 0.5;
        const x0 = d.sourceX!;
        const y0 = d.sourceY!;
        const x1 = d.targetX!;
        const y1 = d.targetY!;
        const xi = d3.interpolateNumber(x0, x1);
        const x2 = xi(curvature);
        const x3 = xi(1 - curvature);
        
        return `M${x0},${y0} C${x2},${y0} ${x3},${y1} ${x1},${y1}`;
      })
      .attr('stroke', d => {
        const sourceNode = sankeyData.nodes.find(n => n.id === d.source);
        return sourceNode ? NODE_COLORS[sourceNode.type] || '#aaa' : '#aaa';
      })
      .attr('stroke-width', d => linkWidthScale(d.value))
      .attr('fill', 'none')
      .attr('opacity', 0.7)
      .on('mouseover', function(event, d: SankeyLink) {
        d3.select(this)
          .attr('opacity', 1)
          .attr('stroke-width', linkWidthScale(d.value) * 1.2);
      })
      .on('mouseout', function(event, d: SankeyLink) {
        d3.select(this)
          .attr('opacity', 0.7)
          .attr('stroke-width', linkWidthScale(d.value));
      })
      .append('title')
      .text(d => {
        const sourceNode = sankeyData.nodes.find(n => n.id === d.source);
        const targetNode = sankeyData.nodes.find(n => n.id === d.target);
        return `${sourceNode?.name || d.source} → ${targetNode?.name || d.target}: ${d.value.toFixed(2)} kWh`;
      });

    // Calculate node height based on value but with compact constraints
    const getNodeHeight = (value: number) => {
      return Math.max(14, Math.min(28, value / maxLinkValue * 42));
    };

    // Draw nodes as rectangles with icons
    const nodeGroups = svg.selectAll('.node')
      .data(sankeyData.nodes)
      .enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', d => `translate(${d.x! - nodeWidth / 2}, ${d.y! - getNodeHeight(d.value) / 2})`)
      .on('mouseover', function(event, d: SankeyNode) {
        // Highlight this node and connected links
        d3.select(this).select('rect')
          .attr('stroke', '#ffffff')
          .attr('stroke-width', 2);
          
        // Highlight links connected to this node
        svg.selectAll<SVGPathElement, SankeyLink>('.link')
          .filter(link => link.source === d.id || link.target === d.id)
          .attr('opacity', 1)
          .attr('stroke-width', link => linkWidthScale(link.value) * 1.5);
          
        // Show all values for connected links
        svg.selectAll<SVGTextElement, unknown>('.flow-value')
          .filter(function() {
            const dataAttr = this.getAttribute('data-link') || '';
            return dataAttr.includes(`source-${d.id}`) || dataAttr.includes(`target-${d.id}`);
          })
          .style('opacity', 1);
      })
      .on('mouseout', function() {
        // Reset node highlight
        d3.select(this).select('rect')
          .attr('stroke', 'none');
          
        // Reset all links
        svg.selectAll<SVGPathElement, SankeyLink>('.link')
          .attr('opacity', 0.7)
          .attr('stroke-width', link => linkWidthScale(link.value));
          
        // Hide flow values
        svg.selectAll('.flow-value')
          .style('opacity', 0);
      });

    // Add node rectangles
    nodeGroups.append('rect')
      .attr('width', nodeWidth)
      .attr('height', d => getNodeHeight(d.value))
      .attr('fill', d => NODE_COLORS[d.type] || '#aaa')
      .attr('opacity', 0.9)
      .attr('rx', 5) // More rounded corners
      .append('title')
      .text(d => `${d.name}: ${d.value.toFixed(2)} kWh`);
      
    // Add node type indicators (small dots with different colors)
    nodeGroups.each(function(this: SVGGElement, d: SankeyNode) {
      const g = d3.select(this);
      // Move the dot to the top-left to avoid overlapping centered labels
      g.append('circle')
        .attr('cx', 8)
        .attr('cy', 8)
        .attr('r', 3)
        .attr('fill', (d: any) => {
          return NODE_COLORS[d.type] || '#aaaaaa';
        });
    });

    // Add abbreviated node labels (inside rectangle, top)
    nodeGroups.append('text')
      .attr('x', nodeWidth / 2)
      .attr('y', 3)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('fill', '#ffffff')
      .attr('font-size', isFullscreen ? '10px' : '8px')
      .attr('font-weight', 'bold')
      .style('pointer-events', 'none')
      .style('display', d => getNodeHeight(d.value) >= 16 ? 'block' : 'none')
      .text(d => {
        const maxLength = isFullscreen ? 12 : 9;
        if (d.name.length <= maxLength) return d.name;
        const words = d.name.split(/\s+/);
        if (words.length > 1) {
          const firstWord = words[0];
          if (firstWord.length <= maxLength - 2) {
            return firstWord + ' ' + words[1][0];
          }
          return firstWord.substring(0, maxLength - 2) + '..';
        }
        return d.name.substring(0, maxLength) + '..';
      })
      .append('title')
      .text(d => d.name);

    // Add compact node values (inside rectangle, bottom)
    nodeGroups.append('text')
      .attr('x', nodeWidth / 2)
      .attr('y', d => Math.max(10, getNodeHeight(d.value) - 3))
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'ideographic')
      .attr('fill', 'white')
      .attr('font-size', '8px')
      .attr('font-weight', 'bold')
      .text(d => {
        if (d.value < 1) return d.value.toFixed(1);
        if (d.value < 10) return Math.round(d.value).toString();
        if (d.value < 1000) return Math.round(d.value).toString();
        return (d.value / 1000).toFixed(1) + 'k';
      });
      
    // Add compact flow values to links that appear on hover
    svg.selectAll<SVGPathElement, SankeyLink>('.link').each(function(d) {
      const path = d3.select(this);
      const pathNode = this;
      if (pathNode && pathNode.getTotalLength) {
        const midpoint = pathNode.getPointAtLength(pathNode.getTotalLength() / 2);
        
        svg.append('text')
          .attr('class', 'flow-value')
          .attr('data-link', `source-${d.source}-target-${d.target}`) // Add data attribute for filtering
          .attr('x', midpoint.x)
          .attr('y', midpoint.y - 5)
          .attr('text-anchor', 'middle')
          .attr('fill', isDarkMode ? '#e5e7eb' : '#374151')
          .attr('font-size', '8px')
          .attr('font-weight', 'bold')
          .attr('pointer-events', 'none')
          .attr('stroke', isDarkMode ? '#1f2937' : '#ffffff')
          .attr('stroke-width', 2)
          .attr('paint-order', 'stroke')
          .style('opacity', 0)
          .text(d.value < 1000 ? `${d.value.toFixed(0)}` : `${(d.value/1000).toFixed(1)}k`);
      }
    });

    // Add hour label
    svg.append('text')
      .attr('x', width)
      .attr('y', height - (isFullscreen ? 30 : 20)) // More space from bottom in fullscreen
      .attr('text-anchor', 'end')
      .attr('fill', isDarkMode ? '#e5e7eb' : '#374151')
      .attr('font-size', '14px')
      .text(`Hour: ${currentHour}`);

    // Add title
    svg.append('text')
      .attr('x', width / 2)
      .attr('y', 0)
      .attr('text-anchor', 'middle')
      .attr('font-size', '12px')
      .attr('font-weight', 'bold')
      .attr('fill', isDarkMode ? '#e5e7eb' : '#374151')
      .text('Energy Flow Between Individual Entities');

  }, [isOpen, dimensions, data, currentHour, isDarkMode, isFullscreen]);

  const toggleFullscreen = () => {
    // Simply toggle the state - dimensions are recalculated in the useEffect
    setIsFullscreen(prev => !prev);
  };

  // Always render the component but control visibility with CSS
  return (
    <div 
      className={`flow-drawer fixed left-0 right-0 bg-white dark:bg-gray-800 shadow-lg transition-all duration-300 ease-in-out ${
        isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full pointer-events-none'
      } z-30`}
      style={{ 
        // Height respects fullscreen but never covers the timeline area
        height: isFullscreen ? 'calc(100vh - var(--timeline-height, 96px) - 24px)' : '400px', 
        maxHeight: isFullscreen ? 'calc(100vh - var(--timeline-height, 96px) - 24px)' : '60vh',
        // Sit just above the timeline by using its actual height exposed via CSS var
        bottom: 'calc(var(--timeline-height, 96px) + 8px)',
        boxShadow: '0 -4px 6px -1px rgba(0, 0, 0, 0.1), 0 -2px 4px -1px rgba(0, 0, 0, 0.06)'
      }}
    >
      {/* Resize handle */}
      <div 
        ref={resizeHandleRef}
        className={`absolute top-0 left-0 right-0 h-2 cursor-row-resize flex justify-center items-center bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 ${isResizing ? 'bg-blue-300 dark:bg-blue-800' : ''}`}
        title="Drag to resize">
        <div className="w-16 h-1 bg-gray-400 dark:bg-gray-500 rounded-full"></div>
      </div>
      
      <div className="flex justify-between items-center px-4 py-2 border-b border-gray-200 dark:border-gray-700 mt-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Individual Entity Energy Flows - Hour {currentHour}
        </h2>
        <div className="flex space-x-3">
          <button
            onClick={toggleFullscreen}
            className="bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-800 px-2 py-1 rounded-md flex items-center gap-1"
            title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-xs">Exit fullscreen</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
                </svg>
                <span className="text-xs">Fullscreen</span>
              </>
            )}
          </button>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
      <div className="p-4" style={{ 
          height: isFullscreen ? `calc(100% - 48px)` : '350px',
          minHeight: '300px',
          overflow: 'visible'
        }}>
        <svg 
          ref={svgRef} 
          className="w-full h-full" 
          style={{ background: isDarkMode ? 'rgba(31, 41, 55, 0.5)' : 'rgba(255, 255, 255, 0.5)' }}
        ></svg>
      </div>
    </div>
  );
};

export default SankeyDrawer;
