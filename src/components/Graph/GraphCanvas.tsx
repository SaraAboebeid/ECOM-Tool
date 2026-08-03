import { useRef, useMemo } from 'react';
import { GraphData, Node } from '../../types';
import { GraphNodes } from './GraphNodes';
import { GraphNodesOptimized } from './GraphNodesOptimized';
import { GraphLinks } from './GraphLinks';
import { GraphParticles } from './GraphParticles';
import { useGraphSimulation } from '../../hooks/useGraphSimulation';
import { detectPerformanceLevel, PERFORMANCE_PRESETS } from '../../utils/performanceConfig';
import { getScaledImageDimensions, getImageCenter, COMPASS_ORIENTATION } from '../../utils/backgroundConfig';

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

const BASEMAP_BBOX_WGS84 = {
  minLat: 57.682,
  minLon: 11.964,
  maxLat: 57.696,
  maxLon: 11.99,
};

const BASEMAP_ZOOM = 16;

type BasemapTile = {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const lonToTileX = (lon: number, zoom: number): number => {
  return ((lon + 180) / 360) * Math.pow(2, zoom);
};

const latToTileY = (lat: number, zoom: number): number => {
  const latRad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    Math.pow(2, zoom)
  );
};

const buildBasemapTiles = (canvasWidth: number, canvasHeight: number): BasemapTile[] => {
  const zoom = BASEMAP_ZOOM;

  const xMinFloat = lonToTileX(BASEMAP_BBOX_WGS84.minLon, zoom);
  const xMaxFloat = lonToTileX(BASEMAP_BBOX_WGS84.maxLon, zoom);
  const yMinFloat = latToTileY(BASEMAP_BBOX_WGS84.maxLat, zoom);
  const yMaxFloat = latToTileY(BASEMAP_BBOX_WGS84.minLat, zoom);

  const xStart = Math.floor(xMinFloat);
  const xEnd = Math.floor(xMaxFloat);
  const yStart = Math.floor(yMinFloat);
  const yEnd = Math.floor(yMaxFloat);

  const xSpan = xMaxFloat - xMinFloat || 1;
  const ySpan = yMaxFloat - yMinFloat || 1;

  const tiles: BasemapTile[] = [];
  for (let x = xStart; x <= xEnd; x += 1) {
    for (let y = yStart; y <= yEnd; y += 1) {
      const tileLeft = ((x - xMinFloat) / xSpan) * canvasWidth;
      const tileRight = ((x + 1 - xMinFloat) / xSpan) * canvasWidth;
      const tileTop = ((y - yMinFloat) / ySpan) * canvasHeight;
      const tileBottom = ((y + 1 - yMinFloat) / ySpan) * canvasHeight;
      const subdomain = ['a', 'b', 'c', 'd'][(x + y) % 4];

      tiles.push({
        url: `https://${subdomain}.basemaps.cartocdn.com/light_all/${zoom}/${x}/${y}.png`,
        x: tileLeft,
        y: tileTop,
        width: tileRight - tileLeft,
        height: tileBottom - tileTop,
      });
    }
  }

  return tiles;
};

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
  const basemapTiles = useMemo(
    () => buildBasemapTiles(imageWidth, imageHeight),
    [imageWidth, imageHeight]
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

        {/* Real georeferenced basemap tiles (CartoDB Positron light) for campus bbox */}
        <g
          clipPath="url(#campusBasemapClip)"
          transform={`rotate(${COMPASS_ORIENTATION} ${imageCenter.x} ${imageCenter.y})`}
        >
          {basemapTiles.map((tile) => (
            <image
              key={tile.url}
              href={tile.url}
              x={tile.x}
              y={tile.y}
              width={tile.width}
              height={tile.height}
              preserveAspectRatio="none"
              opacity="0.9"
            />
          ))}

          {/* Keep campus 3D context lightly over the map */}
          <image
            href="/3d_topview.png"
            x={0}
            y={0}
            width={imageWidth}
            height={imageHeight}
            opacity="0.2"
          />
        </g>

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
