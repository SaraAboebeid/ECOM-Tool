import { useEffect, useMemo, useState } from 'react';
import { geometryToPath, lonLatToImage } from '../utils/geoProjection';
import { COMPASS_ORIENTATION, getImageCenter, rotatePoint } from '../utils/backgroundConfig';
import { canonicalName } from '../utils/canonicalName';

/**
 * Footprints exported from the Rhino campus model by
 * backend/scripts/export_footprints_geojson.py. Replaces the 3d_topview.png
 * overlay: vector rather than raster, so it stays sharp at any zoom, and each
 * building carries its id, area and height instead of being flat pixels.
 */
export interface FootprintFeature {
  id: string;
  kind: 'building' | 'context';
  rhinoLayer?: string;
  footprintM2?: number;
  heightM?: number;
  estimatedFloors?: number;
  path: string;
}

interface RawFeature {
  properties: {
    id: string;
    kind: 'building' | 'context';
    rhino_layer?: string;
    footprint_m2?: number;
    height_m?: number;
    estimated_floors?: number;
  };
  geometry: { type: string; coordinates: number[][][] | number[][][][] };
}

export const useBuildingFootprints = (url = '/buildings.geojson') => {
  const [raw, setRaw] = useState<RawFeature[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((data) => {
        if (!cancelled) setRaw(data.features ?? []);
      })
      .catch((err) => {
        // The map still works without footprints, so degrade rather than throw.
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Projecting thousands of vertices is not free; the source never changes at
  // runtime, so do it once.
  const features = useMemo<FootprintFeature[]>(() => {
    if (!raw) return [];
    return raw.map((feature) => ({
      id: feature.properties.id,
      kind: feature.properties.kind,
      rhinoLayer: feature.properties.rhino_layer,
      footprintM2: feature.properties.footprint_m2,
      heightM: feature.properties.height_m,
      estimatedFloors: feature.properties.estimated_floors,
      path: geometryToPath(feature.geometry),
    }));
  }, [raw]);

  const buildings = useMemo(
    () => features.filter((f) => f.kind === 'building'),
    [features]
  );
  const context = useMemo(
    () => features.filter((f) => f.kind === 'context'),
    [features]
  );

  /**
   * Area-weighted centroid per building, canonically keyed and converted into
   * the coordinate space the fixed node positions use.
   *
   * The footprint paths are drawn inside a group carrying the COMPASS_ORIENTATION
   * rotation, but node coordinates are pre-rotated instead, so the rotation has
   * to be applied here for the two to agree.
   */
  const centroids = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    if (!raw) return map;

    const centre = getImageCenter();
    for (const feature of raw) {
      if (feature.properties.kind !== 'building') continue;
      const geometry = feature.geometry;
      const rings: number[][][] =
        geometry.type === 'Polygon'
          ? (geometry.coordinates as number[][][])
          : (geometry.coordinates as number[][][][]).map((p) => p[0]);

      // Shoelace centroid over the outer rings, weighted by signed area, so a
      // long L-shaped building does not report a point outside itself the way a
      // plain vertex mean can.
      let area2 = 0;
      let cx = 0;
      let cy = 0;
      for (const ring of rings) {
        const projected = ring.map((c) => lonLatToImage(c[0], c[1]));
        for (let i = 0; i < projected.length - 1; i += 1) {
          const a = projected[i];
          const b = projected[i + 1];
          const cross = a.x * b.y - b.x * a.y;
          area2 += cross;
          cx += (a.x + b.x) * cross;
          cy += (a.y + b.y) * cross;
        }
      }

      let point: { x: number; y: number };
      if (Math.abs(area2) < 1e-9) {
        // Degenerate ring: fall back to the vertex mean.
        const all = rings.flat().map((c) => lonLatToImage(c[0], c[1]));
        if (!all.length) continue;
        point = {
          x: all.reduce((s, p) => s + p.x, 0) / all.length,
          y: all.reduce((s, p) => s + p.y, 0) / all.length
        };
      } else {
        point = { x: cx / (3 * area2), y: cy / (3 * area2) };
      }

      const rotated = rotatePoint(
        point.x,
        point.y,
        COMPASS_ORIENTATION,
        centre.x,
        centre.y
      );

      const id = feature.properties.rhino_layer ?? feature.properties.id;
      const key = canonicalName(id);
      if (!map.has(key)) map.set(key, rotated);
    }
    return map;
  }, [raw]);

  return { features, buildings, context, centroids, error, loaded: raw !== null };
};

export default useBuildingFootprints;
