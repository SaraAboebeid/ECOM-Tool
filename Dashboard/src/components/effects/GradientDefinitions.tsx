import { useEffect } from 'react';
import * as d3 from 'd3';
import { NODE_COLORS } from '../../types';

interface GradientDefinitionsProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
}

/**
 * Component that creates linear gradients for energy flow visualization
 */
export const GradientDefinitions: React.FC<GradientDefinitionsProps> = ({ svgRef }) => {
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');

    // Create linear gradients for each node type's flow with 3D depth
    const createGradient = (type: string, color: string) => {
      const gradient = defs.append('linearGradient')
        .attr('id', `gradient-${type}`)
        .attr('gradientUnits', 'userSpaceOnUse')
        .attr('x1', '0%')
        .attr('y1', '0%')
        .attr('x2', '100%')
        .attr('y2', '0%');
        
      gradient.append('stop')
        .attr('offset', '0%')
        .attr('stop-color', d3.color(color)?.darker(0.3)?.toString() || color)
        .attr('stop-opacity', 0.8);
        
      gradient.append('stop')
        .attr('offset', '30%')
        .attr('stop-color', color)
        .attr('stop-opacity', 1);
        
      gradient.append('stop')
        .attr('offset', '70%')
        .attr('stop-color', d3.color(color)?.brighter(0.5)?.toString() || color)
        .attr('stop-opacity', 1);
        
      gradient.append('stop')
        .attr('offset', '100%')
        .attr('stop-color', d3.color(color)?.darker(0.2)?.toString() || color)
        .attr('stop-opacity', 0.8);
    };

    // Create gradients for each node type
    createGradient('pv', NODE_COLORS.pv);
    createGradient('grid', NODE_COLORS.grid);
    createGradient('battery', NODE_COLORS.battery);
    createGradient('building', NODE_COLORS.building);
    createGradient('charge', NODE_COLORS.charge_point);

  }, [svgRef]);

  return null; // This component only creates SVG gradients, no JSX
};

export default GradientDefinitions;
