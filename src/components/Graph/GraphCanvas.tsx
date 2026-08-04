import { useRef, useMemo } from 'react';
import { GraphData, Node } from '../../types';
import { GraphNodes } from './GraphNodes';
import { GraphNodesOptimized } from './GraphNodesOptimized';
import { GraphLinks } from './GraphLinks';
import { GraphParticles } from './GraphParticles';
import { useGraphSimulation } from '../../hooks/useGraphSimulation';
import { detectPerformanceLevel, PERFORMANCE_PRESETS } from '../../utils/performanceConfig';
import { getScaledImageDimensions, getImageCenter, COMPASS_ORIENTATION } from '../../utils/backgroundConfig';
import { buildBasemapTiles } from '../../utils/geoProjection';
import { useBuildingFootprints } from '../../hooks/useBuildingFootprints';

interface GraphCanvasProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
  data: GraphData;
  currentHour: number;
  dimensions: { width: number; height: number };
  isTimelinePlaying?: boolean;
  graphStructureKey: string;
  filtersKey: string;
  selectedNode: Node | null;
  onNodeClick: (node: Node) => void;
  tooltip: {
    showTooltip: (html: string, event: MouseEvent) => void;
    hideTooltip: (delay?: number) => void;
    updateTooltipPosition: (event: MouseEvent) => void;
  };
  performanceMode?: 'auto' | 'high_performance' | 'balanced' | 'high_quality';
}

/**
 * Street tiles behind the campus. Off for now; the Rhino footprints carry the
 * campus on their own. Flip back to true to restore them - the tiles are placed
 * by their true Mercator coordinates rather than stretched to fill the render's
 * rect, so they still line up with the footprints. See utils/geoProjection.ts.
 */
// Typed as boolean, not the literal false, so editors do not flag the guarded
// branches as unreachable while it is off.
const SHOW_BASEMAP: boolean = false;

const BASEMAP_ZOOM = 17;

/**
 * GraphCanvas component that manages the SVG container and D3 simulation
 */
export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  svgRef,
  data,
  currentHour,
  dimensions,
  isTimelinePlaying,
  graphStructureKey,
  filtersKey,
  selectedNode,
  onNodeClick,
  tooltip,
  performanceMode = 'auto'
}) => {
  const containerRef = useRef<SVGGElement>(null);

  // Determine performance configuration
  const performanceConfig = useMemo(() => {
    const mode = performanceMode === 'auto' ? detectPerformanceLevel() : performanceMode.toUpperCase();
    return PERFORMANCE_PRESETS[mode as keyof typeof PERFORMANCE_PRESETS] || PERFORMANCE_PRESETS.BALANCED;
  }, [performanceMode]);

  // Use the simulation hook
  const { simulation, zoom } = useGraphSimulation({
    svgRef,
    containerRef,
    data,
    dimensions,
    graphStructureKey,
    filtersKey,
    selectedNode
  });

  // Force GraphNodes with icons for now (instead of checking performance config)
  const NodesComponent = GraphNodes;

  // Background image dimensions (configurable scaling)
  const { width: imageWidth, height: imageHeight } = getScaledImageDimensions();
  const imageCenter = getImageCenter();
  // Skip the tile maths entirely while the basemap is off.
  const basemapTiles = useMemo(
    () => (SHOW_BASEMAP ? buildBasemapTiles(BASEMAP_ZOOM) : []),
    []
  );

  // Vector footprints from the Rhino campus model, replacing 3d_topview.png.
  const { buildings, context } = useBuildingFootprints();

  return (
    <svg
      ref={svgRef}
      className="w-full h-full"
      style={{ background: 'transparent', contain: 'layout paint style' }}
    >
      {/* SVG definitions for filters, gradients, and markers removed for simple edges */}

      {/* Main container group for zoom/pan transforms */}
      <g ref={containerRef}>
        <defs>
          <clipPath id="campusBasemapClip">
            <rect x={0} y={0} width={imageWidth} height={imageHeight} />
          </clipPath>
        </defs>

        {/* Vector campus footprints from the Rhino model, and the street tiles
            when enabled. Both go through the same Mercator -> image-frame
            projection, so they agree with each other and with the fixed node
            positions. */}
        <g
          clipPath="url(#campusBasemapClip)"
          transform={`rotate(${COMPASS_ORIENTATION} ${imageCenter.x} ${imageCenter.y})`}
        >
          {SHOW_BASEMAP && basemapTiles.map((tile) => (
            <image
              key={tile.key}
              href={tile.url}
              width={256}
              height={256}
              transform={tile.matrix}
              opacity="0.9"
            />
          ))}

          {/* Surrounding massing: context only, so it stays non-interactive. */}
          {context.map((feature) => (
            <path
              key={feature.id}
              d={feature.path}
              fill="#94a3b8"
              fillOpacity="0.28"
              stroke="#64748b"
              strokeOpacity="0.35"
              strokeWidth={0.6}
              pointerEvents="none"
            />
          ))}

          {/* Named buildings: these carry an id and can be joined to energy data. */}
          {buildings.map((feature) => (
            <path
              key={feature.id}
              d={feature.path}
              fill="#64748b"
              fillOpacity="0.45"
              stroke="#334155"
              strokeOpacity="0.6"
              strokeWidth={0.9}
              pointerEvents="none"
            >
              <title>
                {`${feature.rhinoLayer ?? feature.id}`}
                {feature.footprintM2 ? ` - ${Math.round(feature.footprintM2).toLocaleString()} m2` : ''}
                {feature.heightM ? `, ${feature.heightM.toFixed(1)} m` : ''}
              </title>
            </path>
          ))}
        </g>

        {/* Attribution belongs to the tiles, so it goes when they do. */}
        {SHOW_BASEMAP && (
          <text
            x={12}
            y={imageHeight - 12}
            fontSize="10"
            fill="#334155"
            opacity="0.85"
            pointerEvents="none"
            transform={`rotate(${COMPASS_ORIENTATION} ${imageCenter.x} ${imageCenter.y})`}
          >
            Basemap: OpenStreetMap contributors, CARTO
          </text>
        )}

        {/* Links layer */}
        <GraphLinks
          containerRef={containerRef}
          data={data}
          currentHour={currentHour}
          simulation={simulation}
          isPlaying={isTimelinePlaying}
          tooltip={tooltip}
        />

      {/* Particles layer removed for simple edges */}

        {/* Nodes layer */}
        <NodesComponent
          containerRef={containerRef}
          data={data}
          currentHour={currentHour}
          simulation={simulation}
          selectedNode={selectedNode}
          onNodeClick={onNodeClick}
          tooltip={tooltip}
        />
      </g>
    </svg>
  );
};

export default GraphCanvas;
