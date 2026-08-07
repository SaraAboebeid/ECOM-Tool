/**
 * Web Mercator <-> dashboard image frame.
 *
 * The image frame is the coordinate system the fixed node positions live in:
 * the 565.752 x 1276.608 space of the old 3d_topview.png render. It turns out
 * to be a faithful orthographic view of the Rhino campus model at almost
 * exactly 1 pixel per metre - fitting 25 building centroids against their node
 * positions gave scale 0.99994 px/m with a median residual of 4.9 m.
 *
 * Crucially the frame is NOT north-up. The Rhino model was rotated ~18.8deg
 * before rendering, which in Mercator at this latitude shows up as ~21.2deg.
 * Tiles drawn axis-aligned into this rect are therefore rotated relative to the
 * buildings, which is why the old basemap never lined up with the campus no
 * matter how the bounding box was tweaked.
 *
 * Provenance of the constants, all recomputable:
 *   background image.3dm local space -> EPSG:3006, by matching the mesh-union
 *     footprints of the 11 buildings whose areas agree across models:
 *     scale 1.000063, rotation 18.838776deg. Residual 0.08 m mean, 0.17 m max.
 *   EPSG:3006 -> WGS84 via pyproj.
 *   The four image-frame corners then give this affine, which reproduces them
 *   to 0.06 px.
 *
 * See backend/scripts/export_footprints_geojson.py, which writes the footprint
 * GeoJSON this projects.
 */
import {
  ORIGINAL_IMAGE_WIDTH,
  ORIGINAL_IMAGE_HEIGHT,
  BACKGROUND_SCALE,
  COMPASS_ORIENTATION,
} from './backgroundConfig';

/** Normalised Web Mercator origin of the image frame's (0,0) corner. */
const MERCATOR_ORIGIN = { x: 0.533247958333, y: 0.302790953592 };

/**
 * Maps normalised-Mercator offsets to unscaled image-frame pixels:
 *   image = (mercator - MERCATOR_ORIGIN) * MERC_TO_IMAGE
 * Row-major, applied as a row vector on the left.
 */
const MERC_TO_IMAGE = [
  [20009857.245624, 7775776.778258],
  [-7762764.821643, 19974031.594611],
] as const;

export interface Point {
  x: number;
  y: number;
}

