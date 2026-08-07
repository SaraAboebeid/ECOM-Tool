import { Node } from '../types';
import { BACKGROUND_SCALE, COMPASS_ORIENTATION, rotatePoint, getImageCenter } from './backgroundConfig';
import { canonicalName } from './canonicalName';
import { lonLatToImage } from './geoProjection';

/**
 * Original fixed positions for specific nodes in the graph
 * These coordinates align with the original background image coordinate system
 */
const ORIGINAL_NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  'SB1': { x: 184.397, y: 717.074 },
  'Edit': { x: 319.370, y: 759.348 },
  'HA': { x: 374.170, y: 593.310 },
  'HB': { x: 378.120, y: 675.705 },
  'HC': { x: 381.956, y: 762.279 },
  'Idelara': { x: 1101.542, y: 64.525 },
  'Vasa 1': { x: 266.653, y: 115.389 },
  'Vasa 2-3': { x: 322.973, y: 109.4473 },
  'Vasa 12': { x: 379.136, y: 157.676 },
  'Vasa 8': { x: 311.158, y: 205.436 },
  'Vasa 10': { x: 391.937, y: 199.993 },
  'Vasa 5': { x: 284.958, y: 244.593 },
  'Vasa 9': { x: 339.721, y: 237.915 },
  'CSB Chabo': { x: 346.427, y: 301.608 },
  'MC2': { x: 234.252, y: 347.819 },
  'Kemi': { x: 352.798, y: 405.317 },
  'Emils kårhus': { x: 405.376, y: 407.888 },
  'Nya Matte': { x: 302.303, y: 499.262 },
  'Bibliotek': { x: 402.648, y: 484.516 },
  'Kårhus entré': { x: 114.806, y: 562.152 },
  'Maskinteknik': { x: 319.243, y: 651.008 },
  'Lokalkontor': { x: 287.304, y: 586.620 },
  'Fysik origo': { x: 227.567, y: 431.054 },
  'Kårhus': { x: 120.991, y: 601.520 },
  'SB2': { x: 185.481, y: 768.882 },
  'SB3': { x: 191.425, y: 888.985 },
  'AWL': { x: 195.544, y: 962.640 },
  'JSP': { x: 188.056, y: 1016.338 },
  'Teknikparken': { x: 130.388, y: 1081.455 },
  'Elkraftteknik': { x: 341.186, y: 819.325 },
  'Vasa 13': { x: 235.464, y: 172.473 },
  'Gamla matte': { x: 415.010, y: 1086.740 },
  'Idélära': { x: 283.060, y: 822.095 },
  'IT': { x: 140.424, y: 1157.231 },
  'CA-Huset': { x: 136.279, y: 463.660 },
  'Reaktorfysik': { x: 244.771, y: 411.121 },
  'CSB Gibraltarvallen guesthouse': { x: 427.087, y: 559.410 },
  'Vasa 4': { x: 247.271, y: 258.770 },
  'Vasa 7': { x: 245.196, y: 236.308 },
  'Vasa 15': { x: 381.065, y: 334.557 },
  'PV-Plant': { x: 195.531, y: 1079.886 },
  'GRID': { x: 197.562, y: 495.081 }, // Placeholder for grid node
};

/**
 * Scaled fixed positions for specific nodes in the graph
 * These coordinates are automatically scaled and rotated based on BACKGROUND_SCALE and COMPASS_ORIENTATION
 */
export const FIXED_NODE_POSITIONS: Record<string, { x: number; y: number }> = 
  Object.fromEntries(
    Object.entries(ORIGINAL_NODE_POSITIONS).map(([nodeId, position]) => {
      // First scale the position
      const scaledPosition = {
        x: position.x * BACKGROUND_SCALE,
        y: position.y * BACKGROUND_SCALE
      };
      
      // Then rotate if needed
      if (COMPASS_ORIENTATION % 360 !== 0) {
        const center = getImageCenter();
        const rotatedPosition = rotatePoint(
          scaledPosition.x,
          scaledPosition.y,
          COMPASS_ORIENTATION,
          center.x,
          center.y
        );
        return [nodeId, rotatedPosition];
      }
      
      return [nodeId, scaledPosition];
    })
  );

/**
 * Footprint centroids from the Rhino model, in longitude/latitude.
 *
 * Imported rather than fetched. The GeoJSON arrives after first paint, and by
 * then the graph has bound its D3 selection to node objects that have no
 * position; replacing those objects later updates the simulation but not what
 * is drawn, so buildings placed this way stayed in the force layout. A static
 * import means every node has its position on the very first bind.
 *
 * Regenerate with backend/scripts/export_footprints_geojson.py.
 */
import BUILDING_CENTROIDS from '../data/buildingCentroids.json';

/**
 * Fixed positions keyed canonically, so a node id only has to match a table
 * entry up to case and accents.
 *
 * The hand-placed table wins; centroids only fill the gaps, so tuned positions
 * are never overridden by a computed one.
 */
const CANONICAL_FIXED_POSITIONS: Map<string, { x: number; y: number }> = (() => {
  const map = new Map<string, { x: number; y: number }>();

  const centre = getImageCenter();
  for (const [name, lonLat] of Object.entries(
    BUILDING_CENTROIDS as Record<string, [number, number]>
  )) {
    const point = lonLatToImage(lonLat[0], lonLat[1]);
    // Node coordinates are pre-rotated; the footprints are drawn inside a group
    // that carries the rotation instead, so it has to be applied here.
    map.set(
      canonicalName(name),
      COMPASS_ORIENTATION % 360 === 0
        ? point
        : rotatePoint(point.x, point.y, COMPASS_ORIENTATION, centre.x, centre.y)
    );
  }

  for (const [id, position] of Object.entries(FIXED_NODE_POSITIONS)) {
    map.set(canonicalName(id), position);
  }

  return map;
})();

/**
 * Apply fixed positions to nodes that have predefined locations.
 *
 * @param nodes Array of nodes to process
 * @param footprintCentroids Optional fallback positions, canonically keyed and
 *   already in node coordinate space. Used only where the hand-placed table has
 *   no entry, so tuned positions are never overridden. Without this, a building
 *   with energy data but no table entry falls through to the force layout,
 *   which is seeded in viewport pixels rather than image-frame coordinates and
 *   so parks its icon roughly a thousand pixels away from the campus.
 * @returns Modified nodes with fixed positions applied
 */
export const applyFixedPositions = (
  nodes: Node[],
  footprintCentroids?: Map<string, { x: number; y: number }>
): Node[] => {
  return nodes.map(node => {
    const key = canonicalName(node.id);
    const position =
      CANONICAL_FIXED_POSITIONS.get(key) ?? footprintCentroids?.get(key);
    if (position) {
      return { ...node, fx: position.x, fy: position.y };
    }
    return node;
  });
};

/**
 * Check if a node has a fixed position
 * @param nodeId ID of the node
 * @returns True if the node has a fixed position
 */
export const hasFixedPosition = (nodeId: string): boolean => {
  return nodeId in FIXED_NODE_POSITIONS;
};

/**
 * Get the fixed position for a node if it exists
 * @param nodeId ID of the node
 * @returns Fixed position or null if not found
 */
export const getFixedPosition = (nodeId: string): { x: number; y: number } | null => {
  return FIXED_NODE_POSITIONS[nodeId] || null;
};
