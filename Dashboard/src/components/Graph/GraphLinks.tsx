import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { GraphData, NODE_COLORS } from '../../types';

/**
 * Flow visualisation.
 *
 * Semantics are kept separate so nothing is encoded twice:
 *   colour  energy source (NODE_COLORS, by source node type)
 *   width   flow magnitude
 *   motion  flow direction (dash animation runs forward or reverse)
 *
 * Each link is drawn as two stacked paths: a wide, low-opacity glow and a
 * narrower core at the measured width. The glow is what makes the map read as
 * neon; the core is what stays honest about magnitude.
 */
const FLOW_CONFIG = {
  // Core width, in px, mapped from flow magnitude.
  MIN_WIDTH: 2.5,         // low-but-real flows must stay visible
  MAX_WIDTH: 14,
  // Below 1 this lifts small flows off the floor, so the busy middle of the
  // range gets most of the visual spread instead of only the largest links.
  WIDTH_GAMMA: 0.65,

  // Opacity also tracks flow, but over a much narrower range than width, so
  // magnitude is read from thickness rather than from fading.
  MIN_OPACITY: 0.5,
  MAX_OPACITY: 1.0,
  OPACITY_GAMMA: 0.4,

  // Reference flow that maps to MAX_WIDTH. A percentile rather than the
  // maximum: one outlier link would otherwise squeeze everything else onto
  // MIN_WIDTH and the map would lose all contrast.
  REFERENCE_PERCENTILE: 0.95,
  FALLBACK_REFERENCE: 20,  // kW, if the dataset carries no usable flows

  // Glow sits behind the core at this multiple of its width.
  GLOW_WIDTH_MULTIPLIER: 1.9,
  GLOW_OPACITY_SCALE: 0.3,   // fraction of the core's opacity

  // Idle links keep a faint trace so the network topology stays legible.
  IDLE_WIDTH: 1,
  IDLE_OPACITY: 0.08,

  // Exponential smoothing of magnitude before it becomes width. Without this
  // the strokes visibly jitter as the timeline plays.
  SMOOTHING_ALPHA: 0.28,
  // A jump larger than this many hours is a scrub, not playback, so snap
  // instead of easing - otherwise dragging the timeline feels laggy.
  SMOOTHING_SNAP_GAP: 1,

  PARTICLE_SIZE: 5,

  // Dash-animation speed thresholds (kW).
  FAST_THRESHOLD: 3,
  SLOW_THRESHOLD: 1,

  // Hover widens the glow only. The core stays at its measured width so the
  // thickness never lies about the flow.
  HOVER_GLOW_MULTIPLIER: 3.4,
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

/**
 * Magnitude that maps to MAX_WIDTH, taken as a high percentile of the non-zero
 * flows across every link and hour.
 *
 * Zeros are excluded deliberately: most links idle for most of the day, so
 * including them would drag the percentile towards zero and saturate every
 * active link at full width. Computed over the whole time series, not per
 * hour, so a link of the same size looks the same at 03:00 as at 13:00.
 */
const computeReferenceFlow = (links: any[]): number => {
  const magnitudes: number[] = [];
  for (const link of links) {
    const flow = link?.flow;
    if (!flow || typeof flow.length !== 'number') continue;
    for (let i = 0; i < flow.length; i += 1) {
      const value = Math.abs(flow[i]);
      if (value > 0) magnitudes.push(value);
    }
  }
  if (!magnitudes.length) return FLOW_CONFIG.FALLBACK_REFERENCE;

  magnitudes.sort((a, b) => a - b);
  const index = Math.min(
    magnitudes.length - 1,
    Math.floor(FLOW_CONFIG.REFERENCE_PERCENTILE * (magnitudes.length - 1))
  );
  return magnitudes[index] || FLOW_CONFIG.FALLBACK_REFERENCE;
};

interface LinkVisual {
  magnitude: number;   // smoothed, for width
  signed: number;      // raw, for direction
  width: number;
  opacity: number;
  colour: string;
}

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
 * Renders graph links as dual-layer neon flows.
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
  // Smoothed magnitude per link, carried across hours.
  const smoothedRef = useRef<Map<string, number>>(new Map());
  const lastHourRef = useRef<number | null>(null);
  const referenceFlowRef = useRef<number>(FLOW_CONFIG.FALLBACK_REFERENCE);

  useEffect(() => {
    if (!containerRef.current || !simulation || !data.links.length) return;

    const container = d3.select(containerRef.current);

    const linkForce = simulation.force('link') as d3.ForceLink<any, any>;
    const linkData = linkForce ? linkForce.links() : [];
    const nodeData = simulation.nodes() as any[];

    const nodeById = new Map(nodeData.map((node) => [node.id, node]));
    const resolveNode = (endpoint: any) =>
      nodeById.get(endpoint?.id ?? endpoint);

    const currentDataKey = JSON.stringify(
      data.links.map((l) => ({ source: l.source, target: l.target }))
    );
    const structureChanged = currentDataKey !== lastDataRef.current;

    // Re-derive the width reference before anything reads it: on a structure
    // change the old percentile and the smoothing history describe a different
    // graph. Doing this after the visuals were computed would render the first
    // frame against the fallback reference.
    if (structureChanged) {
      referenceFlowRef.current = computeReferenceFlow(linkData);
      smoothedRef.current.clear();
      lastHourRef.current = null;
    }
    const reference = referenceFlowRef.current;

    // Snap rather than ease when the timeline is scrubbed.
    const previousHour = lastHourRef.current;
    const isContinuous =
      previousHour !== null &&
      Math.abs(currentHour - previousHour) <= FLOW_CONFIG.SMOOTHING_SNAP_GAP;
    const alpha = isContinuous ? FLOW_CONFIG.SMOOTHING_ALPHA : 1;
    lastHourRef.current = currentHour;

    // Advance the smoothing filter exactly once per link per render, then read
    // the result back everywhere. Recomputing inside each attribute callback
    // would step the filter six times a frame and compound alpha.
    const visuals = new Map<string, LinkVisual>();
    for (const link of linkData) {
      const signed = (link as any)?.flow?.[currentHour] ?? 0;
      const raw = Math.abs(signed);

      // f_smooth = alpha * f + (1 - alpha) * f_prev
      const key = getLinkKey(link);
      const previous = smoothedRef.current.get(key);
      const magnitude =
        previous === undefined ? raw : alpha * raw + (1 - alpha) * previous;
      smoothedRef.current.set(key, magnitude);

      const sourceNode = resolveNode((link as any).source);
      const colour = sourceNode
        ? NODE_COLORS[sourceNode.type] || '#6B7280'
        : '#9CA3AF';

      if (magnitude <= 0.001) {
        visuals.set(key, { magnitude, signed, width: 0, opacity: 0, colour });
        continue;
      }

      const normalised = Math.min(magnitude / reference, 1);
      visuals.set(key, {
        magnitude,
        signed,
        colour,
        width:
          FLOW_CONFIG.MIN_WIDTH +
          (FLOW_CONFIG.MAX_WIDTH - FLOW_CONFIG.MIN_WIDTH) *
            Math.pow(normalised, FLOW_CONFIG.WIDTH_GAMMA),
        opacity:
          FLOW_CONFIG.MIN_OPACITY +
          (FLOW_CONFIG.MAX_OPACITY - FLOW_CONFIG.MIN_OPACITY) *
            Math.pow(normalised, FLOW_CONFIG.OPACITY_GAMMA),
      });
    }

    const IDLE: LinkVisual = {
      magnitude: 0, signed: 0, width: 0, opacity: 0, colour: '#9CA3AF',
    };
    const visualFor = (link: any): LinkVisual =>
      visuals.get(getLinkKey(link)) ?? IDLE;

    const flowClass = (link: any): string => {
      const signed = link?.flow?.[currentHour] ?? 0;
      const magnitude = Math.abs(signed);
      if (magnitude === 0) return 'link';

      let speed = '';
      if (magnitude > FLOW_CONFIG.FAST_THRESHOLD) speed = '-fast';
      else if (magnitude <= FLOW_CONFIG.SLOW_THRESHOLD) speed = '-slow';

      return signed > 0
        ? `link link-flow${speed}`
        : `link link-flow-reverse${speed}`;
    };

    /** Style the wide, faint layer that produces the glow. */
    const styleGlow = (selection: any) =>
      selection
        .attr('stroke', (d: any) => visualFor(d).colour)
        .attr('stroke-width', (d: any) => {
          const { width } = visualFor(d);
          return width > 0
            ? width * FLOW_CONFIG.GLOW_WIDTH_MULTIPLIER
            : FLOW_CONFIG.IDLE_WIDTH;
        })
        .attr('stroke-opacity', (d: any) => {
          const { opacity } = visualFor(d);
          return opacity > 0
            ? opacity * FLOW_CONFIG.GLOW_OPACITY_SCALE
            : FLOW_CONFIG.IDLE_OPACITY;
        });

    /** Style the core, whose width is the honest reading of the flow. */
    const styleCore = (selection: any) =>
      selection
        .attr('stroke', (d: any) => visualFor(d).colour)
        .attr('stroke-width', (d: any) => visualFor(d).width)
        .attr('stroke-opacity', (d: any) => visualFor(d).opacity)
        .attr('class', flowClass)
        .style('cursor', (d: any) =>
          Math.abs(d?.flow?.[currentHour] ?? 0) > 0 ? 'pointer' : 'default'
        );

    if (!structureChanged && container.selectAll('.link').size() > 0) {
      const glowLinks = container.selectAll('.link-glow');
      const coreLinks = container.selectAll('.link');

      styleGlow(glowLinks);
      styleCore(coreLinks);

      const updateLinkPositions = () => {
        coreLinks.attr('d', buildStructuredPath);
        glowLinks.attr('d', buildStructuredPath);
      };

      simulation.on('tick.links', updateLinkPositions);
      updateLinkPositions();
      return;
    }

    lastDataRef.current = currentDataKey;

    container.selectAll('.links-container').remove();

    const linksContainer = container
      .append('g')
      .attr('class', 'links-container');

    const glowSelection = linksContainer
      .selectAll('.link-glow')
      .data(linkData)
      .enter()
      .append('path')
      .attr('class', 'link-glow')
      .attr('fill', 'none')
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
      .attr('pointer-events', 'none')
      .call(styleGlow);

    const linkSelection = linksContainer
      .selectAll('.link')
      .data(linkData)
      .enter()
      .append('path')
      .attr('fill', 'none')
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
      .attr(
        'stroke-dasharray',
        `${FLOW_CONFIG.PARTICLE_SIZE} ${FLOW_CONFIG.PARTICLE_SIZE}`
      )
      .attr('data-link-index', (_d: any, i: number) => i)
      .call(styleCore);

    const glowNodes = glowSelection.nodes();

    linkSelection
      .on('mouseover', function (this: SVGPathElement, event: MouseEvent, d: any) {
        const signed = d?.flow?.[currentHour] ?? 0;
        if (Math.abs(signed) === 0) return;

        // Widen the glow only; the core keeps its measured width.
        const index = Number(this.getAttribute('data-link-index'));
        const glow = glowNodes[index];
        if (glow) {
          const { width, opacity } = visualFor(d);
          d3.select(glow)
            .attr('stroke-width', width * FLOW_CONFIG.HOVER_GLOW_MULTIPLIER)
            .attr('stroke-opacity', Math.min(1, opacity * 0.55));
        }
        d3.select(this).style('filter', 'brightness(1.25)');

        const sourceNode = resolveNode(d.source);
        const targetNode = resolveNode(d.target);

        if (sourceNode && targetNode) {
          const sourceTypeLabel =
            {
              grid: 'Grid Energy',
              pv: 'Solar Energy',
              battery: 'Battery Energy',
              building: 'Building Energy',
              charge_point: 'Charging Energy'
            }[sourceNode.type as string] || 'Energy';

          let tooltipContent = `<div class="font-semibold">Energy Flow</div>`;
          tooltipContent += `<div>From: ${sourceNode.name || sourceNode.id}</div>`;
          tooltipContent += `<div>To: ${targetNode.name || targetNode.id}</div>`;
          tooltipContent += `<div>Flow: ${signed.toFixed(2)} kW</div>`;
          tooltipContent += `<div class="text-sm text-gray-500">Source: ${sourceTypeLabel}</div>`;
          tooltip.showTooltip(tooltipContent, event);
        }
      })
      .on('mousemove', (event: MouseEvent) => {
        tooltip.updateTooltipPosition(event);
      })
      .on('mouseout', function (this: SVGPathElement) {
        const datum = d3.select(this).datum() as any;
        const index = Number(this.getAttribute('data-link-index'));
        const glow = glowNodes[index];
        if (glow) styleGlow(d3.select(glow).datum(datum));
        d3.select(this).style('filter', null);
        tooltip.hideTooltip();
      });

    const updateLinkPositions = () => {
      linkSelection.attr('d', buildStructuredPath);
      glowSelection.attr('d', buildStructuredPath);
    };

    simulation.on('tick.links', updateLinkPositions);
    updateLinkPositions();
  }, [containerRef, simulation, data.links, data.nodes, tooltip, currentHour, isPlaying]);

  return null;
};

export default GraphLinks;