/** Longitude/latitude to normalised Web Mercator, both axes in [0, 1]. */
export const lonLatToMercator = (lon: number, lat: number): Point => {
  const latRad = (lat * Math.PI) / 180;
  return {
    x: (lon + 180) / 360,
    y: (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2,
  };
};

/**
 * Longitude/latitude to image-frame pixels, already multiplied by
 * BACKGROUND_SCALE so the result shares the node coordinate space.
 */
export const lonLatToImage = (lon: number, lat: number): Point => {
  const m = lonLatToMercator(lon, lat);
  const dx = m.x - MERCATOR_ORIGIN.x;
  const dy = m.y - MERCATOR_ORIGIN.y;
  return {
    x: (dx * MERC_TO_IMAGE[0][0] + dy * MERC_TO_IMAGE[1][0]) * BACKGROUND_SCALE,
    y: (dx * MERC_TO_IMAGE[0][1] + dy * MERC_TO_IMAGE[1][1]) * BACKGROUND_SCALE,
  };
};

/**
 * Degrees to rotate an up-pointing arrow so it points at true north on screen.
 *
 * Two rotations compose here. The Rhino model was turned ~18.8deg before the
 * render, which in Mercator at this latitude reads as 21.2deg, and the viewer
 * then applies COMPASS_ORIENTATION on top. North therefore does not point up:
 * it comes out pointing left and slightly up, which is why the Vasa buildings
 * (the northern end of the campus) sit on the left of the canvas.
 */
export const getNorthRotationDeg = (): number => {
  // North is decreasing Mercator y, so its image-space direction is the
  // negated second row of the affine.
  const angleInImage = Math.atan2(-MERC_TO_IMAGE[1][1], -MERC_TO_IMAGE[1][0]);
  // +90 because an arrow drawn pointing up already sits at -90deg.
  return (angleInImage * 180) / Math.PI + COMPASS_ORIENTATION + 90;
};

export interface BasemapTile {
  key: string;
  url: string;
  /** SVG matrix placing a 256x256 tile image into the rotated image frame. */
  matrix: string;
}

/**
 * Tiles covering the image frame, each carrying the matrix that rotates and
 * scales it into place. Because the tiles are positioned by their true
 * Mercator coordinates rather than stretched to fill the rect, they line up
 * with the footprints by construction.
 */
export const buildBasemapTiles = (zoom: number, style = 'light_all'): BasemapTile[] => {
  const scale = Math.pow(2, zoom);
  const width = ORIGINAL_IMAGE_WIDTH * BACKGROUND_SCALE;
  const height = ORIGINAL_IMAGE_HEIGHT * BACKGROUND_SCALE;

  // Invert the affine to find which tiles the frame's corners land on.
  const a = MERC_TO_IMAGE[0][0] * BACKGROUND_SCALE;
  const b = MERC_TO_IMAGE[0][1] * BACKGROUND_SCALE;
  const c = MERC_TO_IMAGE[1][0] * BACKGROUND_SCALE;
  const d = MERC_TO_IMAGE[1][1] * BACKGROUND_SCALE;
  const det = a * d - b * c;

  const toTile = (px: number, py: number) => ({
    x: ((px * d - py * c) / det + MERCATOR_ORIGIN.x) * scale,
    y: ((py * a - px * b) / det + MERCATOR_ORIGIN.y) * scale,
  });

  const corners = [toTile(0, 0), toTile(width, 0), toTile(width, height), toTile(0, height)];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);

  // One tile of margin so the rotated frame's edges stay covered.
  const xStart = Math.floor(Math.min(...xs)) - 1;
  const xEnd = Math.floor(Math.max(...xs)) + 1;
  const yStart = Math.floor(Math.min(...ys)) - 1;
  const yEnd = Math.floor(Math.max(...ys)) + 1;

  // Per-tile basis vectors: one tile step in each axis, in image pixels.
  const ux = (MERC_TO_IMAGE[0][0] * BACKGROUND_SCALE) / scale / 256;
  const uy = (MERC_TO_IMAGE[0][1] * BACKGROUND_SCALE) / scale / 256;
  const vx = (MERC_TO_IMAGE[1][0] * BACKGROUND_SCALE) / scale / 256;
  const vy = (MERC_TO_IMAGE[1][1] * BACKGROUND_SCALE) / scale / 256;

  const tiles: BasemapTile[] = [];
  for (let x = xStart; x <= xEnd; x += 1) {
    for (let y = yStart; y <= yEnd; y += 1) {
      const dx = x / scale - MERCATOR_ORIGIN.x;
      const dy = y / scale - MERCATOR_ORIGIN.y;
      const ex = (dx * MERC_TO_IMAGE[0][0] + dy * MERC_TO_IMAGE[1][0]) * BACKGROUND_SCALE;
      const ey = (dx * MERC_TO_IMAGE[0][1] + dy * MERC_TO_IMAGE[1][1]) * BACKGROUND_SCALE;
      const subdomain = ['a', 'b', 'c', 'd'][Math.abs(x + y) % 4];

      tiles.push({
        key: `${zoom}/${x}/${y}`,
        url: `https://${subdomain}.basemaps.cartocdn.com/${style}/${zoom}/${x}/${y}.png`,
        matrix: `matrix(${ux},${uy},${vx},${vy},${ex},${ey})`,
      });
    }
  }

  return tiles;
};

/** GeoJSON ring (array of [lon, lat]) to an SVG path fragment. */
export const ringToPath = (ring: number[][]): string => {
  let path = '';
  for (let i = 0; i < ring.length; i += 1) {
    const p = lonLatToImage(ring[i][0], ring[i][1]);
    path += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }
  return `${path}Z`;
};

/** Whole GeoJSON Polygon/MultiPolygon to one SVG path (holes included). */
export const geometryToPath = (geometry: {
  type: string;
  coordinates: number[][][] | number[][][][];
}): string => {
  if (geometry.type === 'Polygon') {
    return (geometry.coordinates as number[][][]).map(ringToPath).join(' ');
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as number[][][][])
      .map((poly) => poly.map(ringToPath).join(' '))
      .join(' ');
  }
  return '';
};
