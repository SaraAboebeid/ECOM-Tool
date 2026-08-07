import { useEffect } from 'react';
import * as d3 from 'd3';
import { NODE_COLORS } from '../../types';

interface ArrowMarkersProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
}

/**
 * Component that creates arrow markers for link flow direction visualization
 */
export const ArrowMarkers: React.FC<ArrowMarkersProps> = ({ svgRef }) => {
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');

    // Create arrow markers for links with different colors based on node type
    const markerTypes = [
      { id: 'flow-pv', color: NODE_COLORS.pv },
      { id: 'flow-grid', color: NODE_COLORS.grid },
      { id: 'flow-battery', color: NODE_COLORS.battery },
      { id: 'flow-building', color: NODE_COLORS.building },
      { id: 'flow-charge', color: NODE_COLORS.charge_point },
      { id: 'flow', color: '#999' } // Default marker
    ];
    
    const markers = defs.selectAll(null) as any;
    
    markers
      .data(markerTypes)
      .enter().append('marker')
      .attr('class', 'flow-marker')
      .attr('id', (d: any) => d.id)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 40) // Increased to position arrows properly with larger nodes
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('fill', (d: any) => d.color)
      .attr('d', 'M0,-5L10,0L0,5');

  }, [svgRef]);

  return null; // This component only creates SVG markers, no JSX
};

export default ArrowMarkers;
