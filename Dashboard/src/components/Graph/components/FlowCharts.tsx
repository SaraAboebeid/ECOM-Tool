import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Link, Node } from '../../../types';

interface FlowChartsProps {
  node: Node;
  links: Link[];
}

/**
 * Component that renders line charts for incoming and outgoing flows
 */
export const FlowCharts: React.FC<FlowChartsProps> = ({ node, links }) => {
  const incomingSvgRef = useRef<SVGSVGElement>(null);
  const outgoingSvgRef = useRef<SVGSVGElement>(null);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => 
    document.documentElement.classList.contains('dark')
  );

  // Update charts when theme changes
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          const isDark = document.documentElement.classList.contains('dark');
          setIsDarkMode(isDark);
        }
      });
    });

    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!node || !links || links.length === 0) return;

    // Filter links for incoming and outgoing flows
    const incomingLinks = links.filter(link => link.target === node.id);
    const outgoingLinks = links.filter(link => link.source === node.id);

    // Sum up the flows for each hour
    const incomingFlowsByHour = Array(24).fill(0);
    const outgoingFlowsByHour = Array(24).fill(0);

    // Process incoming links
    incomingLinks.forEach(link => {
      if (link.flow && Array.isArray(link.flow)) {
        // Assuming flows are hourly and have 24 points
        const hourlyFlows = link.flow.slice(0, 24);
        hourlyFlows.forEach((flow, hour) => {
          incomingFlowsByHour[hour] += Math.max(0, flow); // Only add positive flows
        });
      }
    });

    // Process outgoing links
    outgoingLinks.forEach(link => {
      if (link.flow && Array.isArray(link.flow)) {
        const hourlyFlows = link.flow.slice(0, 24);
        hourlyFlows.forEach((flow, hour) => {
          outgoingFlowsByHour[hour] += Math.max(0, flow); // Only add positive flows
        });
      }
    });

    // Draw charts if we have data
    if (incomingLinks.length > 0) {
      drawLineChart(incomingSvgRef.current, incomingFlowsByHour, '#00BFFF', 'Incoming');
    }

    if (outgoingLinks.length > 0) {
      drawLineChart(outgoingSvgRef.current, outgoingFlowsByHour, '#FF4500', 'Outgoing');
    }
  }, [node, links, isDarkMode]);

  // D3 chart drawing function
  const drawLineChart = (svgElement: SVGSVGElement | null, data: number[], color: string, label: string) => {
    if (!svgElement) return;

    // Clear previous chart
    d3.select(svgElement).selectAll('*').remove();

    // Use isDarkMode state
    const textColor = isDarkMode ? '#e5e7eb' : '#374151'; // gray-200 for dark, gray-700 for light

    const width = svgElement.clientWidth || 250;
    const height = svgElement.clientHeight || 150;
    const margin = { top: 20, right: 30, bottom: 30, left: 40 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const svg = d3.select(svgElement)
      .attr('width', width)
      .attr('height', height);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Create scales
    const x = d3.scaleLinear()
      .domain([0, data.length - 1])
      .range([0, innerWidth]);

    const y = d3.scaleLinear()
      .domain([0, d3.max(data) || 0])
      .nice()
      .range([innerHeight, 0]);

    // Create the line generator
    const line = d3.line<number>()
      .x((_, i) => x(i))
      .y(d => y(d))
      .curve(d3.curveMonotoneX);

    // Add the X axis
    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x).ticks(6).tickFormat((d: any) => `${d}h`))
      .attr('class', 'text-xs')
      .attr('color', textColor);

    // Add the Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(5))
      .attr('class', 'text-xs')
      .attr('color', textColor);

    // Add the line path
    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 2)
      .attr('d', line as any);

    // Add the area under the line
    g.append('path')
      .datum(data)
      .attr('fill', color)
      .attr('fill-opacity', 0.2)
      .attr('d', d3.area<number>()
        .x((_, i) => x(i))
        .y0(innerHeight)
        .y1(d => y(d))
        .curve(d3.curveMonotoneX) as any
      );

    // Add chart label
    g.append('text')
      .attr('x', innerWidth / 2)
      .attr('y', 0)
      .attr('text-anchor', 'middle')
      .attr('class', 'text-sm font-semibold')
      .attr('fill', textColor)
      .text(`${label} Flow`);

    // Add units
    g.append('text')
      .attr('x', -margin.left + 10)
      .attr('y', -5)
      .attr('text-anchor', 'start')
      .attr('fill', isDarkMode ? '#9ca3af' : '#6b7280') // gray-400 for dark, gray-500 for light
      .attr('class', 'text-xs')
      .text('kWh');
  };

  return (
    <div className="flow-charts space-y-6 mt-6">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Energy Flows (24h)</h3>
      
      <div>
        <svg ref={incomingSvgRef} className="w-full h-[150px]"></svg>
      </div>

      <div>
        <svg ref={outgoingSvgRef} className="w-full h-[150px]"></svg>
      </div>
    </div>
  );
};

export default FlowCharts;
