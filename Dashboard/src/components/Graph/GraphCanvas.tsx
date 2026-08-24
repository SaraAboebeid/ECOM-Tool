import { useRef, useMemo } from 'react';
import { GraphData, Node, SURFACE_COLOR } from '../../types';
import { GraphNodes } from './GraphNodes';
import { GraphLinks } from './GraphLinks';
import { useGraphSimulation } from '../../hooks/useGraphSimulation';
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

/**
 * Surrounding massing from the model's BuildingMesh layer.
 *
 * Off, because it is not the city context it looks like. Measured against the
 * BuildingBrep layers it is 101,994 m2 against their 233,738 m2, and at the
 * best rigid alignment 53% of it lands on top of buildings that are already
 * drawn - so it half-duplicates the campus, offset, and reads as a ghost copy.
 *
 * The offset is the same one that left BuildingMesh behind when the model was
 * moved. Turn this back on once those layers are realigned in Rhino.
 */
const SHOW_CONTEXT: boolean = false;

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

  // Vector footprints from the Rhino campus model, replacing 3d_topview.png.
  // Their centroids also stand in for any building the hand-placed position
  // table has no entry for.
  const { buildings, context, centroids } = useBuildingFootprints();

  // Use the simulation hook
  const { simulation } = useGraphSimulation({
    svgRef,
    containerRef,
    data,
    dimensions,
    graphStructureKey,
    filtersKey,
    selectedNode,
    footprintCentroids: centroids
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

        {/* Plain neutral ground. The campus context footprints carry the map,
            so no gradient, grid or glow competes with them. */}
        <rect
          x={-2600}
          y={-2600}
          width={5200}
          height={5200}
          fill={SURFACE_COLOR}
          pointerEvents="none"
        />

        {/* Vector campus footprints from the Rhino model, and the street tiles
            when enabled. Both go through the same Mercator -> image-frame
            projection, so they agree with each other and with the fixed node
            positions. */}
        {/* The clip is sized to the old 3d_topview.png frame, which is smaller
            than the campus context in the Rhino model - it was cutting roughly
            60% of the context massing. It only exists to bound the tile grid,
            so it applies solely when the basemap is on. */}
        <g
          clipPath={SHOW_BASEMAP ? 'url(#campusBasemapClip)' : undefined}
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

          {/* Surrounding massing: context only, so it stays non-interactive.
              Neutral grey rather than blue, and solid enough to read as the
              city around the campus. */}
          {SHOW_CONTEXT && context.map((feature) => (
            <path
              key={feature.id}
              d={feature.path}
              fill="#e3e7ec"
              fillOpacity="0.9"
              stroke="#c6ccd5"
              strokeOpacity="0.9"
              strokeWidth={0.5}
              pointerEvents="none"
            />
          ))}

          {/* Named buildings: these carry an id and can be joined to energy
              data, so they sit a step darker than the context around them. */}
          {buildings.map((feature) => (
            <path
              key={feature.id}
              d={feature.path}
              fill="#ccd3dd"
              fillOpacity="0.95"
              stroke="#94a1b2"
              strokeOpacity="0.95"
              strokeWidth={0.8}
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
