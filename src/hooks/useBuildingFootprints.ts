import { useEffect, useMemo, useState } from 'react';
import { geometryToPath } from '../utils/geoProjection';

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

  return { features, buildings, context, error, loaded: raw !== null };
};

export default useBuildingFootprints;
