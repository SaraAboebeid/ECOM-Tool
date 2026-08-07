/**
 * Roof areas measured from the Rhino campus model.
 *
 * These make the PV controls honest: coverage is a percentage of a real
 * footprint rather than a slider with an invented maximum, so a building
 * cannot be given more panels than it has roof.
 *
 * Regenerate with backend/scripts/export_footprints_geojson.py.
 */
import FOOTPRINTS from '../data/buildingFootprints.json';
import { canonicalName } from './canonicalName';

interface FootprintRecord {
  centroid: [number, number];
  roof_m2: number;
  height_m: number | null;
}

const BY_NAME: Map<string, FootprintRecord> = new Map(
  Object.entries(FOOTPRINTS as Record<string, FootprintRecord>).map(
    ([name, record]) => [canonicalName(name), record]
  )
);

/**
 * The share of a footprint that can carry panels.
 *
 * A roof is not all mountable - plant, walkways, shading and setbacks take a
 * share - and this is also the ceiling the UI enforces, so it is deliberately
 * conservative rather than optimistic.
 */
export const MAX_ROOF_COVERAGE_PERCENT = 80;

/** Default module: 400 W over 1.0 x 2.0 m, i.e. 0.2 kWp/m2. Mirrors PVModuleSpec. */
const MODULE_AREA_M2 = 2.0;
const MODULE_RATING_W = 400;

/** Measured roof area in m2, or null when the building has no Rhino footprint. */
export const roofAreaOf = (buildingName: string): number | null =>
  BY_NAME.get(canonicalName(buildingName))?.roof_m2 ?? null;

export const hasFootprint = (buildingName: string): boolean =>
  BY_NAME.has(canonicalName(buildingName));

/**
 * kWp that fits on a given area at a given coverage.
 *
 * Floor division on whole panels, matching PVPlantSpec.module_count, so the
 * number shown here is the number the backend will compute.
 */
export const capacityForCoverage = (
  roofM2: number,
  coveragePercent: number
): number => {
  const usable = roofM2 * (coveragePercent / 100);
  const modules = Math.floor(usable / MODULE_AREA_M2);
  return (modules * MODULE_RATING_W) / 1000;
};

/** The inverse: what coverage does an existing plant already represent? */
export const coverageForCapacity = (
  roofM2: number,
  capacityKwp: number
): number => {
  if (roofM2 <= 0) return 0;
  const modules = (capacityKwp * 1000) / MODULE_RATING_W;
  return Math.min(
    MAX_ROOF_COVERAGE_PERCENT,
    (modules * MODULE_AREA_M2 * 100) / roofM2
  );
};
