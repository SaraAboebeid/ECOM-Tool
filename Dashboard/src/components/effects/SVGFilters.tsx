import { useEffect } from 'react';
import * as d3 from 'd3';
import { NODE_COLORS } from '../../types';

interface SVGFiltersProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
}

/**
 * Component that creates and manages all SVG filters for the graph
 */
export const SVGFilters: React.FC<SVGFiltersProps> = ({ svgRef }) => {
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');

    // Clear existing filters
    defs.selectAll('*').remove() as any;

    // All filters are turned off as requested
  }, [svgRef]);

  return null; // This component only creates SVG filters, no JSX
};

export default SVGFilters;
